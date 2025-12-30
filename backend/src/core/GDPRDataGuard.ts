import type { SupabaseClient } from '@supabase/supabase-js';

export interface PersonalDataPattern {
  readonly type: 'email' | 'phone' | 'name' | 'address' | 'ip_address' | 'credit_card';
  readonly pattern: RegExp;
  readonly replacement: string;
}

interface SanitizationResult {
  readonly sanitizedContent: string;
  readonly removedData: ReadonlyArray<{ readonly type: string; readonly count: number }>;
}

export class GDPRDataGuard {
  private readonly supabase: SupabaseClient;
  private readonly personalDataPatterns: ReadonlyArray<PersonalDataPattern>;
  private static readonly RETENTION_YEARS = 7;
  private static readonly SHA256_ALGORITHM = 'SHA-256';

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
    this.personalDataPatterns = this.initializePatterns();
  }

  async sanitizeContent(
    content: string,
    storeId: string,
    postId?: string,
    operationType: string = 'content_generation',
  ): Promise<SanitizationResult> {
    let sanitized = content;
    const removedData: Array<{ type: string; count: number }> = [];

    for (const pattern of this.personalDataPatterns) {
      const matches = sanitized.match(pattern.pattern);
      if (matches) {
        const count = matches.length;
        sanitized = sanitized.replace(pattern.pattern, pattern.replacement);

        await this.recordDataRemovals(
          storeId,
          postId,
          pattern.type,
          matches,
          pattern.replacement,
          operationType,
        );

        removedData.push({ type: pattern.type, count });
      }
    }

    await this.recordProcessing(
      storeId,
      postId,
      operationType,
      'content',
      'sanitized',
      removedData.length > 0,
    );

    return {
      sanitizedContent: sanitized,
      removedData,
    };
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

    await this.supabase.from('data_processing_audit').insert({
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

  private async recordDataRemovals(
    storeId: string,
    postId: string | undefined,
    dataType: string,
    matches: RegExpMatchArray,
    replacement: string,
    operationType: string,
  ): Promise<void> {
    await Promise.all(
      matches.map((match) =>
        this.recordDataRemoval(storeId, postId, dataType, match, replacement, operationType),
      ),
    );
  }

  private async recordDataRemoval(
    storeId: string,
    postId: string | undefined,
    dataType: string,
    originalValue: string,
    replacement: string,
    aiModelUsed: string = 'unknown',
  ): Promise<void> {
    const originalHash = await this.hashValue(originalValue);

    await this.supabase.from('personal_data_removals').insert({
      store_id: storeId,
      post_id: postId || null,
      data_type: dataType,
      original_value_hash: originalHash,
      removal_method: 'replacement',
      replaced_with: replacement,
      ai_model_used: aiModelUsed,
    });
  }

  private async hashValue(value: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const hashBuffer = await crypto.subtle.digest(GDPRDataGuard.SHA256_ALGORITHM, data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  private calculateRetentionDate(): Date {
    const date = new Date();
    date.setFullYear(date.getFullYear() + GDPRDataGuard.RETENTION_YEARS);
    return date;
  }

}
