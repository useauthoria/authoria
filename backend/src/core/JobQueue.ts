import type { SupabaseClient } from '@supabase/supabase-js';
import { retry } from '../utils/error-handling.ts';

export type JobType = 'llm_snippet' | 'image_optimization' | 'analytics_update' | 'analytics_sync' | 'cache_warmup' | 'article_generation' | 'product_sync' | 'collection_sync' | 'cleanup' | 'scheduled_publish' | 'cost_aggregation' | 'quota_reset';
export type JobPriority = 'low' | 'normal' | 'high' | 'critical';
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type BatchStatus = 'pending' | 'processing' | 'completed' | 'partial' | 'failed';

export interface Job {
  readonly id: string;
  readonly type: JobType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly priority: JobPriority;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly created_at: string;
  readonly started_at?: string;
  readonly completed_at?: string;
  readonly error?: string;
  readonly result?: unknown;
  readonly depends_on?: readonly string[];
  readonly batch_id?: string;
  readonly progress?: number;
  readonly result_cached?: boolean;
}

export interface JobOptions {
  readonly priority?: JobPriority;
  readonly maxAttempts?: number;
  readonly delay?: number;
  readonly retryDelay?: number;
  readonly dependsOn?: readonly string[];
  readonly batchId?: string;
  readonly deduplicationKey?: string;
  readonly dedupWindowMinutes?: number;
  readonly cacheKey?: string;
  readonly cacheTTL?: number;
  readonly skipIfDuplicate?: boolean;
}

interface DatabaseJobCacheRow {
  readonly result: unknown;
  readonly hit_count?: number | null;
  readonly id?: string;
}

interface DatabaseJobCacheKeyRow {
  readonly cache_key: string;
  readonly job_type: JobType;
  readonly payload_hash: string;
  readonly result: unknown;
  readonly expires_at: string;
  readonly hit_count?: number | null;
  readonly last_accessed_at?: string | null;
  readonly id?: string;
}

interface JobInsertData {
  readonly type: JobType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly priority: JobPriority;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly scheduled_at?: string | null;
  readonly retry_delay: number;
  readonly job_hash: string;
  readonly depends_on?: readonly string[];
  readonly batch_id?: string;
  readonly cache_key?: string;
  readonly cache_ttl?: number;
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

const validateJobType = (type: string): type is JobType => {
  const validTypes: readonly JobType[] = [
    'llm_snippet',
    'image_optimization',
    'analytics_update',
    'analytics_sync',
    'cache_warmup',
    'article_generation',
    'product_sync',
    'collection_sync',
    'cleanup',
    'scheduled_publish',
    'cost_aggregation',
    'quota_reset',
  ];
  return validTypes.includes(type as JobType);
};

const validatePriority = (priority: string): priority is JobPriority => {
  return priority === 'low' || priority === 'normal' || priority === 'high' || priority === 'critical';
};

const validatePayload = (payload: unknown): payload is Readonly<Record<string, unknown>> => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  try {
    JSON.stringify(payload);
    return true;
  } catch {
    return false;
  }
};

const validateMaxAttempts = (maxAttempts: number): void => {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error('Invalid maxAttempts: must be an integer between 1 and 100');
  }
};

const validateDelay = (delay: number): void => {
  if (!Number.isInteger(delay) || delay < 0 || delay > 86400) {
    throw new Error('Invalid delay: must be an integer between 0 and 86400 seconds');
  }
};

const validateRetryDelay = (retryDelay: number): void => {
  if (!Number.isInteger(retryDelay) || retryDelay < 0 || retryDelay > 3600) {
    throw new Error('Invalid retryDelay: must be an integer between 0 and 3600 seconds');
  }
};

const validateDedupWindow = (window: number): void => {
  if (!Number.isInteger(window) || window < 1 || window > 10080) {
    throw new Error('Invalid dedupWindowMinutes: must be an integer between 1 and 10080 minutes');
  }
};

const validateCacheTTL = (ttl: number): void => {
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400) {
    throw new Error('Invalid cacheTTL: must be an integer between 1 and 86400 seconds');
  }
};

const hashString = (str: string): string => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
};

export class JobQueue {
  private static readonly DEFAULT_PRIORITY: JobPriority = 'normal';
  private static readonly DEFAULT_MAX_ATTEMPTS = 3;
  private static readonly DEFAULT_DELAY = 0;
  private static readonly DEFAULT_RETRY_DELAY = 60;
  private static readonly DEFAULT_DEDUP_WINDOW = 60;
  private static readonly DEFAULT_CACHE_TTL = 3600;
  private static readonly MILLISECONDS_PER_SECOND = 1000;
  private static readonly SERVICE_NAME = 'JobQueue';
  private static readonly DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffMultiplier: 2,
    retryableErrors: ['rate limit', 'timeout', 'server_error'] as const,
  } as const;

  private readonly supabase: SupabaseClient;
  private readonly workerId: string;

  constructor(supabase: SupabaseClient, workerId?: string) {
    if (!supabase) {
      throw new Error('SupabaseClient is required');
    }
    this.supabase = supabase;
    this.workerId = workerId ?? this.generateWorkerId();
  }

  async enqueue(
    type: JobType,
    payload: Readonly<Record<string, unknown>>,
    options: JobOptions = {},
  ): Promise<string | null> {
    const startTime = Date.now();

    if (!validateJobType(type)) {
      throw new Error(`Invalid job type: ${type}`);
    }

    if (!validatePayload(payload)) {
      throw new Error('Invalid payload: must be a serializable object');
    }

    const {
      priority = JobQueue.DEFAULT_PRIORITY,
      maxAttempts = JobQueue.DEFAULT_MAX_ATTEMPTS,
      delay = JobQueue.DEFAULT_DELAY,
      retryDelay = JobQueue.DEFAULT_RETRY_DELAY,
      dependsOn,
      batchId,
      deduplicationKey,
      dedupWindowMinutes = JobQueue.DEFAULT_DEDUP_WINDOW,
      cacheKey,
      cacheTTL,
      skipIfDuplicate = false,
    } = options;

    if (!validatePriority(priority)) {
      throw new Error(`Invalid priority: ${priority}`);
    }

    validateMaxAttempts(maxAttempts);
    validateDelay(delay);
    validateRetryDelay(retryDelay);
    validateDedupWindow(dedupWindowMinutes);

    if (cacheTTL !== undefined) {
      validateCacheTTL(cacheTTL);
    }

    if (dependsOn && (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== 'string' || id.trim().length === 0))) {
      throw new Error('Invalid dependsOn: must be an array of non-empty strings');
    }

    if (batchId && (typeof batchId !== 'string' || batchId.trim().length === 0)) {
      throw new Error('Invalid batchId: must be a non-empty string');
    }

    const jobHash = deduplicationKey ?? this.generateJobHash(type, payload);

    if (deduplicationKey || skipIfDuplicate) {
      const existingHash = await this.checkJobHashExists(jobHash, dedupWindowMinutes);
      if (existingHash) {
        if (skipIfDuplicate) {
          structuredLog('info', JobQueue.SERVICE_NAME, 'Skipping duplicate job', {
            type,
            jobHash,
            existingHash,
            durationMs: Date.now() - startTime,
          });
          return existingHash;
        }
        const cachedResult = await this.getCachedResult(cacheKey ?? jobHash, type, payload);
        if (cachedResult) {
          const result = await this.enqueueCachedJob(type, payload, cachedResult, options);
          structuredLog('info', JobQueue.SERVICE_NAME, 'Enqueued cached job', {
            type,
            jobId: result,
            durationMs: Date.now() - startTime,
          });
          return result;
        }
        structuredLog('info', JobQueue.SERVICE_NAME, 'Found existing job hash', {
          type,
          jobHash,
          existingHash,
          durationMs: Date.now() - startTime,
        });
        return existingHash;
      }
    }

    if (cacheKey) {
      const cachedResult = await this.getCachedResult(cacheKey, type, payload);
      if (cachedResult) {
        const result = await this.enqueueCachedJob(type, payload, cachedResult, options);
        structuredLog('info', JobQueue.SERVICE_NAME, 'Enqueued cached job', {
          type,
          jobId: result,
          durationMs: Date.now() - startTime,
        });
        return result;
      }
    }

    const scheduledAt = this.calculateScheduledAt(delay);
    const insertData = this.buildInsertData(
      type,
      payload,
      priority,
      maxAttempts,
      scheduledAt,
      retryDelay,
      jobHash,
      dependsOn,
      batchId,
      cacheKey,
      cacheTTL,
    );

    const promises: Promise<unknown>[] = [this.insertJob(insertData)];

    if (batchId) {
      promises.push(this.incrementBatchTotal(batchId));
    }

    const [jobId] = await Promise.all(promises);

    structuredLog('info', JobQueue.SERVICE_NAME, 'Job enqueued', {
      type,
      jobId,
      priority,
      batchId,
      durationMs: Date.now() - startTime,
    });

    return jobId as string;
  }

  private async checkJobHashExists(jobHash: string, dedupWindowMinutes: number): Promise<string | null> {
    try {
      const { data, error } = await retry(
        async () => {
          return await this.supabase.rpc('job_hash_exists', {
            job_hash_param: jobHash,
            dedup_window_minutes: dedupWindowMinutes,
          });
        },
        {
          ...JobQueue.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', JobQueue.SERVICE_NAME, 'Retrying job hash check', {
              attempt,
              jobHash,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error) {
        structuredLog('error', JobQueue.SERVICE_NAME, 'Failed to check job hash', {
          jobHash,
          error: error.message,
        });
        return null;
      }

      return data || null;
    } catch (error) {
      structuredLog('error', JobQueue.SERVICE_NAME, 'Job hash check failed', {
        jobHash,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async enqueueCachedJob(
    type: JobType,
    payload: Readonly<Record<string, unknown>>,
    cachedResult: unknown,
    options: JobOptions,
  ): Promise<string> {
    try {
      const { data, error } = await retry(
        async () => {
          return await this.supabase
            .from('job_queue')
            .insert({
              type,
              payload,
              priority: options.priority ?? JobQueue.DEFAULT_PRIORITY,
              status: 'completed',
              result: cachedResult,
              result_cached: true,
              completed_at: new Date().toISOString(),
              cache_key: options.cacheKey,
            })
            .select('id')
            .single();
        },
        {
          ...JobQueue.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', JobQueue.SERVICE_NAME, 'Retrying cached job enqueue', {
              attempt,
              type,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error) {
        throw new Error(`Failed to enqueue cached job: ${error.message}`);
      }

      return data.id;
    } catch (error) {
      structuredLog('error', JobQueue.SERVICE_NAME, 'Failed to enqueue cached job', {
        type,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async getCachedResult(
    cacheKey: string,
    jobType: JobType,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<unknown | null> {
    const cachedByKey = await this.getCachedResultByKey(cacheKey);
    if (cachedByKey) {
      return cachedByKey;
    }

    const payloadHash = this.hashPayload(payload);
    return await this.getCachedResultByHash(jobType, payloadHash);
  }

  private async getCachedResultByKey(cacheKey: string): Promise<unknown | null> {
    try {
      const { data: cached, error } = await this.supabase
        .from('job_result_cache')
        .select('result, id')
        .eq('cache_key', cacheKey)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (error || !cached) {
        return null;
      }

      const cacheEntry = cached as DatabaseJobCacheKeyRow;
      if (cacheEntry.id) {
        this.incrementCacheHitCountById(cacheEntry.id).catch((err) => {
          structuredLog('warn', JobQueue.SERVICE_NAME, 'Failed to increment cache hit count', {
            cacheKey,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      return cacheEntry.result;
    } catch (error) {
      structuredLog('warn', JobQueue.SERVICE_NAME, 'Failed to get cached result by key', {
        cacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async getCachedResultByHash(jobType: JobType, payloadHash: string): Promise<unknown | null> {
    try {
      const { data: cachedByHash, error } = await this.supabase
        .from('job_result_cache')
        .select('result, id')
        .eq('job_type', jobType)
        .eq('payload_hash', payloadHash)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error || !cachedByHash) {
        return null;
      }

      const cacheEntry = cachedByHash as DatabaseJobCacheKeyRow;
      if (cacheEntry.id) {
        this.incrementCacheHitCountById(cacheEntry.id).catch((err) => {
          structuredLog('warn', JobQueue.SERVICE_NAME, 'Failed to increment cache hit count', {
            jobType,
            payloadHash,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      return cacheEntry.result;
    } catch (error) {
      structuredLog('warn', JobQueue.SERVICE_NAME, 'Failed to get cached result by hash', {
        jobType,
        payloadHash,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async incrementCacheHitCountById(cacheId: string): Promise<void> {
    try {
      const { data: cacheEntry, error: fetchError } = await this.supabase
        .from('job_result_cache')
        .select('hit_count')
        .eq('id', cacheId)
        .single();

      if (fetchError || !cacheEntry) {
        return;
      }

      const { error: updateError } = await this.supabase
        .from('job_result_cache')
        .update({
          hit_count: ((cacheEntry as DatabaseJobCacheRow).hit_count ?? 0) + 1,
          last_accessed_at: new Date().toISOString(),
        })
        .eq('id', cacheId);

      if (updateError) {
        structuredLog('warn', JobQueue.SERVICE_NAME, 'Failed to update cache hit count', {
          cacheId,
          error: updateError.message,
        });
      }
    } catch (error) {
      structuredLog('warn', JobQueue.SERVICE_NAME, 'Cache hit count increment failed', {
        cacheId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private generateJobHash(type: JobType, payload: Readonly<Record<string, unknown>>): string {
    const payloadStr = JSON.stringify(payload, Object.keys(payload).sort());
    return hashString(`${type}:${payloadStr}`);
  }

  private hashPayload(payload: Readonly<Record<string, unknown>>): string {
    const payloadStr = JSON.stringify(payload, Object.keys(payload).sort());
    return hashString(payloadStr);
  }

  private generateWorkerId(): string {
    return `worker-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  private calculateScheduledAt(delay: number): string | null {
    return delay > 0
      ? new Date(Date.now() + delay * JobQueue.MILLISECONDS_PER_SECOND).toISOString()
      : null;
  }

  private buildInsertData(
    type: JobType,
    payload: Readonly<Record<string, unknown>>,
    priority: JobPriority,
    maxAttempts: number,
    scheduledAt: string | null,
    retryDelay: number,
    jobHash: string,
    dependsOn?: readonly string[],
    batchId?: string,
    cacheKey?: string,
    cacheTTL?: number,
  ): JobInsertData {
    return {
      type,
      payload,
      priority,
      status: 'pending',
      attempts: 0,
      max_attempts: maxAttempts,
      scheduled_at: scheduledAt,
      retry_delay: retryDelay,
      job_hash: jobHash,
      ...(dependsOn && dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
      ...(batchId ? { batch_id: batchId } : {}),
      ...(cacheKey ? { cache_key: cacheKey, cache_ttl: cacheTTL ?? JobQueue.DEFAULT_CACHE_TTL } : {}),
    };
  }

  private async insertJob(insertData: JobInsertData): Promise<string> {
    try {
      const { data, error } = await retry(
        async () => {
          return await this.supabase
            .from('job_queue')
            .insert(insertData)
            .select('id')
            .single();
        },
        {
          ...JobQueue.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', JobQueue.SERVICE_NAME, 'Retrying job insert', {
              attempt,
              type: insertData.type,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error) {
        throw new Error(`Failed to enqueue job: ${error.message}`);
      }

      return data.id;
    } catch (error) {
      structuredLog('error', JobQueue.SERVICE_NAME, 'Failed to insert job', {
        type: insertData.type,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async incrementBatchTotal(batchId: string): Promise<void> {
    try {
      const { error } = await retry(
        async () => {
          return await this.supabase.rpc('increment_batch_total', { batch_id_param: batchId });
        },
        {
          ...JobQueue.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', JobQueue.SERVICE_NAME, 'Retrying batch total increment', {
              attempt,
              batchId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error) {
        structuredLog('warn', JobQueue.SERVICE_NAME, 'Failed to increment batch total', {
          batchId,
          error: error.message,
        });
      }
    } catch (error) {
      structuredLog('warn', JobQueue.SERVICE_NAME, 'Batch total increment failed', {
        batchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
