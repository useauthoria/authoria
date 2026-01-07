import type { SupabaseClient } from '@supabase/supabase-js';
import { retry } from '../utils/error-handling.ts';

export interface PersonalDataPattern {
  readonly type: 'email' | 'phone' | 'name' | 'address' | 'ip_address' | 'credit_card';
  readonly pattern: RegExp;
  readonly replacement: string;
}

export interface SanitizationResult {
  readonly sanitizedContent: string;
  readonly removedData: ReadonlyArray<{ readonly type: string; readonly count: number }>;
}

interface DataRemovalRecord {
  readonly store_id: string;
  readonly post_id: string | null;
  readonly data_type: string;
  readonly original_value_hash: string;
  readonly removal_method: string;
  readonly replaced_with: string;
  readonly ai_model_used: string;
}

type LogLevel = 'info' | 'warn' | 'error';

const structuredLog = (
  level: LogLevel,
  service: string,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): void => {
  const payload = JSON.stringify({
    level,
    service,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  });

  if (typeof globalThis === 'undefined' || !('Deno' in globalThis)) {
    return;
  }

  const encoder = new TextEncoder();
  const deno = globalThis as unknown as { Deno: { stderr: { writeSync: (data: Uint8Array) => void }; stdout: { writeSync: (data: Uint8Array) => void } } };
  
  if (level === 'error') {
    deno.Deno.stderr.writeSync(encoder.encode(payload + '\n'));
    return;
  }

  deno.Deno.stdout.writeSync(encoder.encode(payload + '\n'));
};

const validateStoreId = (storeId: string): void => {
  if (!storeId || typeof storeId !== 'string' || storeId.trim().length === 0) {
    throw new Error('Invalid storeId: must be a non-empty string');
  }
};

const validateContent = (content: string): void => {
  if (typeof content !== 'string') {
    throw new Error('Invalid content: must be a string');
  }
  if (content.length > 10_000_000) {
    throw new Error('Invalid content: exceeds maximum length of 10MB');
  }
};

const validateOperationType = (operationType: string): void => {
  if (!operationType || typeof operationType !== 'string' || operationType.trim().length === 0) {
    throw new Error('Invalid operationType: must be a non-empty string');
  }
  if (operationType.length > 100) {
    throw new Error('Invalid operationType: exceeds maximum length of 100 characters');
  }
};

export class GDPRDataGuard {
  private readonly supabase: SupabaseClient;
  private readonly personalDataPatterns: ReadonlyArray<PersonalDataPattern>;
  
  private static readonly RETENTION_YEARS = 7;
  private static readonly SHA256_ALGORITHM = 'SHA-256';
  private static readonly MAX_BATCH_SIZE = 100;
  private static readonly SERVICE_NAME = 'GDPRDataGuard';
  private static readonly DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffMultiplier: 2,
    retryableErrors: ['rate limit', 'timeout', 'server_error'] as const,
  } as const;

  constructor(supabase: SupabaseClient) {
    if (!supabase) {
      throw new Error('SupabaseClient is required');
    }
    this.supabase = supabase;
    this.personalDataPatterns = this.initializePatterns();
  }

  async sanitizeContent(
    content: string,
    storeId: string,
    postId?: string,
    operationType: string = 'content_generation',
  ): Promise<SanitizationResult> {
    validateContent(content);
    validateStoreId(storeId);
    validateOperationType(operationType);

    const startTime = Date.now();
    let sanitized = content;
    const removedData: Array<{ type: string; count: number }> = [];
    const allRemovals: Array<{
      readonly storeId: string;
      readonly postId: string | undefined;
      readonly dataType: string;
      readonly originalValue: string;
      readonly replacement: string;
      readonly operationType: string;
    }> = [];

    for (const pattern of this.personalDataPatterns) {
      const matches = sanitized.match(pattern.pattern);
      if (matches && matches.length > 0) {
        const count = matches.length;
        sanitized = sanitized.replace(pattern.pattern, pattern.replacement);

        for (const match of matches) {
          allRemovals.push({
            storeId,
            postId,
            dataType: pattern.type,
            originalValue: match,
            replacement: pattern.replacement,
            operationType,
          });
        }

        removedData.push({ type: pattern.type, count });
      }
    }

    const hasRemovals = allRemovals.length > 0;

    await Promise.all([
      this.batchRecordDataRemovals(allRemovals),
      this.recordProcessing(
        storeId,
        postId,
        operationType,
        'content',
        'sanitized',
        hasRemovals,
      ),
    ]);

    const duration = Date.now() - startTime;
    structuredLog('info', GDPRDataGuard.SERVICE_NAME, 'Content sanitized', {
      storeId,
      postId,
      operationType,
      removedDataCount: removedData.length,
      totalRemovals: allRemovals.length,
      durationMs: duration,
    });

    return {
      sanitizedContent: sanitized,
      removedData,
    };
  }

  private async batchRecordDataRemovals(
    removals: ReadonlyArray<{
      readonly storeId: string;
      readonly postId: string | undefined;
      readonly dataType: string;
      readonly originalValue: string;
      readonly replacement: string;
      readonly operationType: string;
    }>,
  ): Promise<void> {
    if (removals.length === 0) return;

    const hashPromises = removals.map((r) => this.hashValue(r.originalValue));
    const hashes = await Promise.all(hashPromises);

    const records: DataRemovalRecord[] = removals.map((removal, index) => ({
      store_id: removal.storeId,
      post_id: removal.postId || null,
      data_type: removal.dataType,
      original_value_hash: hashes[index],
      removal_method: 'replacement',
      replaced_with: removal.replacement,
      ai_model_used: removal.operationType,
    }));

    for (let i = 0; i < records.length; i += GDPRDataGuard.MAX_BATCH_SIZE) {
      const batch = records.slice(i, i + GDPRDataGuard.MAX_BATCH_SIZE);
      
      await retry(
        async () => {
          const { error } = await this.supabase
            .from('personal_data_removals')
            .insert(batch);

          if (error) {
            throw new Error(`Failed to record data removals: ${error.message}`);
          }
        },
        {
          ...GDPRDataGuard.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, error) => {
            structuredLog('warn', GDPRDataGuard.SERVICE_NAME, 'Retrying data removal batch insert', {
              attempt,
              batchSize: batch.length,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        },
      );
    }
  }

  private async recordProcessing(
    storeId: string,
    postId: string | undefined,
    operationType: string,
    dataType: string,
    processingStage: string,
    personalDataRemoved: boolean,
  ): Promise<void> {
    const retentionUntil = this.calculateRetentionDate();
    const hashValue = await this.hashValue(`${storeId}-${postId || ''}-${Date.now()}`);

    await retry(
      async () => {
        const { error } = await this.supabase.from('data_processing_audit').insert({
          store_id: storeId,
          post_id: postId || null,
          operation_type: operationType,
          data_type: dataType,
          processing_stage: processingStage,
          encrypted_data_hash: hashValue,
          personal_data_removed: personalDataRemoved,
          gdpr_compliant: true,
          retention_until: retentionUntil.toISOString(),
        });

        if (error) {
          throw new Error(`Failed to record processing audit: ${error.message}`);
        }
      },
      {
        ...GDPRDataGuard.DEFAULT_RETRY_OPTIONS,
        onRetry: (attempt, error) => {
          structuredLog('warn', GDPRDataGuard.SERVICE_NAME, 'Retrying processing audit insert', {
            attempt,
            storeId,
            postId,
            operationType,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      },
    );
  }

  private initializePatterns(): ReadonlyArray<PersonalDataPattern> {
    return [
      {
        type: 'email',
        pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
        replacement: '[EMAIL_REDACTED]',
      },
      {
        type: 'phone',
        pattern: /\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g,
        replacement: '[PHONE_REDACTED]',
      },
      {
        type: 'credit_card',
        pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
        replacement: '[CARD_REDACTED]',
      },
      {
        type: 'ip_address',
        pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
        replacement: '[IP_REDACTED]',
      },
    ];
  }

  private async hashValue(value: string): Promise<string> {
    if (!value || typeof value !== 'string') {
      throw new Error('Invalid value for hashing: must be a non-empty string');
    }

    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(value);
      const hashBuffer = await crypto.subtle.digest(GDPRDataGuard.SHA256_ALGORITHM, data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (error) {
      structuredLog('error', GDPRDataGuard.SERVICE_NAME, 'Hash operation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to hash value: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private calculateRetentionDate(): Date {
    const date = new Date();
    date.setFullYear(date.getFullYear() + GDPRDataGuard.RETENTION_YEARS);
    return date;
  }
}
