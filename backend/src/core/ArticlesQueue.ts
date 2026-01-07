import type { SupabaseClient } from '@supabase/supabase-js';
import type { BrandDNA, ToneMatrix } from './BrandManager';
import { RateLimiter } from '../utils/rate-limiter';

export interface QueuedArticle {
  readonly id: string;
  readonly store_id: string;
  readonly title: string;
  readonly status: 'queued';
  readonly queue_position: number;
  readonly scheduled_publish_at: string | null;
  readonly created_at: string;
  readonly content?: string;
}

export interface QueueMetrics {
  readonly currentCount: number;
  readonly targetCount: number;
  readonly planName: string;
  readonly needsRefill: boolean;
}

interface PlanRow {
  readonly plan_name: string;
}

interface ContentPreferences {
  readonly topic_preferences?: readonly string[];
  readonly keyword_focus?: readonly string[];
  readonly content_angles?: readonly string[];
}

interface StoreQueueContextRow {
  readonly plan_id: string | null;
  readonly is_active: boolean;
  readonly is_paused: boolean;
  readonly trial_ends_at: string | null;
  readonly plan_limits: PlanRow | null;
}

interface StoreContentContextRow {
  readonly brand_dna: unknown;
  readonly tone_matrix: unknown;
  readonly content_preferences: unknown;
}

interface QueueRow {
  readonly id: string;
  readonly store_id: string;
  readonly title: string;
  readonly status: string;
  readonly queue_position: number | null;
  readonly scheduled_publish_at: string | null;
  readonly created_at: string;
  readonly content?: string | null;
}

interface QueueMetaRow {
  readonly id: string;
  readonly title: string;
  readonly queue_position: number | null;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

type LogLevel = 'info' | 'warn' | 'error';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (level === 'error') {
    (globalThis as unknown as { Deno: { stderr: { writeSync: (data: Uint8Array) => void } } }).Deno.stderr.writeSync(
      encoder.encode(payload + '\n'),
    );
    return;
  }

  (globalThis as unknown as { Deno: { stdout: { writeSync: (data: Uint8Array) => void } } }).Deno.stdout.writeSync(
    encoder.encode(payload + '\n'),
  );
};

const assertUuid = (value: string, field: string): void => {
  if (!UUID_REGEX.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
};

const nowMs = (): number => Date.now();

const getCache = <T>(cache: Map<string, CacheEntry<T>>, key: string): T | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (nowMs() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
};

const setCache = <T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void => {
  cache.set(key, { value, expiresAt: nowMs() + ttlMs });
};

const uniqueStrings = (items: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
};

export class ArticlesQueue {
  private readonly supabase: SupabaseClient;
  private readonly enableBrandContext: boolean;
  private readonly limiter: RateLimiter;
  private readonly metricsCache = new Map<string, CacheEntry<QueueMetrics | null>>();
  private readonly queueCache = new Map<string, CacheEntry<readonly QueuedArticle[]>>();
  private readonly storeContextCache = new Map<string, CacheEntry<StoreContentContextRow | null>>();
  private readonly inflightStoreContext = new Map<string, Promise<StoreContentContextRow | null>>();
  private static readonly SERVICE_NAME = 'ArticlesQueue';
  private static readonly METRICS_TTL_MS = 15_000;
  private static readonly QUEUE_TTL_MS = 5_000;
  private static readonly STORE_CONTEXT_TTL_MS = 60_000;
  private static readonly MAX_REORDER_ITEMS = 200;

  constructor(
    supabase: SupabaseClient,
    openaiApiKey?: string,
    toneMatrix?: ToneMatrix,
    brandDNA?: BrandDNA,
  ) {
    this.supabase = supabase;
    this.enableBrandContext = Boolean(openaiApiKey && toneMatrix && brandDNA);
    this.limiter = new RateLimiter({
      maxRequests: 10,
      windowMs: 1000,
      burst: 2,
      algorithm: 'token-bucket',
      keyPrefix: 'articles-queue',
      concurrency: 10,
    });
  }

  getQueueSizeForPlan(planName: string | null): number {
    if (planName === 'publisher') return 7;
    return 3;
  }

  async getQueueMetrics(storeId: string): Promise<QueueMetrics | null> {
    assertUuid(storeId, 'storeId');

    const cached = getCache(this.metricsCache, storeId);
    if (cached !== null) {
      return cached;
    }

    const { data: store, error: storeError } = await this.supabase
      .from('stores')
      .select('plan_id, is_active, is_paused, trial_ends_at, plan_limits(plan_name)')
      .eq('id', storeId)
      .single();

    if (storeError || !store) {
      setCache(this.metricsCache, storeId, null, ArticlesQueue.METRICS_TTL_MS);
      return null;
    }

    const storeData = store as unknown as StoreQueueContextRow;

    if (!storeData.is_active || storeData.is_paused) {
      const result: QueueMetrics = {
        currentCount: 0,
        targetCount: 0,
        planName: 'inactive',
        needsRefill: false,
      };
      setCache(this.metricsCache, storeId, result, ArticlesQueue.METRICS_TTL_MS);
      return result;
    }

    if (storeData.trial_ends_at) {
      const trialEnd = new Date(storeData.trial_ends_at);
      const now = new Date();
      if (now > trialEnd) {
        const result: QueueMetrics = {
          currentCount: 0,
          targetCount: 0,
          planName: 'trial_expired',
          needsRefill: false,
        };
        setCache(this.metricsCache, storeId, result, ArticlesQueue.METRICS_TTL_MS);
        return result;
      }
    }

    const planName = storeData.plan_limits?.plan_name || null;
    const targetCount = this.getQueueSizeForPlan(planName);

    const { count, error: countError } = await this.supabase
      .from('blog_posts')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', storeId)
      .eq('status', 'queued');

    if (countError) {
      setCache(this.metricsCache, storeId, null, ArticlesQueue.METRICS_TTL_MS);
      return null;
    }

    const result: QueueMetrics = {
      currentCount: count || 0,
      targetCount,
      planName: planName || 'unknown',
      needsRefill: (count || 0) < targetCount,
    };
    setCache(this.metricsCache, storeId, result, ArticlesQueue.METRICS_TTL_MS);
    return result;
  }

  async getQueue(storeId: string): Promise<readonly QueuedArticle[]> {
    assertUuid(storeId, 'storeId');

    const cached = getCache(this.queueCache, storeId);
    if (cached) return cached;

    const { data, error } = await this.supabase
      .from('blog_posts')
      .select('id, store_id, title, status, queue_position, scheduled_publish_at, created_at, content')
      .eq('store_id', storeId)
      .eq('status', 'queued')
      .order('queue_position', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });

    if (error || !data) {
      return [];
    }

    const result = (data as unknown as readonly QueueRow[]).map((row) => ({
      id: row.id,
      store_id: row.store_id,
      title: row.title,
      status: 'queued' as const,
      queue_position: row.queue_position ?? 0,
      scheduled_publish_at: row.scheduled_publish_at,
      created_at: row.created_at,
      content: row.content ?? undefined,
    }));
    setCache(this.queueCache, storeId, result, ArticlesQueue.QUEUE_TTL_MS);
    return result;
  }

  async generateQueueTitle(
    storeId: string,
    existingTitles: readonly string[] = [],
  ): Promise<string> {
    assertUuid(storeId, 'storeId');

    if (!this.enableBrandContext) {
      return this.generateFallbackTitle(existingTitles);
    }

    const storeData = await this.getStoreContentContext(storeId);
    if (!storeData) {
      return this.generateFallbackTitle(existingTitles);
    }

    const brandDNA = (storeData.brand_dna ?? {}) as BrandDNA;
    const contentPreferences = (storeData.content_preferences ?? {}) as ContentPreferences;

    const topic = this.generateTopicFromContext(brandDNA, contentPreferences, existingTitles);
    const normalizedExisting = new Set(existingTitles);
    if (normalizedExisting.has(topic)) {
      const variations = [
        `Complete Guide to ${topic}`,
        `Ultimate ${topic} Guide`,
        `${topic}: Expert Insights`,
        `Mastering ${topic}`,
        `Everything About ${topic}`,
      ];
      
      for (const variation of variations) {
        if (!normalizedExisting.has(variation)) {
          return variation;
        }
      }
      
      let counter = 2;
      while (normalizedExisting.has(`${topic} ${counter}`)) {
        counter++;
      }
      return `${topic} ${counter}`;
    }
    
    return topic;
  }

  private generateTopicFromContext(
    brandDNA: BrandDNA,
    contentPreferences: {
      topic_preferences?: readonly string[];
      keyword_focus?: readonly string[];
      content_angles?: readonly string[];
    },
    existingTitles: readonly string[],
  ): string {
    const existingLower = existingTitles.map((t) => t.toLowerCase());

    if (contentPreferences.topic_preferences && contentPreferences.topic_preferences.length > 0) {
      const topics = contentPreferences.topic_preferences.filter(
        (t) => !existingLower.some((et) => et.includes(t.toLowerCase())),
      );
      if (topics.length > 0) {
        return topics[Math.floor(Math.random() * topics.length)] || topics[0]!;
      }
    }

    if (contentPreferences.keyword_focus && contentPreferences.keyword_focus.length > 0) {
      const keywords = contentPreferences.keyword_focus.filter(
        (k) => !existingLower.some((et) => et.includes(k.toLowerCase())),
      );
      if (keywords.length > 0) {
        return keywords[Math.floor(Math.random() * keywords.length)] || keywords[0]!;
      }
    }

    if (brandDNA && typeof brandDNA === 'object' && 'brandName' in brandDNA) {
      const brandName = (brandDNA as { brandName?: string }).brandName;
      if (brandName) {
        return `Complete Guide to ${brandName}`;
      }
    }

    return 'Latest Trends and Insights';
  }

  private generateFallbackTitle(existingTitles: readonly string[]): string {
    const baseTitles = [
      'Complete Guide to Success',
      'Expert Tips and Insights',
      'Ultimate Resource Guide',
      'Best Practices Explained',
      'Professional Insights',
      'Industry Trends',
      'Expert Advice',
      'Comprehensive Guide',
    ];

    const available = baseTitles.filter(
      (title) => !existingTitles.some((et) => et.toLowerCase().includes(title.toLowerCase())),
    );

    if (available.length > 0) {
      return available[Math.floor(Math.random() * available.length)] || available[0]!;
    }

    return `Article ${existingTitles.length + 1}`;
  }

  async createQueuedArticle(storeId: string): Promise<QueuedArticle | null> {
    assertUuid(storeId, 'storeId');

    const meta = await this.getQueueMeta(storeId);
    const existingTitles = meta.titles;
    const nextPosition = meta.maxPosition + 1;
    const title = await this.generateQueueTitle(storeId, existingTitles);

    const { data, error } = await this.supabase
      .from('blog_posts')
      .insert({
        store_id: storeId,
        title,
        content: '',
        status: 'queued',
        queue_position: nextPosition,
      })
      .select('id, store_id, title, status, queue_position, scheduled_publish_at, created_at')
      .single();

    if (error || !data) {
      structuredLog('warn', ArticlesQueue.SERVICE_NAME, 'createQueuedArticle failed', {
        storeId,
        error: error ? (error as { message?: string }).message ?? String(error) : 'unknown',
      });
      return null;
    }

    this.invalidateStoreCaches(storeId);

    const row = data as unknown as QueueRow;
    return {
      id: row.id,
      store_id: row.store_id,
      title: row.title,
      status: 'queued' as const,
      queue_position: row.queue_position ?? 0,
      scheduled_publish_at: row.scheduled_publish_at,
      created_at: row.created_at,
    } as const;
  }

  async refillQueue(storeId: string): Promise<number> {
    assertUuid(storeId, 'storeId');

    const metrics = await this.getQueueMetrics(storeId);
    if (!metrics) {
      return 0;
    }

    if (metrics.targetCount === 0 || !metrics.needsRefill) {
      return 0;
    }

    const needed = metrics.targetCount - metrics.currentCount;
    if (needed <= 0) {
      return 0;
    }

    let created = 0;

    for (let i = 0; i < needed; i++) {
      const allowed = await this.limiter.waitForToken(storeId, 30_000);
      if (!allowed) {
        structuredLog('warn', ArticlesQueue.SERVICE_NAME, 'refillQueue rate limited', { storeId });
        break;
      }

      const article = await this.createQueuedArticle(storeId);
      if (article) {
        created++;
      }
    }

    return created;
  }

  async reorderQueue(storeId: string, articleIds: readonly string[]): Promise<boolean> {
    assertUuid(storeId, 'storeId');

    if (!Array.isArray(articleIds) || articleIds.length === 0) {
      return false;
    }
    if (articleIds.length > ArticlesQueue.MAX_REORDER_ITEMS) {
      structuredLog('warn', ArticlesQueue.SERVICE_NAME, 'reorderQueue too many items', {
        storeId,
        count: articleIds.length,
      });
      return false;
    }

    const unique = uniqueStrings(articleIds);
    if (unique.length !== articleIds.length) {
      structuredLog('warn', ArticlesQueue.SERVICE_NAME, 'reorderQueue duplicate ids', { storeId });
      return false;
    }
    for (const id of unique) {
      assertUuid(id, 'articleId');
    }

    const updates = unique.map((id, index) => ({ id, queue_position: index }));
    const concurrency = 10;
    let index = 0;

    while (index < updates.length) {
      const slice = updates.slice(index, index + concurrency);
      const results = await Promise.all(
        slice.map(async (u) => {
          const allowed = await this.limiter.waitForToken(storeId, 30_000);
          if (!allowed) {
            return { ok: false, error: 'rate_limited' as const };
          }

          const { error } = await this.supabase
            .from('blog_posts')
            .update({ queue_position: u.queue_position })
            .eq('id', u.id)
            .eq('store_id', storeId)
            .eq('status', 'queued');

          if (error) {
            return {
              ok: false,
              error: (error as { message?: string }).message ?? String(error),
            } as const;
          }

          return { ok: true } as const;
        }),
      );

      const failed = results.find((r) => !r.ok);
      if (failed) {
        structuredLog('error', ArticlesQueue.SERVICE_NAME, 'reorderQueue failed', {
          storeId,
          error: failed.error,
        });
        return false;
      }

      index += concurrency;
    }

    this.invalidateStoreCaches(storeId);
    return true;
  }

  async regenerateTitle(storeId: string, articleId: string): Promise<string | null> {
    assertUuid(storeId, 'storeId');
    assertUuid(articleId, 'articleId');

    const meta = await this.getQueueMeta(storeId);
    const existingTitles = meta.rows.filter((r) => r.id !== articleId).map((r) => r.title);

    const newTitle = await this.generateQueueTitle(storeId, existingTitles);

    const { error } = await this.supabase
      .from('blog_posts')
      .update({ title: newTitle })
      .eq('id', articleId)
      .eq('store_id', storeId)
      .eq('status', 'queued');

    if (error) {
      structuredLog('error', ArticlesQueue.SERVICE_NAME, 'regenerateTitle update failed', {
        storeId,
        articleId,
        error: (error as { message?: string }).message ?? String(error),
      });
      return null;
    }

    this.invalidateStoreCaches(storeId);
    return newTitle;
  }

  async removeFromQueue(storeId: string, articleId: string): Promise<boolean> {
    assertUuid(storeId, 'storeId');
    assertUuid(articleId, 'articleId');

    const queue = await this.getQueue(storeId);
    const remaining = queue.filter((a) => a.id !== articleId);

    if (remaining.length > 0) {
      const articleIds = remaining.map((a) => a.id);
      return await this.reorderQueue(storeId, articleIds);
    }

    return true;
  }

  private invalidateStoreCaches(storeId: string): void {
    this.metricsCache.delete(storeId);
    this.queueCache.delete(storeId);
  }

  private async getQueueMeta(storeId: string): Promise<{
    readonly rows: readonly QueueMetaRow[];
    readonly titles: readonly string[];
    readonly maxPosition: number;
  }> {
    const { data, error } = await this.supabase
      .from('blog_posts')
      .select('id,title,queue_position')
      .eq('store_id', storeId)
      .eq('status', 'queued')
      .order('queue_position', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (error || !data) {
      return { rows: [], titles: [], maxPosition: -1 };
    }

    const rows = data as unknown as readonly QueueMetaRow[];
    const titles = rows.map((r) => r.title);
    const maxPosition = rows.reduce((max, r) => Math.max(max, r.queue_position ?? 0), -1);
    return { rows, titles, maxPosition };
  }

  private async getStoreContentContext(storeId: string): Promise<StoreContentContextRow | null> {
    const cached = getCache(this.storeContextCache, storeId);
    if (cached !== null) {
      return cached;
    }

    const inflight = this.inflightStoreContext.get(storeId);
    if (inflight) {
      return inflight;
    }

    const promise = (async (): Promise<StoreContentContextRow | null> => {
      const { data, error } = await this.supabase
        .from('stores')
        .select('brand_dna, tone_matrix, content_preferences')
        .eq('id', storeId)
        .single();

      const result = error || !data ? null : (data as unknown as StoreContentContextRow);
      setCache(this.storeContextCache, storeId, result, ArticlesQueue.STORE_CONTEXT_TTL_MS);
      return result;
    })().finally(() => {
      this.inflightStoreContext.delete(storeId);
    });

    this.inflightStoreContext.set(storeId, promise);
    return promise;
  }
}

