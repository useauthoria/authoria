import type { SupabaseClient } from '@supabase/supabase-js';

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

interface DatabaseJobRow {
  readonly id: string;
  readonly type: JobType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly priority: JobPriority;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly created_at: string;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
  readonly error?: string | null;
  readonly result?: unknown;
  readonly depends_on?: readonly string[] | null;
  readonly batch_id?: string | null;
  readonly progress?: number | null;
  readonly result_cached?: boolean | null;
  readonly retry_delay?: number | null;
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

export class JobQueue {
  private static readonly DEFAULT_PRIORITY: JobPriority = 'normal';
  private static readonly DEFAULT_MAX_ATTEMPTS = 3;
  private static readonly DEFAULT_DELAY = 0;
  private static readonly DEFAULT_RETRY_DELAY = 60;
  private static readonly DEFAULT_DEDUP_WINDOW = 60;
  private static readonly DEFAULT_CACHE_TTL = 3600;
  private static readonly MILLISECONDS_PER_SECOND = 1000;
  private static readonly HASH_BASE = 36;
  private static readonly HASH_SHIFT = 5;

  private readonly supabase: SupabaseClient;
  private readonly workerId: string;

  constructor(supabase: SupabaseClient, workerId?: string) {
    this.supabase = supabase;
    this.workerId = workerId ?? this.generateWorkerId();
  }

  async enqueue(
    type: JobType,
    payload: Readonly<Record<string, unknown>>,
    options: JobOptions = {},
  ): Promise<string | null> {
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

    const jobHash = deduplicationKey ?? this.generateJobHash(type, payload);

    if (deduplicationKey || skipIfDuplicate) {
      const existingHash = await this.checkJobHashExists(jobHash, dedupWindowMinutes);
      if (existingHash) {
        if (skipIfDuplicate) {
          return existingHash;
        }
        const cachedResult = await this.getCachedResult(cacheKey ?? jobHash, type, payload);
        if (cachedResult) {
          return await this.enqueueCachedJob(type, payload, cachedResult, options);
        }
        return existingHash;
      }
    }

    if (cacheKey) {
      const cachedResult = await this.getCachedResult(cacheKey, type, payload);
      if (cachedResult) {
        return await this.enqueueCachedJob(type, payload, cachedResult, options);
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

    if (batchId) {
      await this.incrementBatchTotal(batchId);
    }

    return await this.insertJob(insertData);
  }

  private async checkJobHashExists(jobHash: string, dedupWindowMinutes: number): Promise<string | null> {
    const { data } = await this.supabase.rpc('job_hash_exists', {
      job_hash_param: jobHash,
      dedup_window_minutes: dedupWindowMinutes,
    });

    return data || null;
  }

  private async enqueueCachedJob(
    type: JobType,
    payload: Readonly<Record<string, unknown>>,
    cachedResult: unknown,
    options: JobOptions,
  ): Promise<string> {
    const { data, error } = await this.supabase
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

    if (error) {
      throw new Error(`Failed to enqueue cached job: ${error.message}`);
    }

    return data.id;
  }

  private async getCachedResult(
    cacheKey: string,
    jobType: string,
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
    const { data: cached } = await this.supabase
      .from('job_result_cache')
      .select('result')
      .eq('cache_key', cacheKey)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (!cached) {
      return null;
    }

    await this.incrementCacheHitCount(cacheKey);
    return (cached as DatabaseJobCacheRow).result;
  }

  private async getCachedResultByHash(jobType: string, payloadHash: string): Promise<unknown | null> {
    const { data: cachedByHash } = await this.supabase
      .from('job_result_cache')
      .select('result, id')
      .eq('job_type', jobType)
      .eq('payload_hash', payloadHash)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!cachedByHash) {
      return null;
    }

    const cacheEntry = cachedByHash as DatabaseJobCacheKeyRow;
    await this.incrementCacheHitCountById(cacheEntry.id!);
    return cacheEntry.result;
  }

  private async incrementCacheHitCount(cacheKey: string): Promise<void> {
    const { data: cacheEntry } = await this.supabase
      .from('job_result_cache')
      .select('hit_count')
      .eq('cache_key', cacheKey)
      .single();

    await this.supabase
      .from('job_result_cache')
      .update({
        hit_count: ((cacheEntry as DatabaseJobCacheRow | null)?.hit_count ?? 0) + 1,
        last_accessed_at: new Date().toISOString(),
      })
      .eq('cache_key', cacheKey);
  }

  private async incrementCacheHitCountById(cacheId: string): Promise<void> {
    const { data: cacheEntry } = await this.supabase
      .from('job_result_cache')
      .select('hit_count')
      .eq('id', cacheId)
      .single();

    if (cacheEntry) {
      await this.supabase
        .from('job_result_cache')
        .update({
          hit_count: ((cacheEntry as DatabaseJobCacheRow).hit_count ?? 0) + 1,
          last_accessed_at: new Date().toISOString(),
        })
        .eq('id', cacheId);
    }
  }

  private generateJobHash(type: string, payload: Readonly<Record<string, unknown>>): string {
    const payloadStr = JSON.stringify(payload, Object.keys(payload).sort());
    return this.hashString(`${type}:${payloadStr}`);
  }

  private hashPayload(payload: Readonly<Record<string, unknown>>): string {
    const payloadStr = JSON.stringify(payload, Object.keys(payload).sort());
    return this.hashString(payloadStr);
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << JobQueue.HASH_SHIFT) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(JobQueue.HASH_BASE);
  }

  private generateWorkerId(): string {
    return `worker-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  private calculateScheduledAt(delay: number): string | null {
    return delay > 0
      ? new Date(Date.now() + delay * JobQueue.MILLISECONDS_PER_SECOND).toISOString()
      : null;
  }

  private calculateExpiry(ttlSeconds: number): string {
    return new Date(Date.now() + ttlSeconds * JobQueue.MILLISECONDS_PER_SECOND).toISOString();
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
    const { data, error } = await this.supabase
      .from('job_queue')
      .insert(insertData)
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to enqueue job: ${error.message}`);
    }

    return data.id;
  }

  private async incrementBatchTotal(batchId: string): Promise<void> {
    await this.supabase.rpc('increment_batch_total', { batch_id_param: batchId }).catch(() => {});
  }

}
