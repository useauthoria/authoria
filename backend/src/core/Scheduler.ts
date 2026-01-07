import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { retry } from '../utils/error-handling.ts';
import { getShopifyRateLimiter } from '../utils/rate-limiter.ts';
import { ShopifyAPI } from '../integrations/ShopifyClient.ts';
import { BrandSafety } from './BrandManager.ts';
import { GoogleSearchConsole } from '../integrations/GoogleServices.ts';

export interface ScheduledPost {
  readonly id: string;
  readonly postId: string;
  readonly storeId: string;
  readonly scheduledAt: Date;
  readonly status: 'pending' | 'processing' | 'published' | 'failed' | 'cancelled';
  readonly priority: number;
  readonly queuePosition?: number;
  readonly retryCount: number;
  readonly validationPassed: boolean;
  readonly validationErrors?: readonly string[];
  readonly contentHash?: string;
  readonly shopifyBlogId?: number;
}

export interface ScheduleConflict {
  readonly conflictId?: string;
  readonly conflictType: 'time_overlap' | 'too_many_same_day' | 'rate_limit_risk';
  readonly severity: 'low' | 'medium' | 'high';
  readonly scheduledAt: Date;
  readonly conflictingAt?: Date;
  readonly suggestedAlternative?: Date;
}

interface DatabaseStoreRow {
  readonly id: string;
  readonly timezone?: string | null;
  readonly shop_domain: string;
  readonly access_token: string;
  readonly shopify_blog_id?: number | null;
  readonly content_preferences?: {
    readonly default_author?: string;
    readonly [key: string]: unknown;
  } | null;
  readonly shop_metadata?: {
    readonly name?: string;
    readonly shop_name?: string;
    readonly [key: string]: unknown;
  } | null;
}

interface DatabasePostRow {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly excerpt?: string | null;
  readonly keywords?: readonly string[] | null;
  readonly featured_image_url?: string | null;
  readonly status?: string;
  readonly scheduled_publish_at?: string | null;
  readonly published_at?: string | null;
  readonly shopify_article_id?: number | null;
}

interface DatabaseScheduleRow {
  readonly id: string;
  readonly store_id: string;
  readonly post_id: string;
  readonly scheduled_at: string;
  readonly status: string;
  readonly priority?: number | null;
  readonly queue_position?: number | null;
  readonly retry_count?: number | null;
  readonly validation_passed?: boolean | null;
  readonly validation_errors?: readonly string[] | null;
  readonly content_hash?: string | null;
  readonly shopify_blog_id?: number | null;
  readonly error_message?: string | null;
  readonly last_retry_at?: string | null;
  readonly blog_posts?: DatabasePostRow | null;
  readonly stores?: DatabaseStoreRow | null;
}

interface DatabaseConflictRow {
  readonly conflict_id?: string;
  readonly conflict_type: string;
  readonly severity: string;
  readonly conflicting_at?: string | null;
  readonly suggested_alternative?: string | null;
}

interface DatabaseIntegrationRow {
  readonly credentials: {
    readonly access_token: string;
    readonly site_url: string;
    readonly sitemap_url?: string;
  };
}

interface ValidationResult {
  readonly passed: boolean;
  readonly issues: ReadonlyArray<{ readonly message: string }>;
}

interface NotificationData {
  readonly type: string;
  readonly title: string;
  readonly message: string;
  readonly severity: 'info' | 'warning' | 'error' | 'success';
}

interface BrandDNA {
  readonly [key: string]: unknown;
}

interface ToneMatrix {
  readonly [key: string]: unknown;
}

interface StoreCacheEntry {
  readonly store: DatabaseStoreRow;
  readonly expiresAt: number;
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

const generateCorrelationId = (): string => {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
};

const validateStoreId = (storeId: string): void => {
  if (!storeId || typeof storeId !== 'string' || storeId.trim().length === 0) {
    throw new Error('Invalid storeId: must be a non-empty string');
  }
};

const validatePostId = (postId: string): void => {
  if (!postId || typeof postId !== 'string' || postId.trim().length === 0) {
    throw new Error('Invalid postId: must be a non-empty string');
  }
};

const validateScheduledAt = (scheduledAt: Date): void => {
  if (!(scheduledAt instanceof Date) || isNaN(scheduledAt.getTime())) {
    throw new Error('Invalid scheduledAt: must be a valid Date');
  }
};

const formatStoreName = (store: DatabaseStoreRow): string => {
  let storeName = (store.shop_metadata?.name ||
    store.shop_metadata?.shop_name ||
    store.shop_domain ||
    'Authoria') as string;

  if (storeName.includes('.')) {
    storeName = storeName.split('.')[0];
  }

  storeName = storeName
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

  return storeName;
};

const isConflictType = (type: string): type is ScheduleConflict['conflictType'] => {
  return type === 'time_overlap' || type === 'too_many_same_day' || type === 'rate_limit_risk';
};

const isSeverity = (severity: string): severity is ScheduleConflict['severity'] => {
  return severity === 'low' || severity === 'medium' || severity === 'high';
};

export class Scheduler {
  private readonly supabase: SupabaseClient;
  private readonly brandSafety?: BrandSafety;
  private readonly rateLimiter: ReturnType<typeof getShopifyRateLimiter>;
  private readonly storeCache: Map<string, StoreCacheEntry>;
  private static readonly SERVICE_NAME = 'Scheduler';
  private static readonly DEFAULT_TIMEZONE = 'UTC';
  private static readonly DEFAULT_PRIORITY = 5;
  private static readonly MAX_RETRIES = 3;
  private static readonly PROCESSING_CONCURRENCY = 3;
  private static readonly PROCESSING_BATCH_SIZE = 50;
  private static readonly RETRY_INITIAL_DELAY = 2000;
  private static readonly RETRY_BACKOFF_MULTIPLIER = 2;
  private static readonly STORE_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffMultiplier: 2,
    retryableErrors: ['rate limit', 'timeout', 'network', '500', '502', '503', '504'] as const,
  } as const;

  private static readonly RETRYABLE_ERRORS: readonly string[] = [
    'rate limit',
    'timeout',
    'network',
    '500',
    '502',
    '503',
    '504',
  ] as const;

  constructor(
    supabaseUrl: string,
    supabaseKey: string,
    openaiKey?: string,
    brandDNA?: BrandDNA,
    toneMatrix?: ToneMatrix,
  ) {
    if (!supabaseUrl || typeof supabaseUrl !== 'string' || supabaseUrl.trim().length === 0) {
      throw new Error('Invalid supabaseUrl: must be a non-empty string');
    }
    if (!supabaseKey || typeof supabaseKey !== 'string' || supabaseKey.trim().length === 0) {
      throw new Error('Invalid supabaseKey: must be a non-empty string');
    }

    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.rateLimiter = getShopifyRateLimiter();
    this.storeCache = new Map();

    if (openaiKey) {
      if (typeof openaiKey !== 'string' || openaiKey.trim().length === 0) {
        throw new Error('Invalid OpenAI API key');
      }
      if (brandDNA || toneMatrix) {
        this.brandSafety = new BrandSafety(openaiKey, { brandDNA, toneMatrix });
      }
    }
  }

  async detectConflicts(
    storeId: string,
    scheduledAt: Date,
    postId: string,
    excludeScheduleId?: string,
  ): Promise<ReadonlyArray<ScheduleConflict>> {
    const startTime = Date.now();
    const correlationId = generateCorrelationId();
    validateStoreId(storeId);
    validateScheduledAt(scheduledAt);
    validatePostId(postId);
    if (excludeScheduleId !== undefined && (!excludeScheduleId || typeof excludeScheduleId !== 'string')) {
      throw new Error('Invalid excludeScheduleId: must be a non-empty string if provided');
    }

    try {
      const { data: conflicts, error } = await retry(
        async () => {
          return await this.supabase.rpc('detect_schedule_conflicts', {
            p_store_id: storeId,
            p_scheduled_at: scheduledAt.toISOString(),
            p_post_id: postId,
            p_exclude_schedule_id: excludeScheduleId || null,
          });
        },
        {
          ...Scheduler.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', Scheduler.SERVICE_NAME, 'Retrying conflict detection', {
              attempt,
              storeId,
              postId,
              correlationId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error) {
        throw new Error(`Failed to detect conflicts: ${error.message}`);
      }

      const result = this.mapConflicts(conflicts as ReadonlyArray<DatabaseConflictRow> | null, scheduledAt);
      const duration = Date.now() - startTime;

      structuredLog('info', Scheduler.SERVICE_NAME, 'Conflicts detected', {
        storeId,
        postId,
        correlationId,
        conflictsCount: result.length,
        durationMs: duration,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', Scheduler.SERVICE_NAME, 'Failed to detect conflicts', {
        storeId,
        postId,
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      throw error;
    }
  }

  async processScheduledPosts(): Promise<void> {
    const startTime = Date.now();
    const correlationId = generateCorrelationId();

    try {
      const now = new Date();
      const { data: duePosts, error } = await retry(
        async () => {
          return await this.supabase
            .from('posts_schedule')
            .select('*, blog_posts(*), stores(*)')
            .eq('status', 'pending')
            .lte('scheduled_at', now.toISOString())
            .order('priority', { ascending: false })
            .order('scheduled_at', { ascending: true })
            .limit(Scheduler.PROCESSING_BATCH_SIZE);
        },
        {
          ...Scheduler.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', Scheduler.SERVICE_NAME, 'Retrying scheduled posts fetch', {
              attempt,
              correlationId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error) {
        structuredLog('error', Scheduler.SERVICE_NAME, 'Failed to fetch scheduled posts', {
          correlationId,
          error: error.message,
        });
        return;
      }

      if (!duePosts || duePosts.length === 0) {
        structuredLog('info', Scheduler.SERVICE_NAME, 'No scheduled posts to process', {
          correlationId,
        });
        return;
      }

      for (let i = 0; i < duePosts.length; i += Scheduler.PROCESSING_CONCURRENCY) {
        const batch = duePosts.slice(i, i + Scheduler.PROCESSING_CONCURRENCY);
        await Promise.all(batch.map((post) => this.processPost(post as DatabaseScheduleRow, correlationId)));
      }

      const duration = Date.now() - startTime;
      structuredLog('info', Scheduler.SERVICE_NAME, 'Scheduled posts processed', {
        correlationId,
        postsCount: duePosts.length,
        durationMs: duration,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', Scheduler.SERVICE_NAME, 'Failed to process scheduled posts', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      throw error;
    }
  }

  private async updateSchedule(
    scheduleId: string,
    updates: Partial<{
      readonly scheduled_at: string;
      readonly status: string;
      readonly retry_count: number;
      readonly queue_position: number;
      readonly priority: number;
    }>,
  ): Promise<void> {
    try {
      await retry(
        async () => {
          return await this.supabase.from('posts_schedule').update(updates).eq('id', scheduleId);
        },
        {
          ...Scheduler.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', Scheduler.SERVICE_NAME, 'Retrying schedule update', {
              attempt,
              scheduleId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );
    } catch (error) {
      structuredLog('error', Scheduler.SERVICE_NAME, 'Failed to update schedule', {
        scheduleId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async updatePostStatus(
    postId: string,
    status: string | undefined,
    scheduledPublishAt: string | null,
  ): Promise<void> {
    const updates: Partial<{
      readonly status: string;
      readonly scheduled_publish_at: string | null;
    }> = {};

    if (status) {
      updates.status = status;
    }

    if (scheduledPublishAt !== undefined) {
      updates.scheduled_publish_at = scheduledPublishAt;
    }

    try {
      await retry(
        async () => {
          return await this.supabase.from('blog_posts').update(updates).eq('id', postId);
        },
        {
          ...Scheduler.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', Scheduler.SERVICE_NAME, 'Retrying post status update', {
              attempt,
              postId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );
    } catch (error) {
      structuredLog('error', Scheduler.SERVICE_NAME, 'Failed to update post status', {
        postId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async processPost(scheduledPost: DatabaseScheduleRow, correlationId: string): Promise<void> {
    const startTime = Date.now();
    await this.updateSchedule(scheduledPost.id, { status: 'processing' });

    try {
      await retry(
        async () => {
          await this.publishPost(scheduledPost, correlationId);
        },
        {
          maxAttempts: Scheduler.MAX_RETRIES,
          initialDelay: Scheduler.RETRY_INITIAL_DELAY,
          backoffMultiplier: Scheduler.RETRY_BACKOFF_MULTIPLIER,
          retryableErrors: Scheduler.RETRYABLE_ERRORS,
          onRetry: async (attempt, error) => {
            await this.updateSchedule(scheduledPost.id, {
              retry_count: attempt,
            });
            structuredLog('warn', Scheduler.SERVICE_NAME, 'Retrying post publication', {
              attempt,
              scheduleId: scheduledPost.id,
              postId: scheduledPost.post_id,
              correlationId,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        },
      );

      const postTitle = (scheduledPost.blog_posts as DatabasePostRow | null)?.title || 'Untitled';
      await Promise.all([
        this.updateSchedule(scheduledPost.id, { status: 'published' }),
        this.sendNotification(
          scheduledPost.store_id,
          scheduledPost.post_id,
          scheduledPost.id,
          {
            type: 'published',
            title: 'Post Published',
            message: `Post "${postTitle}" has been published successfully.`,
            severity: 'success',
          },
        ),
      ]);

      const duration = Date.now() - startTime;
      structuredLog('info', Scheduler.SERVICE_NAME, 'Post published successfully', {
        scheduleId: scheduledPost.id,
        postId: scheduledPost.post_id,
        storeId: scheduledPost.store_id,
        correlationId,
        durationMs: duration,
      });
    } catch (error) {
      const retryCount = scheduledPost.retry_count || 0;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const duration = Date.now() - startTime;

      if (retryCount >= Scheduler.MAX_RETRIES) {
        await Promise.all([
          this.updateSchedule(scheduledPost.id, {
            status: 'failed',
          }),
          this.sendNotification(
            scheduledPost.store_id,
            scheduledPost.post_id,
            scheduledPost.id,
            {
              type: 'failed',
              title: 'Publishing Failed',
              message: `Failed to publish post after ${Scheduler.MAX_RETRIES} attempts: ${errorMessage}`,
              severity: 'error',
            },
          ),
        ]);

        structuredLog('error', Scheduler.SERVICE_NAME, 'Post publication failed after max retries', {
          scheduleId: scheduledPost.id,
          postId: scheduledPost.post_id,
          storeId: scheduledPost.store_id,
          correlationId,
          retryCount,
          error: errorMessage,
          durationMs: duration,
        });
      } else {
        await this.updateSchedule(scheduledPost.id, {
          status: 'pending',
          retry_count: retryCount + 1,
        });

        structuredLog('warn', Scheduler.SERVICE_NAME, 'Post publication failed, will retry', {
          scheduleId: scheduledPost.id,
          postId: scheduledPost.post_id,
          storeId: scheduledPost.store_id,
          correlationId,
          retryCount: retryCount + 1,
          error: errorMessage,
          durationMs: duration,
        });
      }
    }
  }

  private async publishPost(scheduledPost: DatabaseScheduleRow, correlationId: string): Promise<void> {
    const startTime = Date.now();
    const post = scheduledPost.blog_posts as DatabasePostRow | null;
    const store = scheduledPost.stores as DatabaseStoreRow | null;

    if (!post || !store) {
      throw new Error('Post or store not found');
    }

    const rateLimitCheck = await this.rateLimiter.checkRestLimit(store.shop_domain);
    if (!rateLimitCheck.allowed) {
      structuredLog('info', Scheduler.SERVICE_NAME, 'Waiting for rate limit token', {
        storeId: store.id,
        shopDomain: store.shop_domain,
        correlationId,
      });
      await this.rateLimiter.waitForRestToken(store.shop_domain);
    }

    const shopifyAPI = new ShopifyAPI(store.shop_domain, store.access_token);
    const blogs = await shopifyAPI.getBlogs(store.shop_domain, store.access_token);
    const blogId =
      scheduledPost.shopify_blog_id ||
      blogs[0]?.id ||
      store.shopify_blog_id ||
      null;

    if (!blogId) {
      throw new Error('No blog found in Shopify store');
    }

    if (!scheduledPost.validation_passed && post.content && this.brandSafety) {
      const validation = await this.validateContent(post.content, post.title);
      if (!validation.passed) {
        const issues = validation.issues.map((i) => i.message).join(', ');
        throw new Error(`Content validation failed: ${issues}`);
      }
    }

    const articleData = this.buildArticleData(post, store);
    const article = await shopifyAPI.createBlogArticle(
      store.shop_domain,
      store.access_token,
      blogId,
      articleData,
    );

    await Promise.all([
      this.updatePostStatus(post.id, 'published', new Date().toISOString()),
      this.updateTimeSlotAvailability(store.id, new Date(scheduledPost.scheduled_at), -1),
    ]);

    if (article.id) {
      const articleUrl = `https://${store.shop_domain}/blogs/${article.id}`;
      await this.submitSitemapForPublishedArticle(store.id, articleUrl, correlationId);
    }

    const duration = Date.now() - startTime;
    structuredLog('info', Scheduler.SERVICE_NAME, 'Post published to Shopify', {
      scheduleId: scheduledPost.id,
      postId: post.id,
      storeId: store.id,
      blogId,
      articleId: article.id,
      correlationId,
      durationMs: duration,
    });
  }

  private buildArticleData(post: DatabasePostRow, store: DatabaseStoreRow): Readonly<Record<string, unknown>> {
    const storeName = formatStoreName(store);
    const defaultAuthorTemplate = store.content_preferences?.default_author || `${storeName}'s Editorial`;
    const author = defaultAuthorTemplate.replace('{Storename}', storeName);

    const articleData: Record<string, unknown> = {
      title: post.title,
      body_html: post.content,
      author,
      tags: (post.keywords || []).join(', '),
      published: true,
      published_at: new Date().toISOString(),
    };

    if (post.excerpt) {
      articleData.summary = post.excerpt;
    }

    if (post.featured_image_url) {
      articleData.image = {
        src: post.featured_image_url,
        alt: post.title,
      };
    }

    return articleData;
  }

  private async submitSitemapForPublishedArticle(
    storeId: string,
    articleUrl: string,
    correlationId: string,
  ): Promise<void> {
    try {
      const integration = await this.getGSCIntegration(storeId);
      if (!integration) {
        return;
      }

      const credentials = integration.credentials;

      if (!credentials.access_token || !credentials.site_url) {
        return;
      }

      const store = await this.getStore(storeId);
      const gsc = new GoogleSearchConsole({
        accessToken: credentials.access_token,
        siteUrl: credentials.site_url,
        timezone: store?.timezone || Scheduler.DEFAULT_TIMEZONE,
      });

      if (credentials.sitemap_url) {
        const result = await gsc.submitSitemapUrl(credentials.sitemap_url);
        if (result.success) {
          structuredLog('info', Scheduler.SERVICE_NAME, 'Sitemap submitted successfully', {
            storeId,
            articleUrl,
            correlationId,
            sitemapUrl: credentials.sitemap_url,
          });
          return;
        }
      }

      const detectedUrl = await gsc.detectSitemapUrl();
      if (detectedUrl) {
        const result = await gsc.submitSitemapUrl(detectedUrl);
        if (result.success) {
          await retry(
            async () => {
              return await this.supabase
                .from('analytics_integrations')
                .update({ credentials: { ...credentials, sitemap_url: detectedUrl } })
                .eq('store_id', storeId)
                .eq('integration_type', 'google_search_console');
            },
            {
              ...Scheduler.DEFAULT_RETRY_OPTIONS,
              onRetry: (attempt, err) => {
                structuredLog('warn', Scheduler.SERVICE_NAME, 'Retrying sitemap URL save', {
                  attempt,
                  storeId,
                  error: err instanceof Error ? err.message : String(err),
                });
              },
            },
          );

          structuredLog('info', Scheduler.SERVICE_NAME, 'Sitemap submitted and saved', {
            storeId,
            articleUrl,
            correlationId,
            sitemapUrl: detectedUrl,
          });
          return;
        }
      }

      await gsc.submitSitemapForArticle(articleUrl);
      structuredLog('info', Scheduler.SERVICE_NAME, 'Sitemap submitted via fallback', {
        storeId,
        articleUrl,
        correlationId,
      });
    } catch (error) {
      structuredLog('warn', Scheduler.SERVICE_NAME, 'Sitemap submission failed', {
        storeId,
        articleUrl,
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async getGSCIntegration(
    storeId: string,
  ): Promise<DatabaseIntegrationRow | null> {
    try {
      const { data, error } = await retry(
        async () => {
          return await this.supabase
            .from('analytics_integrations')
            .select('credentials')
            .eq('store_id', storeId)
            .eq('integration_type', 'google_search_console')
            .eq('is_active', true)
            .single();
        },
        {
          ...Scheduler.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', Scheduler.SERVICE_NAME, 'Retrying GSC integration fetch', {
              attempt,
              storeId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error || !data) {
        return null;
      }

      return data as DatabaseIntegrationRow;
    } catch (error) {
      structuredLog('warn', Scheduler.SERVICE_NAME, 'Failed to get GSC integration', {
        storeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async getStore(storeId: string): Promise<DatabaseStoreRow | null> {
    const cached = this.storeCache.get(storeId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.store;
    }

    try {
      const { data, error } = await retry(
        async () => {
          return await this.supabase
            .from('stores')
            .select('timezone')
            .eq('id', storeId)
            .single();
        },
        {
          ...Scheduler.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', Scheduler.SERVICE_NAME, 'Retrying store fetch', {
              attempt,
              storeId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error || !data) {
        return null;
      }

      const store = data as DatabaseStoreRow;
      this.storeCache.set(storeId, {
        store,
        expiresAt: Date.now() + Scheduler.STORE_CACHE_TTL_MS,
      });

      return store;
    } catch (error) {
      structuredLog('warn', Scheduler.SERVICE_NAME, 'Failed to get store', {
        storeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async validateContent(
    content: string,
    title: string,
  ): Promise<ValidationResult> {
    if (!this.brandSafety) {
      return { passed: true, issues: [] };
    }

    try {
      const safetyCheck = await this.brandSafety.checkContent(content, {
        checkSEO: true,
        checkStructure: true,
        strictMode: false,
      });

      return {
        passed: safetyCheck.passed,
        issues: safetyCheck.issues.map((i) => ({ message: i.message })),
      };
    } catch (error) {
      structuredLog('warn', Scheduler.SERVICE_NAME, 'Content validation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { passed: true, issues: [] };
    }
  }

  private async updateTimeSlotAvailability(
    storeId: string,
    scheduledAt: Date,
    increment: number,
  ): Promise<void> {
    try {
      await retry(
        async () => {
          return await this.supabase.rpc('update_time_slot_availability', {
            p_store_id: storeId,
            p_scheduled_at: scheduledAt.toISOString(),
            p_increment: increment,
          });
        },
        {
          maxAttempts: 2,
          initialDelay: 500,
          backoffMultiplier: 2,
          retryableErrors: ['timeout', 'network'] as const,
        },
      );
    } catch (error) {
      structuredLog('warn', Scheduler.SERVICE_NAME, 'Failed to update time slot availability', {
        storeId,
        scheduledAt: scheduledAt.toISOString(),
        increment,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendNotification(
    storeId: string,
    postId: string | null,
    scheduleId: string | null,
    notification: NotificationData,
  ): Promise<void> {
    try {
      await retry(
        async () => {
          return await this.supabase.from('publishing_notifications').insert({
            store_id: storeId,
            post_id: postId,
            scheduled_post_id: scheduleId,
            notification_type: notification.type,
            title: notification.title,
            message: notification.message,
            severity: notification.severity,
          });
        },
        {
          maxAttempts: 2,
          initialDelay: 500,
          backoffMultiplier: 2,
          retryableErrors: ['timeout', 'network'] as const,
        },
      );
    } catch (error) {
      structuredLog('warn', Scheduler.SERVICE_NAME, 'Failed to send notification', {
        storeId,
        postId,
        scheduleId,
        notificationType: notification.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private mapConflicts(
    conflicts: ReadonlyArray<DatabaseConflictRow> | null,
    scheduledAt: Date,
  ): ReadonlyArray<ScheduleConflict> {
    if (!conflicts) return [];
    return conflicts
      .filter((c) => isConflictType(c.conflict_type) && isSeverity(c.severity))
      .map((c) => ({
        conflictId: c.conflict_id,
        conflictType: c.conflict_type as ScheduleConflict['conflictType'],
        severity: c.severity as ScheduleConflict['severity'],
        scheduledAt: new Date(scheduledAt),
        conflictingAt: c.conflicting_at ? new Date(c.conflicting_at) : undefined,
        suggestedAlternative: c.suggested_alternative ? new Date(c.suggested_alternative) : undefined,
      }));
  }
}
