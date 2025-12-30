import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import { retry } from '../utils/error-handling.ts';
import { getShopifyRateLimiter } from '../utils/rate-limiter.ts';
import { ShopifyAPI } from '../integrations/ShopifyClient.ts';
import { BrandSafety } from './BrandManager.ts';
import { GoogleSearchConsole } from '../integrations/GoogleSearchConsole.ts';
import OpenAI from 'openai';

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

export class Scheduler {
  private readonly supabase: SupabaseClient;
  private readonly openai?: OpenAI;
  private readonly brandSafety?: BrandSafety;
  private readonly rateLimiter: ReturnType<typeof getShopifyRateLimiter>;
  private static readonly DEFAULT_TIMEZONE = 'UTC';
  private static readonly DEFAULT_PRIORITY = 5;
  private static readonly MAX_RETRIES = 3;
  private static readonly PROCESSING_CONCURRENCY = 3;
  private static readonly PROCESSING_BATCH_SIZE = 50;
  private static readonly RETRY_INITIAL_DELAY = 2000;
  private static readonly RETRY_BACKOFF_MULTIPLIER = 2;

  private static readonly RETRYABLE_ERRORS: readonly string[] = [
    'rate limit',
    'timeout',
    'network',
    '500',
    '502',
    '503',
    '504',
  ];

  constructor(
    supabaseUrl: string,
    supabaseKey: string,
    openaiKey?: string,
    brandDNA?: BrandDNA,
    toneMatrix?: ToneMatrix,
  ) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.rateLimiter = getShopifyRateLimiter();
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
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
    const { data: conflicts } = await this.supabase.rpc('detect_schedule_conflicts', {
      p_store_id: storeId,
      p_scheduled_at: scheduledAt.toISOString(),
      p_post_id: postId,
      p_exclude_schedule_id: excludeScheduleId || null,
    });

    return this.mapConflicts(conflicts as ReadonlyArray<DatabaseConflictRow> | null, scheduledAt);
  }

  async processScheduledPosts(): Promise<void> {
    const now = new Date();
    const { data: duePosts, error } = await this.supabase
      .from('posts_schedule')
      .select('*, blog_posts(*), stores(*)')
      .eq('status', 'pending')
      .lte('scheduled_at', now.toISOString())
      .order('priority', { ascending: false })
      .order('scheduled_at', { ascending: true })
      .limit(Scheduler.PROCESSING_BATCH_SIZE);

    if (error || !duePosts) {
      return;
    }

    for (let i = 0; i < duePosts.length; i += Scheduler.PROCESSING_CONCURRENCY) {
      const batch = duePosts.slice(i, i + Scheduler.PROCESSING_CONCURRENCY);
      await Promise.all(batch.map((post) => this.processPost(post as DatabaseScheduleRow)));
    }
  }

  private async getPost(postId: string): Promise<DatabasePostRow | null> {
    const { data, error } = await this.supabase
      .from('blog_posts')
      .select('content, title')
      .eq('id', postId)
      .single();

    return error || !data ? null : (data as DatabasePostRow);
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
    await this.supabase.from('posts_schedule').update(updates).eq('id', scheduleId);
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

    await this.supabase.from('blog_posts').update(updates).eq('id', postId);
  }

  private async processPost(scheduledPost: DatabaseScheduleRow): Promise<void> {
    await this.updateSchedule(scheduledPost.id, { status: 'processing' });

    try {
      await retry(
        async () => {
          await this.publishPost(scheduledPost);
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
          },
        },
      );

      await Promise.all([
        this.updateSchedule(scheduledPost.id, { status: 'published' }),
        this.sendNotification(
          scheduledPost.store_id,
          scheduledPost.post_id,
          scheduledPost.id,
          {
            type: 'published',
            title: 'Post Published',
            message: `Post "${(scheduledPost.blog_posts as DatabasePostRow | null)?.title || 'Untitled'}" has been published successfully.`,
            severity: 'success',
          },
        ),
      ]);
    } catch (error) {
      const retryCount = scheduledPost.retry_count || 0;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

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
      } else {
        await this.updateSchedule(scheduledPost.id, {
          status: 'pending',
          retry_count: retryCount + 1,
        });
      }
    }
  }

  private async publishPost(scheduledPost: DatabaseScheduleRow): Promise<void> {
    const post = scheduledPost.blog_posts as DatabasePostRow | null;
    const store = scheduledPost.stores as DatabaseStoreRow | null;

    if (!post || !store) {
      throw new Error('Post or store not found');
    }

    const rateLimitCheck = await this.rateLimiter.checkRestLimit(store.shop_domain);
    if (!rateLimitCheck.allowed) {
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
        throw new Error(
          `Content validation failed: ${validation.issues.map((i) => i.message).join(', ')}`,
        );
      }
    }

    const articleData = this.buildArticleData(post, store);
    const article = await shopifyAPI.createBlogArticle(
      store.shop_domain,
      store.access_token,
      blogId,
      articleData as any,
    );

    await Promise.all([
      this.updatePostStatus(post.id, 'published', new Date().toISOString()),
      this.updateTimeSlotAvailability(store.id, new Date(scheduledPost.scheduled_at), -1),
    ]);

    if (article.id) {
      const articleUrl = `https://${store.shop_domain}/blogs/${article.id}`;
      await this.submitSitemapForPublishedArticle(store.id, articleUrl);
    }
  }

  private buildArticleData(post: DatabasePostRow, store: DatabaseStoreRow): Readonly<Record<string, unknown>> {
    let storeName = (store.shop_metadata?.name ||
      store.shop_metadata?.shop_name ||
      store.shop_domain ||
      'Authoria') as string;

    // Clean up the name similar to Dashboard logic
    if (storeName.includes('.')) {
      storeName = storeName.split('.')[0];
    }

    storeName = storeName
      .replace(/[-_]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');

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
  ): Promise<void> {
    try {
      const integration = await this.getGSCIntegration(storeId);
      if (!integration) {
        return;
      }

      const credentials = integration.credentials as {
        access_token?: string;
        site_url?: string;
        sitemap_url?: string;
      };

      if (!credentials.access_token || !credentials.site_url) {
        return;
      }

      const store = await this.getStore(storeId);
      const gsc = new GoogleSearchConsole({
        accessToken: credentials.access_token,
        siteUrl: credentials.site_url,
        timezone: store?.timezone || Scheduler.DEFAULT_TIMEZONE,
      });

      // Use saved sitemap URL if available
      if (credentials.sitemap_url) {
        const result = await gsc.submitSitemapUrl(credentials.sitemap_url);
        if (result.success) {
          return;
        }
        // If saved URL fails, fall through to detection/fallback
      }

      // Try to detect sitemap URL if not saved
      const detectedUrl = await gsc.detectSitemapUrl();
      if (detectedUrl) {
        const result = await gsc.submitSitemapUrl(detectedUrl);
        if (result.success) {
          // Save detected URL for future use
          const updatedCredentials = {
            ...credentials,
            sitemap_url: detectedUrl,
          };

          await this.supabase
            .from('analytics_integrations')
            .update({ credentials: updatedCredentials })
            .eq('store_id', storeId)
            .eq('integration_type', 'google_search_console');

          return;
        }
      }

      // Fallback: try common paths
      await gsc.submitSitemapForArticle(articleUrl);
    } catch {
      // Silently fail - sitemap submission is not critical
    }
  }

  private async getGSCIntegration(
    storeId: string,
  ): Promise<DatabaseIntegrationRow | null> {
    const { data, error } = await this.supabase
      .from('analytics_integrations')
      .select('credentials')
      .eq('store_id', storeId)
      .eq('integration_type', 'google_search_console')
      .eq('is_active', true)
      .single();

    return error || !data ? null : (data as DatabaseIntegrationRow);
  }

  private async getStore(storeId: string): Promise<DatabaseStoreRow | null> {
    const { data, error } = await this.supabase
      .from('stores')
      .select('timezone')
      .eq('id', storeId)
      .single();

    return error || !data ? null : (data as DatabaseStoreRow);
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
    } catch {
      return { passed: true, issues: [] };
    }
  }

  private async updateTimeSlotAvailability(
    storeId: string,
    scheduledAt: Date,
    increment: number,
  ): Promise<void> {
    try {
      await this.supabase.rpc('update_time_slot_availability', {
        p_store_id: storeId,
        p_scheduled_at: scheduledAt.toISOString(),
        p_increment: increment,
      });
    } catch {
    }
  }

  private async sendNotification(
    storeId: string,
    postId: string | null,
    scheduleId: string | null,
    notification: NotificationData,
  ): Promise<void> {
    try {
      await this.supabase.from('publishing_notifications').insert({
        store_id: storeId,
        post_id: postId,
        scheduled_post_id: scheduleId,
        notification_type: notification.type,
        title: notification.title,
        message: notification.message,
        severity: notification.severity,
      });
    } catch {
    }
  }

  private mapConflicts(
    conflicts: ReadonlyArray<DatabaseConflictRow> | null,
    scheduledAt: Date,
  ): ReadonlyArray<ScheduleConflict> {
    if (!conflicts) return [];
    return conflicts.map((c) => ({
      conflictId: c.conflict_id,
      conflictType: c.conflict_type as ScheduleConflict['conflictType'],
      severity: c.severity as ScheduleConflict['severity'],
      scheduledAt: new Date(scheduledAt),
      conflictingAt: c.conflicting_at ? new Date(c.conflicting_at) : undefined,
      suggestedAlternative: c.suggested_alternative ? new Date(c.suggested_alternative) : undefined,
    }));
  }

}
