import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  GoogleSearchConsole,
  SearchConsoleMetrics,
  GSCError,
  GSCErrorType,
  GoogleAnalytics4,
  GA4Metrics,
  GA4Error,
  GA4ErrorType,
} from '../integrations/GoogleServices';
import { DatabaseBatch } from '../utils/database-utils';
import { classifyError, retry, type RetryOptions } from '../utils/error-handling';

export enum AnalyticsErrorType {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INTEGRATION_NOT_CONFIGURED = 'INTEGRATION_NOT_CONFIGURED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  POST_NOT_FOUND = 'POST_NOT_FOUND',
  STORE_NOT_FOUND = 'STORE_NOT_FOUND',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  SYNC_FAILED = 'SYNC_FAILED',
  UNKNOWN = 'UNKNOWN',
}

export class AnalyticsError extends Error {
  constructor(
    public readonly type: AnalyticsErrorType,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'AnalyticsError';
  }
}

export interface PerformanceMetrics {
  readonly impressions: number;
  readonly clicks: number;
  readonly ctr: number;
  readonly position: number;
  readonly timeOnPage?: number;
  readonly scrollDepth?: number;
  readonly conversionRate?: number;
  readonly conversions?: number;
  readonly revenue?: number;
}

export interface SEOHealthScoreBreakdown {
  readonly searchPerformance: number;
  readonly userEngagement: number;
  readonly technicalSEO: number;
  readonly contentQuality: number;
}

export interface SEOHealthScoreResult {
  readonly score: number;
  readonly breakdown: SEOHealthScoreBreakdown;
  readonly recommendations: readonly string[];
}

export interface AnalyticsEvent {
  readonly storeId: string;
  readonly postId?: string | null;
  readonly eventType: 'pageview' | 'scroll' | 'click' | 'time' | 'exit' | 'conversion';
  readonly eventData?: Readonly<Record<string, unknown>>;
  readonly metadata?: {
    readonly userAgent?: string;
    readonly referrer?: string;
    readonly ipAddress?: string;
    readonly sessionId?: string;
    readonly userId?: string;
  };
  readonly timestamp?: Date;
}

export interface StoreMetricsResult {
  readonly totalImpressions: number;
  readonly totalClicks: number;
  readonly totalConversions: number;
  readonly totalRevenue: number;
  readonly avgCTR: number;
  readonly avgPosition: number;
  readonly metrics: readonly DatabaseMetricRow[];
}

export interface SyncOptions {
  readonly incremental?: boolean;
  readonly useCache?: boolean;
  readonly validateData?: boolean;
}

interface CacheEntry<T> {
  readonly data: T;
  readonly expiresAt: number;
}

interface DatabaseMetricRow {
  readonly impressions: number | null;
  readonly clicks: number | null;
  readonly ctr: number | null;
  readonly position: number | null;
  readonly time_on_page: number | null;
  readonly scroll_depth: number | null;
  readonly conversion_rate: number | null;
  readonly conversions: number | null;
  readonly revenue: number | string | null;
}

interface DatabasePostRow {
  readonly id: string;
  readonly store_id: string;
  readonly seo_title?: string | null;
  readonly seo_description?: string | null;
  readonly structured_data?: unknown;
  readonly featured_image_url?: string | null;
  readonly shopify_article_id?: string | null;
  readonly content?: string | null;
  readonly keywords?: readonly string[] | null;
}

interface DatabaseEventRow {
  readonly event_type: string;
  readonly event_data?: {
    readonly scrollDepth?: string;
    readonly timeOnPage?: string;
  } | null;
}

interface BatchMetricItem {
  readonly postId: string;
  readonly storeId: string;
  readonly metrics: PerformanceMetrics;
  readonly source?: string;
  readonly date?: Date;
}

interface BatchEventItem {
  readonly storeId: string;
  readonly postId: string | null;
  readonly eventType: 'pageview' | 'scroll' | 'click' | 'time' | 'exit' | 'conversion';
  readonly eventData: Readonly<Record<string, unknown>>;
  readonly metadata?: EventMetadata;
}

interface EventMetadata {
  readonly userAgent?: string;
  readonly referrer?: string;
  readonly ipAddress?: string;
}

interface IntegrationCredentials {
  readonly access_token: string;
  readonly site_url: string;
  readonly property_id?: string;
  readonly refresh_token?: string;
  readonly expires_at?: string;
  readonly sitemap_url?: string;
}

interface IntegrationData {
  readonly credentials: IntegrationCredentials;
}

type IntegrationType = 'google_search_console' | 'google_analytics_4';

interface StoreData {
  readonly timezone?: string | null;
}

interface PostData {
  readonly shopify_article_id?: string | null;
}

interface EventData {
  readonly pageviews: number;
  readonly scrollEvents: readonly DatabaseEventRow[];
  readonly timeEvents: readonly DatabaseEventRow[];
}

interface Logger {
  readonly info: (message: string, context?: Readonly<Record<string, unknown>>) => void;
  readonly warn: (message: string, context?: Readonly<Record<string, unknown>>) => void;
  readonly error: (message: string, context?: Readonly<Record<string, unknown>>) => void;
}

const SERVICE_NAME = 'Analytics';

const structuredLog = (
  level: 'info' | 'warn' | 'error',
  service: string,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): void => {
  const logEntry = {
    level,
    service,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  };
  const output = JSON.stringify(logEntry);
  if (typeof globalThis !== 'undefined' && 'Deno' in globalThis) {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(output + '\n');
      if (level === 'error') {
        (globalThis as unknown as { Deno: { stderr: { writeSync: (data: Uint8Array) => void } } }).Deno.stderr.writeSync(data);
      } else {
        (globalThis as unknown as { Deno: { stdout: { writeSync: (data: Uint8Array) => void } } }).Deno.stdout.writeSync(data);
      }
    } catch {
    }
  }
};

const createStructuredLogger = (service: string): Logger => ({
  info: (message: string, context?: Readonly<Record<string, unknown>>): void => {
    structuredLog('info', service, message, context);
  },
  warn: (message: string, context?: Readonly<Record<string, unknown>>): void => {
    structuredLog('warn', service, message, context);
  },
  error: (message: string, context?: Readonly<Record<string, unknown>>): void => {
    structuredLog('error', service, message, context);
  },
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 365;
const MIN_DAYS = 1;
const MAX_BATCH_SIZE = 1000;
const MAX_EVENT_DATA_SIZE = 10000;
const MAX_METADATA_FIELD_LENGTH = 500;

const validateUUID = (id: string, fieldName: string): void => {
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    throw new AnalyticsError(
      AnalyticsErrorType.VALIDATION_ERROR,
      `Invalid ${fieldName}: must be a non-empty string`,
      { [fieldName]: id },
    );
  }
  if (!UUID_REGEX.test(id.trim())) {
    throw new AnalyticsError(
      AnalyticsErrorType.VALIDATION_ERROR,
      `Invalid ${fieldName}: must be a valid UUID`,
      { [fieldName]: id },
    );
  }
};

const validateDateString = (date: string, fieldName: string): void => {
  if (!date || typeof date !== 'string' || date.trim().length === 0) {
    throw new AnalyticsError(
      AnalyticsErrorType.VALIDATION_ERROR,
      `Invalid ${fieldName}: must be a non-empty string`,
      { [fieldName]: date },
    );
  }
  if (!DATE_REGEX.test(date.trim())) {
    throw new AnalyticsError(
      AnalyticsErrorType.VALIDATION_ERROR,
      `Invalid ${fieldName}: must be in YYYY-MM-DD format`,
      { [fieldName]: date },
    );
  }
};

const validatePositiveNumber = (value: number, fieldName: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new AnalyticsError(
      AnalyticsErrorType.VALIDATION_ERROR,
      `Invalid ${fieldName}: must be a positive number`,
      { [fieldName]: value },
    );
  }
};

const validateDays = (days: number): void => {
  validatePositiveNumber(days, 'days');
  if (days < MIN_DAYS || days > MAX_DAYS) {
    throw new AnalyticsError(
      AnalyticsErrorType.VALIDATION_ERROR,
      `Invalid days: must be between ${MIN_DAYS} and ${MAX_DAYS}`,
      { days },
    );
  }
};

const validateSupabaseUrl = (url: string): void => {
  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    throw new AnalyticsError(
      AnalyticsErrorType.VALIDATION_ERROR,
      'Supabase URL is required',
    );
  }
  try {
    new URL(url);
  } catch {
    throw new AnalyticsError(
      AnalyticsErrorType.VALIDATION_ERROR,
      'Invalid Supabase URL format',
    );
  }
};

const validateSupabaseKey = (key: string): void => {
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    throw new AnalyticsError(
      AnalyticsErrorType.VALIDATION_ERROR,
      'Supabase key is required',
    );
  }
};

const validateEventData = (eventData: Readonly<Record<string, unknown>> | undefined): void => {
  if (eventData === undefined) {
    return;
  }
  try {
    const serialized = JSON.stringify(eventData);
    if (serialized.length > MAX_EVENT_DATA_SIZE) {
      throw new AnalyticsError(
        AnalyticsErrorType.VALIDATION_ERROR,
        `Event data too large: max ${MAX_EVENT_DATA_SIZE} bytes`,
      );
    }
  } catch {
    throw new AnalyticsError(
      AnalyticsErrorType.VALIDATION_ERROR,
      'Invalid event data: must be serializable JSON',
    );
  }
};

const validateMetadata = (metadata: AnalyticsEvent['metadata']): void => {
  if (!metadata) {
    return;
  }
  if (metadata.userAgent && typeof metadata.userAgent === 'string' && metadata.userAgent.length > MAX_METADATA_FIELD_LENGTH) {
    throw new AnalyticsError(
      AnalyticsErrorType.VALIDATION_ERROR,
      `User agent too long: max ${MAX_METADATA_FIELD_LENGTH} characters`,
    );
  }
  if (metadata.referrer && typeof metadata.referrer === 'string' && metadata.referrer.length > MAX_METADATA_FIELD_LENGTH) {
    throw new AnalyticsError(
      AnalyticsErrorType.VALIDATION_ERROR,
      `Referrer too long: max ${MAX_METADATA_FIELD_LENGTH} characters`,
    );
  }
  if (metadata.ipAddress && typeof metadata.ipAddress === 'string' && metadata.ipAddress.length > MAX_METADATA_FIELD_LENGTH) {
    throw new AnalyticsError(
      AnalyticsErrorType.VALIDATION_ERROR,
      `IP address too long: max ${MAX_METADATA_FIELD_LENGTH} characters`,
    );
  }
};

const isIntegrationType = (type: string): type is IntegrationType => {
  return type === 'google_search_console' || type === 'google_analytics_4';
};

const isEventType = (type: string): type is AnalyticsEvent['eventType'] => {
  return ['pageview', 'scroll', 'click', 'time', 'exit', 'conversion'].includes(type);
};

const isIntegrationCredentials = (credentials: unknown): credentials is IntegrationCredentials => {
  return (
    credentials !== null &&
    typeof credentials === 'object' &&
    'access_token' in credentials &&
    typeof (credentials as IntegrationCredentials).access_token === 'string' &&
    'site_url' in credentials &&
    typeof (credentials as IntegrationCredentials).site_url === 'string'
  );
};

export class AnalyticsCollector {
  private readonly supabase: SupabaseClient;
  private readonly cache: Map<string, CacheEntry<unknown>> = new Map();
  private readonly logger: Logger;
  private cleanupTimerId: ReturnType<typeof setInterval> | null = null;
  private static readonly CACHE_TTL = 300000;
  private static readonly DEFAULT_DAYS = 30;
  private static readonly DEFAULT_SOURCE = 'google';
  private static readonly DATE_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  private static readonly TOKEN_BUFFER_MS = 5 * 60 * 1000;
  private static readonly MAX_CACHE_SIZE = 1000;
  private static readonly CACHE_CLEANUP_INTERVAL = 60000;
  private static readonly RETRY_OPTIONS: RetryOptions = {
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    strategy: 'exponential',
    jitter: true,
  } as const;
  private static readonly GSC_RATE_LIMIT_DELAY = 200;
  private static readonly GA4_RATE_LIMIT_DELAY = 100;
  private static readonly MAX_RETRIES = 3;
  private static readonly DEFAULT_TIMEZONE = 'UTC';
  private static readonly SEO_SCORE_MAX = 25;
  private static readonly SEO_SCORE_TOTAL_MAX = 100;

  constructor(supabaseUrl: string, supabaseKey: string) {
    validateSupabaseUrl(supabaseUrl);
    validateSupabaseKey(supabaseKey);
    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.logger = createStructuredLogger('AnalyticsCollector');
    this.startCacheCleanup();
  }

  destroy(): void {
    if (this.cleanupTimerId !== null) {
      clearInterval(this.cleanupTimerId);
      this.cleanupTimerId = null;
    }
    this.cache.clear();
  }

  private startCacheCleanup(): void {
    this.cleanupTimerId = setInterval(() => {
      this.cleanupExpiredCache();
    }, AnalyticsCollector.CACHE_CLEANUP_INTERVAL);
  }

  private cleanupExpiredCache(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }

  async recordBatchMetrics(metrics: readonly BatchMetricItem[]): Promise<void> {
    if (metrics.length === 0) {
      return;
    }
    if (metrics.length > MAX_BATCH_SIZE) {
      throw new AnalyticsError(
        AnalyticsErrorType.VALIDATION_ERROR,
        `Batch size exceeds maximum: ${MAX_BATCH_SIZE}`,
        { batchSize: metrics.length },
      );
    }

    for (const item of metrics) {
      validateUUID(item.storeId, 'storeId');
      validateUUID(item.postId, 'postId');
    }

    const batch = new DatabaseBatch(this.supabase as unknown as { from: (table: string) => { select: (fields?: string) => { eq: (key: string, value: unknown) => { gte: (key: string, value: unknown) => { order: (field: string, opts: { ascending: boolean }) => Promise<{ data: unknown[] | null; error: unknown }> } } }; update: (data: unknown) => { eq: (key: string, value: unknown) => Promise<{ data: unknown; error: unknown }> }; insert: (data: unknown) => Promise<{ data: unknown; error: unknown }>; upsert: (data: unknown) => Promise<{ data: unknown; error: unknown }>; delete: () => { eq: (key: string, value: unknown) => Promise<{ data: unknown; error: unknown }> } } } as never);

    for (const item of metrics) {
      batch.add({
        type: 'upsert',
        table: 'analytics',
        data: {
          store_id: item.storeId,
          post_id: item.postId,
          event_type: 'performance_metric',
          metric_date: this.formatDate(item.date ?? new Date()),
          timestamp: new Date().toISOString(),
          impressions: item.metrics.impressions,
          clicks: item.metrics.clicks,
          ctr: item.metrics.ctr,
          position: item.metrics.position,
          time_on_page: item.metrics.timeOnPage,
          scroll_depth: item.metrics.scrollDepth,
          conversion_rate: item.metrics.conversionRate,
          conversions: item.metrics.conversions,
          revenue: item.metrics.revenue,
          source: item.source ?? AnalyticsCollector.DEFAULT_SOURCE,
        },
      });
    }

    try {
      await retry(
        async () => {
          await batch.execute();
        },
        {
          ...AnalyticsCollector.RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            this.logger.warn('Retrying batch metrics record', {
              attempt,
              batchSize: metrics.length,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );
    } catch (error) {
      this.logger.error('Failed to record batch metrics', {
        batchSize: metrics.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.classifyDatabaseError(error, 'recordBatchMetrics', { batchSize: metrics.length });
    }
  }

  async getPostMetrics(
    postId: string,
    days: number = AnalyticsCollector.DEFAULT_DAYS,
  ): Promise<readonly PerformanceMetrics[]> {
    validateUUID(postId, 'postId');
    validateDays(days);

    const cacheKey = `post_metrics_${postId}_${days}`;
    const cached = this.getCached<readonly PerformanceMetrics[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const startDate = this.getDateDaysAgo(days);

    try {
      const { data, error } = await retry(
        async () => {
          return await this.supabase
            .from('performance_metrics')
            .select('impressions,clicks,ctr,position,time_on_page,scroll_depth,conversion_rate,conversions,revenue')
            .eq('post_id', postId)
            .gte('metric_date', this.formatDate(startDate))
            .order('metric_date', { ascending: true });
        },
        {
          ...AnalyticsCollector.RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            this.logger.warn('Retrying getPostMetrics', {
              attempt,
              postId,
              days,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error) {
        throw this.classifyDatabaseError(error, 'getPostMetrics', { postId, days });
      }

      const result = this.mapMetricsToPerformance((data ?? []) as readonly DatabaseMetricRow[]);
      this.setCached(cacheKey, result);
      return result;
    } catch (error) {
      this.logger.error('Failed to get post metrics', {
        postId,
        days,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getStoreMetrics(
    storeId: string,
    days: number = AnalyticsCollector.DEFAULT_DAYS,
  ): Promise<StoreMetricsResult> {
    validateUUID(storeId, 'storeId');
    validateDays(days);

    const cacheKey = `store_metrics_${storeId}_${days}`;
    const cached = this.getCached<StoreMetricsResult>(cacheKey);
    if (cached) {
      return cached;
    }

    const startDate = this.getDateDaysAgo(days);

    try {
      const { data, error } = await retry(
        async () => {
          return await this.supabase
            .from('performance_metrics')
            .select('impressions,clicks,ctr,position,time_on_page,scroll_depth,conversion_rate,conversions,revenue')
            .eq('store_id', storeId)
            .gte('metric_date', this.formatDate(startDate));
        },
        {
          ...AnalyticsCollector.RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            this.logger.warn('Retrying getStoreMetrics', {
              attempt,
              storeId,
              days,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error) {
        throw this.classifyDatabaseError(error, 'getStoreMetrics', { storeId, days });
      }

      const metricRows = (data ?? []) as readonly DatabaseMetricRow[];
      const result = this.calculateStoreMetrics(metricRows);
      this.setCached(cacheKey, result);
      return result;
    } catch (error) {
      this.logger.error('Failed to get store metrics', {
        storeId,
        days,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async calculateAdvancedSEOHealthScore(postId: string): Promise<SEOHealthScoreResult> {
    validateUUID(postId, 'postId');

    const startTime = Date.now();

    try {
      const [postRow, metrics, eventData] = await Promise.all([
        this.getPostRow(postId),
        this.getPostMetrics(postId, AnalyticsCollector.DEFAULT_DAYS),
        this.getEventData(postId),
      ]);

      const avgPosition = this.calculateAverage(metrics, (m) => m.position ?? 100);
      const avgCTR = this.calculateAverage(metrics, (m) => m.ctr ?? 0);
      const avgScrollDepth = this.calculateAverageScrollDepth(eventData.scrollEvents);
      const avgTimeOnPage = this.calculateAverageTimeOnPage(eventData.timeEvents);
      const pageviews = eventData.pageviews;

      const breakdown: SEOHealthScoreBreakdown = {
        searchPerformance: this.calculateSearchPerformanceScore(avgPosition, avgCTR),
        userEngagement: this.calculateUserEngagementScore(avgScrollDepth, avgTimeOnPage, pageviews),
        technicalSEO: this.calculateTechnicalSEOScore(postRow),
        contentQuality: this.calculateContentQualityScore(postRow),
      } as const;

      const totalScore = Math.min(
        AnalyticsCollector.SEO_SCORE_TOTAL_MAX,
        Object.values(breakdown).reduce((sum, score) => sum + score, 0),
      );
      const recommendations = this.generateRecommendations(breakdown, postRow, metrics);

      await Promise.all([
        retry(
          async () => {
            const { error } = await this.supabase.from('seo_health_scores').insert({
              post_id: postId,
              store_id: postRow.store_id,
              score: totalScore,
              score_breakdown: breakdown,
              recommendations,
            });
            if (error) {
              throw error;
            }
          },
          AnalyticsCollector.RETRY_OPTIONS,
        ),
        retry(
          async () => {
            const { error } = await this.supabase
              .from('blog_posts')
              .update({ seo_health_score: totalScore })
              .eq('id', postId);
            if (error) {
              throw error;
            }
          },
          AnalyticsCollector.RETRY_OPTIONS,
        ),
      ]);

      const duration = Date.now() - startTime;
      this.logger.info('SEO health score calculated', {
        postId,
        score: totalScore,
        duration,
      });

      return {
        score: totalScore,
        breakdown,
        recommendations,
      } as const;
    } catch (error) {
      this.logger.error('Failed to calculate SEO health score', {
        postId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async syncGoogleSearchConsole(
    storeId: string,
    postId: string,
    startDate: string,
    endDate: string,
    options?: SyncOptions,
  ): Promise<void> {
    validateUUID(storeId, 'storeId');
    validateUUID(postId, 'postId');
    validateDateString(startDate, 'startDate');
    validateDateString(endDate, 'endDate');

    const { incremental = true, useCache = true } = options ?? {};

    const startTime = Date.now();

    try {
      const [integration, store, post] = await Promise.all([
        this.getIntegration(storeId, 'google_search_console'),
        this.getStore(storeId),
        this.getPost(postId),
      ]);

      if (!post.shopify_article_id) {
        throw new AnalyticsError(
          AnalyticsErrorType.POST_NOT_FOUND,
          'Post not found or missing shopify_article_id',
          { postId },
        );
      }

      const gsc = new GoogleSearchConsole({
        accessToken: integration.credentials.access_token,
        siteUrl: integration.credentials.site_url,
        timezone: store?.timezone ?? AnalyticsCollector.DEFAULT_TIMEZONE,
        enableCaching: useCache,
        cacheTTL: AnalyticsCollector.CACHE_TTL,
        rateLimitDelay: AnalyticsCollector.GSC_RATE_LIMIT_DELAY,
        maxRetries: AnalyticsCollector.MAX_RETRIES,
      });

      await this.ensureSitemapUrlDetected(storeId, integration, gsc);

      const gscMetrics = await gsc.getPageMetrics(
        `/blogs/${post.shopify_article_id}`,
        startDate,
        endDate,
        { useCache, incremental },
      );

      const metricsToRecord = this.mapGSCMetricsToBatchItems(gscMetrics, postId, storeId);
      await this.recordBatchMetrics(metricsToRecord);
      await this.updateLastSyncTime(storeId, 'google_search_console');

      const duration = Date.now() - startTime;
      this.logger.info('GSC sync completed', {
        storeId,
        postId,
        metricsCount: metricsToRecord.length,
        duration,
      });
    } catch (error) {
      if (error instanceof GSCError) {
        await this.handleGSCError(error, storeId);
      }
      this.logger.error('GSC sync failed', {
        storeId,
        postId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async syncGoogleAnalytics4(
    storeId: string,
    postId: string,
    startDate: string,
    endDate: string,
    options?: SyncOptions,
  ): Promise<void> {
    validateUUID(storeId, 'storeId');
    validateUUID(postId, 'postId');
    validateDateString(startDate, 'startDate');
    validateDateString(endDate, 'endDate');

    const { incremental = true, useCache = true } = options ?? {};

    const startTime = Date.now();

    try {
      const [integration, store, post] = await Promise.all([
        this.getIntegration(storeId, 'google_analytics_4'),
        this.getStore(storeId),
        this.getPost(postId),
      ]);

      if (!post.shopify_article_id) {
        throw new AnalyticsError(
          AnalyticsErrorType.POST_NOT_FOUND,
          'Post not found or missing shopify_article_id',
          { postId },
        );
      }

      if (!integration.credentials.property_id) {
        throw new AnalyticsError(
          AnalyticsErrorType.INTEGRATION_NOT_CONFIGURED,
          'GA4 property ID not configured',
          { storeId },
        );
      }

      const ga4 = new GoogleAnalytics4({
        accessToken: integration.credentials.access_token,
        propertyId: integration.credentials.property_id,
        timezone: store?.timezone ?? AnalyticsCollector.DEFAULT_TIMEZONE,
        enableCaching: useCache,
        cacheTTL: AnalyticsCollector.CACHE_TTL,
        rateLimitDelay: AnalyticsCollector.GA4_RATE_LIMIT_DELAY,
        maxRetries: AnalyticsCollector.MAX_RETRIES,
      });

      const ga4Metrics = await ga4.getPageMetrics(
        `/blogs/${post.shopify_article_id}`,
        startDate,
        endDate,
        { useCache, incremental },
      );

      const metricsToRecord = this.mapGA4MetricsToBatchItems(ga4Metrics, postId, storeId);
      await this.recordBatchMetrics(metricsToRecord);
      await this.updateLastSyncTime(storeId, 'google_analytics_4');

      const duration = Date.now() - startTime;
      this.logger.info('GA4 sync completed', {
        storeId,
        postId,
        metricsCount: metricsToRecord.length,
        duration,
      });
    } catch (error) {
      if (error instanceof GA4Error) {
        await this.handleGA4Error(error, storeId);
      }
      this.logger.error('GA4 sync failed', {
        storeId,
        postId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async recordBatchEvents(events: readonly BatchEventItem[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    if (events.length > MAX_BATCH_SIZE) {
      throw new AnalyticsError(
        AnalyticsErrorType.VALIDATION_ERROR,
        `Batch size exceeds maximum: ${MAX_BATCH_SIZE}`,
        { batchSize: events.length },
      );
    }

    for (const event of events) {
      validateUUID(event.storeId, 'storeId');
      if (event.postId) {
        validateUUID(event.postId, 'postId');
      }
      if (!isEventType(event.eventType)) {
        throw new AnalyticsError(
          AnalyticsErrorType.VALIDATION_ERROR,
          `Invalid event type: ${event.eventType}`,
          { eventType: event.eventType },
        );
      }
    }

    const batch = new DatabaseBatch(this.supabase as unknown as { from: (table: string) => { select: (fields?: string) => { eq: (key: string, value: unknown) => { gte: (key: string, value: unknown) => { order: (field: string, opts: { ascending: boolean }) => Promise<{ data: unknown[] | null; error: unknown }> } } }; update: (data: unknown) => { eq: (key: string, value: unknown) => Promise<{ data: unknown; error: unknown }> }; insert: (data: unknown) => Promise<{ data: unknown; error: unknown }>; upsert: (data: unknown) => Promise<{ data: unknown; error: unknown }>; delete: () => { eq: (key: string, value: unknown) => Promise<{ data: unknown; error: unknown }> } } } as never);

    for (const event of events) {
      batch.add({
        type: 'insert',
        table: 'analytics_events',
        data: {
          store_id: event.storeId,
          post_id: event.postId,
          event_type: event.eventType,
          event_data: event.eventData,
          user_agent: event.metadata?.userAgent,
          referrer: event.metadata?.referrer,
          ip_address: event.metadata?.ipAddress,
        },
      });
    }

    try {
      await retry(
        async () => {
          await batch.execute();
        },
        {
          ...AnalyticsCollector.RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            this.logger.warn('Retrying batch events record', {
              attempt,
              batchSize: events.length,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );
    } catch (error) {
      this.logger.error('Failed to record batch events', {
        batchSize: events.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.classifyDatabaseError(error, 'recordBatchEvents', { batchSize: events.length });
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  private calculateSearchPerformanceScore(avgPosition: number, avgCTR: number): number {
    let score = 0;

    if (avgPosition <= 3) {
      score += 15;
    } else if (avgPosition <= 10) {
      score += 12;
    } else if (avgPosition <= 20) {
      score += 8;
    } else if (avgPosition <= 50) {
      score += 4;
    }

    if (avgCTR >= 0.05) {
      score += 10;
    } else if (avgCTR >= 0.03) {
      score += 7;
    } else if (avgCTR >= 0.01) {
      score += 4;
    } else if (avgCTR > 0) {
      score += 2;
    }

    return Math.min(AnalyticsCollector.SEO_SCORE_MAX, score);
  }

  private calculateUserEngagementScore(
    avgScrollDepth: number,
    avgTimeOnPage: number,
    pageviews: number,
  ): number {
    let score = 0;

    if (avgScrollDepth >= 0.9) {
      score += 10;
    } else if (avgScrollDepth >= 0.7) {
      score += 7;
    } else if (avgScrollDepth >= 0.5) {
      score += 5;
    } else if (avgScrollDepth > 0) {
      score += 2;
    }

    if (avgTimeOnPage >= 180) {
      score += 10;
    } else if (avgTimeOnPage >= 120) {
      score += 7;
    } else if (avgTimeOnPage >= 60) {
      score += 5;
    } else if (avgTimeOnPage > 0) {
      score += 2;
    }

    if (pageviews >= 1000) {
      score += 5;
    } else if (pageviews >= 500) {
      score += 3;
    } else if (pageviews >= 100) {
      score += 2;
    } else if (pageviews > 0) {
      score += 1;
    }

    return Math.min(AnalyticsCollector.SEO_SCORE_MAX, score);
  }

  private calculateTechnicalSEOScore(post: DatabasePostRow): number {
    let score = 0;

    if (post.seo_title && post.seo_title.length >= 50 && post.seo_title.length <= 60) {
      score += 5;
    } else if (post.seo_title && post.seo_title.length > 0) {
      score += 3;
    }

    if (
      post.seo_description &&
      post.seo_description.length >= 150 &&
      post.seo_description.length <= 160
    ) {
      score += 5;
    } else if (post.seo_description && post.seo_description.length > 0) {
      score += 3;
    }

    if (post.structured_data) {
      score += 5;
    }
    if (post.featured_image_url) {
      score += 5;
    }
    if (post.shopify_article_id) {
      score += 5;
    }

    return Math.min(AnalyticsCollector.SEO_SCORE_MAX, score);
  }

  private calculateContentQualityScore(post: DatabasePostRow): number {
    let score = 0;
    const wordCount = post.content?.split(/\s+/).length ?? 0;

    if (wordCount >= 2000) {
      score += 10;
    } else if (wordCount >= 1500) {
      score += 8;
    } else if (wordCount >= 1000) {
      score += 6;
    } else if (wordCount >= 500) {
      score += 4;
    } else if (wordCount > 0) {
      score += 2;
    }

    const headingCount = (post.content?.match(/^#+\s/gm) ?? []).length;
    if (headingCount >= 5) {
      score += 5;
    } else if (headingCount >= 3) {
      score += 3;
    } else if (headingCount > 0) {
      score += 2;
    }

    if (post.keywords && post.keywords.length > 0) {
      score += 5;
    }

    if (wordCount > 0 && post.content) {
      const sentences = post.content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
      const avgSentenceLength = sentences.length > 0 ? wordCount / sentences.length : 0;
      if (avgSentenceLength > 0 && avgSentenceLength < 20) {
        score += 5;
      } else {
        score += 3;
      }
    }

    return Math.min(AnalyticsCollector.SEO_SCORE_MAX, score);
  }

  private generateRecommendations(
    breakdown: SEOHealthScoreBreakdown,
    post: DatabasePostRow,
    metrics: readonly PerformanceMetrics[],
  ): readonly string[] {
    const recommendations: string[] = [];

    if (breakdown.searchPerformance < 15) {
      recommendations.push('Improve search rankings by optimizing for target keywords and building backlinks');
    }

    if (breakdown.userEngagement < 15) {
      recommendations.push('Increase user engagement by improving content quality and adding interactive elements');
    }

    if (breakdown.technicalSEO < 15) {
      if (!post.seo_title || post.seo_title.length < 50) {
        recommendations.push('Add or optimize meta title (50-60 characters recommended)');
      }
      if (!post.seo_description || post.seo_description.length < 150) {
        recommendations.push('Add or optimize meta description (150-160 characters recommended)');
      }
      if (!post.structured_data) {
        recommendations.push('Add structured data (JSON-LD) to improve rich snippets');
      }
    }

    if (breakdown.contentQuality < 15) {
      const wordCount = post.content?.split(/\s+/).length ?? 0;
      if (wordCount < 1000) {
        recommendations.push('Increase content length to at least 1000 words for better SEO');
      }
    }

    if (metrics.length === 0) {
      recommendations.push('No performance data available yet. Wait for analytics data to accumulate');
    }

    return recommendations as readonly string[];
  }

  private getCached<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) {
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  private setCached<T>(key: string, data: T): void {
    if (this.cache.size >= AnalyticsCollector.MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      data,
      expiresAt: Date.now() + AnalyticsCollector.CACHE_TTL,
    });
  }

  private async getIntegration(
    storeId: string,
    integrationType: IntegrationType,
  ): Promise<IntegrationData> {
    try {
      const { data: integration, error } = await retry(
        async () => {
          return await this.supabase
            .from('analytics_integrations')
            .select('credentials')
            .eq('store_id', storeId)
            .eq('integration_type', integrationType)
            .eq('is_active', true)
            .single();
        },
        {
          ...AnalyticsCollector.RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            this.logger.warn('Retrying getIntegration', {
              attempt,
              storeId,
              integrationType,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error || !integration) {
        throw new AnalyticsError(
          AnalyticsErrorType.INTEGRATION_NOT_CONFIGURED,
          `${integrationType} integration not configured`,
          { storeId, integrationType },
        );
      }

      if (!isIntegrationCredentials(integration.credentials)) {
        throw new AnalyticsError(
          AnalyticsErrorType.INTEGRATION_NOT_CONFIGURED,
          `Invalid credentials format for ${integrationType}`,
          { storeId, integrationType },
        );
      }

      const credentials = integration.credentials;

      if (
        credentials.access_token &&
        credentials.expires_at &&
        credentials.refresh_token
      ) {
        const expiresAt = new Date(credentials.expires_at);
        const now = new Date();

        if (expiresAt.getTime() - now.getTime() < AnalyticsCollector.TOKEN_BUFFER_MS) {
          try {
            const refreshedToken = await this.getValidAccessToken(storeId, integrationType);

            if (refreshedToken) {
              const { data: updatedIntegration } = await retry(
                async () => {
                  return await this.supabase
                    .from('analytics_integrations')
                    .select('credentials')
                    .eq('store_id', storeId)
                    .eq('integration_type', integrationType)
                    .single();
                },
                AnalyticsCollector.RETRY_OPTIONS,
              );

              if (updatedIntegration && isIntegrationCredentials(updatedIntegration.credentials)) {
                const updatedCreds = updatedIntegration.credentials;
                return {
                  credentials: {
                    access_token: refreshedToken,
                    property_id: updatedCreds.property_id ?? credentials.property_id,
                    site_url: updatedCreds.site_url ?? credentials.site_url ?? '',
                  },
                };
              }
            }
          } catch (refreshError) {
            this.logger.error('Token refresh failed', {
              storeId,
              integrationType,
              error: refreshError instanceof Error ? refreshError.message : String(refreshError),
            });
          }
        }
      }

      if (!credentials.access_token) {
        throw new AnalyticsError(
          AnalyticsErrorType.TOKEN_EXPIRED,
          `No access token available for ${integrationType}. Please reconnect.`,
          { storeId, integrationType },
        );
      }

      return {
        credentials: {
          access_token: credentials.access_token,
          property_id: credentials.property_id,
          site_url: credentials.site_url ?? '',
        },
      };
    } catch (error) {
      if (error instanceof AnalyticsError) {
        throw error;
      }
      this.logger.error('Failed to get integration', {
        storeId,
        integrationType,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AnalyticsError(
        AnalyticsErrorType.INTEGRATION_NOT_CONFIGURED,
        `Failed to get ${integrationType} integration`,
        { storeId, integrationType },
      );
    }
  }

  private async getValidAccessToken(
    storeId: string,
    integrationType: IntegrationType,
  ): Promise<string | null> {
    try {
      const { data: integration } = await retry(
        async () => {
          return await this.supabase
            .from('analytics_integrations')
            .select('credentials')
            .eq('store_id', storeId)
            .eq('integration_type', integrationType)
            .single();
        },
        AnalyticsCollector.RETRY_OPTIONS,
      );

      if (!integration || !isIntegrationCredentials(integration.credentials)) {
        return null;
      }

      const credentials = integration.credentials;

      if (!credentials.access_token) {
        return null;
      }

      const expiresAt = credentials.expires_at ? new Date(credentials.expires_at) : null;
      const now = new Date();

      if (expiresAt && expiresAt.getTime() - now.getTime() >= AnalyticsCollector.TOKEN_BUFFER_MS) {
        return credentials.access_token;
      }

      return credentials.access_token;
    } catch {
      return null;
    }
  }

  private async getStore(storeId: string): Promise<StoreData | null> {
    try {
      const { data: store } = await retry(
        async () => {
          return await this.supabase
            .from('stores')
            .select('timezone')
            .eq('id', storeId)
            .single();
        },
        AnalyticsCollector.RETRY_OPTIONS,
      );

      return store;
    } catch {
      return null;
    }
  }

  private async getPost(postId: string): Promise<PostData> {
    try {
      const { data: post, error } = await retry(
        async () => {
          return await this.supabase
            .from('blog_posts')
            .select('shopify_article_id')
            .eq('id', postId)
            .single();
        },
        {
          ...AnalyticsCollector.RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            this.logger.warn('Retrying getPost', {
              attempt,
              postId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error || !post) {
        throw new AnalyticsError(
          AnalyticsErrorType.POST_NOT_FOUND,
          'Post not found',
          { postId },
        );
      }

      return post;
    } catch (error) {
      if (error instanceof AnalyticsError) {
        throw error;
      }
      this.logger.error('Failed to get post', {
        postId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AnalyticsError(
        AnalyticsErrorType.POST_NOT_FOUND,
        'Post not found',
        { postId },
      );
    }
  }

  private async getPostRow(postId: string): Promise<DatabasePostRow> {
    try {
      const { data: post, error } = await retry(
        async () => {
          return await this.supabase
            .from('blog_posts')
            .select(
              'id,store_id,seo_title,seo_description,structured_data,featured_image_url,shopify_article_id,content,keywords',
            )
            .eq('id', postId)
            .single();
        },
        {
          ...AnalyticsCollector.RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            this.logger.warn('Retrying getPostRow', {
              attempt,
              postId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error || !post) {
        throw new AnalyticsError(
          AnalyticsErrorType.POST_NOT_FOUND,
          `Post not found: ${postId}`,
          { postId },
        );
      }

      return post as DatabasePostRow;
    } catch (error) {
      if (error instanceof AnalyticsError) {
        throw error;
      }
      this.logger.error('Failed to get post row', {
        postId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AnalyticsError(
        AnalyticsErrorType.POST_NOT_FOUND,
        `Post not found: ${postId}`,
        { postId },
      );
    }
  }

  private async updateLastSyncTime(storeId: string, integrationType: IntegrationType): Promise<void> {
    try {
      await retry(
        async () => {
          const { error } = await this.supabase
            .from('analytics_integrations')
            .update({ last_sync_at: new Date().toISOString() })
            .eq('store_id', storeId)
            .eq('integration_type', integrationType);
          if (error) {
            throw error;
          }
        },
        AnalyticsCollector.RETRY_OPTIONS,
      );
    } catch (error) {
      this.logger.warn('Failed to update last sync time', {
        storeId,
        integrationType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureSitemapUrlDetected(
    storeId: string,
    integration: IntegrationData,
    gsc: GoogleSearchConsole,
  ): Promise<void> {
    const credentials = integration.credentials;

    if (credentials.sitemap_url) {
      return;
    }

    try {
      const sitemapUrl = await gsc.detectSitemapUrl();

      if (sitemapUrl) {
        const updatedCredentials = {
          ...credentials,
          sitemap_url: sitemapUrl,
        };

        await retry(
          async () => {
            const { error } = await this.supabase
              .from('analytics_integrations')
              .update({ credentials: updatedCredentials })
              .eq('store_id', storeId)
              .eq('integration_type', 'google_search_console');
            if (error) {
              throw error;
            }
          },
          AnalyticsCollector.RETRY_OPTIONS,
        );
      }
    } catch (error) {
      this.logger.warn('Failed to detect sitemap URL for GSC integration', {
        storeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleGSCError(error: GSCError, storeId: string): Promise<void> {
    switch (error.type) {
      case GSCErrorType.QUOTA_EXCEEDED:
        throw new AnalyticsError(
          AnalyticsErrorType.QUOTA_EXCEEDED,
          'GSC quota exceeded. Please try again later.',
          { storeId },
          true,
        );
      case GSCErrorType.AUTHENTICATION_FAILED:
        try {
          await retry(
            async () => {
              const { error: updateError } = await this.supabase
                .from('analytics_integrations')
                .update({ is_active: false })
                .eq('store_id', storeId)
                .eq('integration_type', 'google_search_console');
              if (updateError) {
                throw updateError;
              }
            },
            AnalyticsCollector.RETRY_OPTIONS,
          );
        } catch {
        }
        throw new AnalyticsError(
          AnalyticsErrorType.AUTHENTICATION_FAILED,
          'GSC authentication failed. Please reconnect your Google Search Console account.',
          { storeId },
        );
      case GSCErrorType.INVALID_SITE:
        throw new AnalyticsError(
          AnalyticsErrorType.VALIDATION_ERROR,
          'Invalid GSC site. Please check your site URL.',
          { storeId },
        );
      case GSCErrorType.PERMISSION_DENIED:
        throw new AnalyticsError(
          AnalyticsErrorType.PERMISSION_DENIED,
          'Permission denied. Please check your GSC permissions.',
          { storeId },
        );
      case GSCErrorType.RATE_LIMIT_EXCEEDED:
        throw new AnalyticsError(
          AnalyticsErrorType.RATE_LIMIT_EXCEEDED,
          'GSC rate limit exceeded. Please try again later.',
          { storeId },
          true,
        );
      default:
        throw error;
    }
  }

  private async handleGA4Error(error: GA4Error, storeId: string): Promise<void> {
    switch (error.type) {
      case GA4ErrorType.QUOTA_EXCEEDED:
        throw new AnalyticsError(
          AnalyticsErrorType.QUOTA_EXCEEDED,
          'GA4 quota exceeded. Please try again later.',
          { storeId },
          true,
        );
      case GA4ErrorType.AUTHENTICATION_FAILED:
        try {
          await retry(
            async () => {
              const { error: updateError } = await this.supabase
                .from('analytics_integrations')
                .update({ is_active: false })
                .eq('store_id', storeId)
                .eq('integration_type', 'google_analytics_4');
              if (updateError) {
                throw updateError;
              }
            },
            AnalyticsCollector.RETRY_OPTIONS,
          );
        } catch {
        }
        throw new AnalyticsError(
          AnalyticsErrorType.AUTHENTICATION_FAILED,
          'GA4 authentication failed. Please reconnect your Google Analytics account.',
          { storeId },
        );
      case GA4ErrorType.INVALID_PROPERTY:
        throw new AnalyticsError(
          AnalyticsErrorType.VALIDATION_ERROR,
          'Invalid GA4 property. Please check your property ID.',
          { storeId },
        );
      case GA4ErrorType.RATE_LIMIT_EXCEEDED:
        throw new AnalyticsError(
          AnalyticsErrorType.RATE_LIMIT_EXCEEDED,
          'GA4 rate limit exceeded. Please try again later.',
          { storeId },
          true,
        );
      default:
        throw error;
    }
  }

  private classifyDatabaseError(
    error: unknown,
    operation: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): AnalyticsError {
    const classified = classifyError(error, { operation, metadata });

    return new AnalyticsError(
      AnalyticsErrorType.UNKNOWN,
      classified.message,
      { ...metadata, category: classified.category },
      classified.retryable,
    );
  }

  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  private getDateDaysAgo(days: number): Date {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date;
  }

  private mapMetricsToPerformance(
    data: readonly DatabaseMetricRow[],
  ): readonly PerformanceMetrics[] {
    return data.map((m) => ({
      impressions: m.impressions ?? 0,
      clicks: m.clicks ?? 0,
      ctr: m.ctr ?? 0,
      position: m.position ?? 0,
      timeOnPage: m.time_on_page ?? undefined,
      scrollDepth: m.scroll_depth ?? undefined,
      conversionRate: m.conversion_rate ?? undefined,
      conversions: m.conversions ?? undefined,
      revenue: this.parseRevenue(m.revenue),
    }));
  }

  private parseRevenue(revenue: number | string | null): number | undefined {
    if (revenue === null || revenue === undefined) {
      return undefined;
    }
    if (typeof revenue === 'string') {
      const parsed = parseFloat(revenue);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return Number.isFinite(revenue) ? revenue : undefined;
  }

  private calculateStoreMetrics(metricRows: readonly DatabaseMetricRow[]): StoreMetricsResult {
    const totalImpressions = metricRows.reduce((sum, m) => sum + (m.impressions ?? 0), 0);
    const totalClicks = metricRows.reduce((sum, m) => sum + (m.clicks ?? 0), 0);
    const totalConversions = metricRows.reduce((sum, m) => sum + (m.conversions ?? 0), 0);
    const totalRevenue = metricRows.reduce((sum, m) => {
      const revenue = this.parseRevenue(m.revenue) ?? 0;
      return sum + revenue;
    }, 0);
    const avgCTR = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
    const avgPosition =
      metricRows.length > 0
        ? metricRows.reduce((sum, m) => sum + (m.position ?? 100), 0) / metricRows.length
        : 100;

    return {
      totalImpressions,
      totalClicks,
      totalConversions,
      totalRevenue,
      avgCTR,
      avgPosition,
      metrics: metricRows,
    };
  }

  private calculateAverage<T>(items: readonly T[], getValue: (item: T) => number): number {
    if (items.length === 0) {
      return 0;
    }
    return items.reduce((sum, item) => sum + getValue(item), 0) / items.length;
  }

  private calculateAverageScrollDepth(scrollEvents: readonly DatabaseEventRow[]): number {
    if (scrollEvents.length === 0) {
      return 0;
    }
    return (
      scrollEvents.reduce((sum, e) => {
        const depth = parseFloat(e.event_data?.scrollDepth ?? '0') || 0;
        return sum + depth;
      }, 0) / scrollEvents.length
    );
  }

  private calculateAverageTimeOnPage(timeEvents: readonly DatabaseEventRow[]): number {
    if (timeEvents.length === 0) {
      return 0;
    }
    return (
      timeEvents.reduce((sum, e) => {
        const time = parseInt(e.event_data?.timeOnPage ?? '0', 10) || 0;
        return sum + time;
      }, 0) / timeEvents.length
    );
  }

  private async getEventData(postId: string): Promise<EventData> {
    const thirtyDaysAgo = new Date(
      Date.now() - AnalyticsCollector.DATE_30_DAYS_MS,
    ).toISOString();
    try {
      const { data: events } = await retry(
        async () => {
          return await this.supabase
            .from('analytics_events')
            .select('event_type, event_data')
            .eq('post_id', postId)
            .gte('timestamp', thirtyDaysAgo);
        },
        AnalyticsCollector.RETRY_OPTIONS,
      );

      const eventRows = (events ?? []) as readonly DatabaseEventRow[];
      const pageviews = eventRows.filter((e) => e.event_type === 'pageview').length;
      const scrollEvents = eventRows.filter((e) => e.event_type === 'scroll');
      const timeEvents = eventRows.filter((e) => e.event_type === 'time');

      return {
        pageviews,
        scrollEvents,
        timeEvents,
      };
    } catch (error) {
      this.logger.error('Failed to get event data', {
        postId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        pageviews: 0,
        scrollEvents: [],
        timeEvents: [],
      };
    }
  }

  private mapGSCMetricsToBatchItems(
    gscMetrics: readonly SearchConsoleMetrics[],
    postId: string,
    storeId: string,
  ): readonly BatchMetricItem[] {
    return gscMetrics.map((m) => ({
      postId,
      storeId,
      metrics: {
        impressions: m.impressions,
        clicks: m.clicks,
        ctr: m.ctr,
        position: m.position,
      },
      source: 'google_search_console',
      date: new Date(m.date),
    }));
  }

  private mapGA4MetricsToBatchItems(
    ga4Metrics: readonly GA4Metrics[],
    postId: string,
    storeId: string,
  ): readonly BatchMetricItem[] {
    return ga4Metrics.map((m) => {
      const ctr = m.bounceRate > 0 ? 1 - m.bounceRate : 0;
      const conversionRate =
        m.conversions > 0 && m.sessions > 0 ? m.conversions / m.sessions : 0;
      return {
        postId,
        storeId,
        metrics: {
          impressions: m.pageViews,
          clicks: m.sessions,
          ctr,
          position: 0,
          timeOnPage: Math.round(m.avgSessionDuration),
          conversionRate,
          conversions: m.conversions,
          revenue: m.revenue,
        },
        source: 'google_analytics_4',
        date: new Date(m.date),
      };
    });
  }
}

export class AnalyticsTracker {
  private readonly supabase: SupabaseClient;
  private readonly batchQueue: AnalyticsEvent[];
  private readonly batchSize: number;
  private readonly logger: Logger;
  private flushTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private static readonly DEFAULT_BATCH_SIZE = 50;
  private static readonly FLUSH_INTERVAL_MS = 5000;
  private static readonly MAX_QUEUE_SIZE = 500;
  private static readonly RETRY_OPTIONS: RetryOptions = {
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    strategy: 'exponential',
    jitter: true,
  } as const;

  constructor(supabase: SupabaseClient, batchSize: number = AnalyticsTracker.DEFAULT_BATCH_SIZE) {
    if (!supabase || typeof supabase !== 'object' || typeof supabase.from !== 'function') {
      throw new AnalyticsError(
        AnalyticsErrorType.VALIDATION_ERROR,
        'Invalid Supabase client: must be a valid client instance',
      );
    }
    if (batchSize <= 0 || !Number.isFinite(batchSize)) {
      throw new AnalyticsError(
        AnalyticsErrorType.VALIDATION_ERROR,
        'Batch size must be a positive number',
        { batchSize },
      );
    }
    this.supabase = supabase;
    this.batchQueue = [];
    this.batchSize = Math.floor(batchSize);
    this.logger = createStructuredLogger('AnalyticsTracker');
    this.scheduleFlush();
  }

  async trackEvent(event: AnalyticsEvent): Promise<void> {
    this.validateEvent(event);
    this.batchQueue.push(event);

    if (this.batchQueue.length >= this.batchSize) {
      await this.flush();
    }
  }

  async trackEvents(events: readonly AnalyticsEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    if (events.length > MAX_BATCH_SIZE) {
      throw new AnalyticsError(
        AnalyticsErrorType.VALIDATION_ERROR,
        `Batch size exceeds maximum: ${MAX_BATCH_SIZE}`,
        { batchSize: events.length },
      );
    }

    for (const event of events) {
      this.validateEvent(event);
    }

    this.batchQueue.push(...events);

    if (this.batchQueue.length >= this.batchSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.batchQueue.length === 0) {
      return;
    }

    const eventsToFlush = [...this.batchQueue];
    this.batchQueue.length = 0;

    const eventsToInsert = eventsToFlush.map((event) => ({
      store_id: event.storeId,
      post_id: event.postId ?? null,
      event_type: event.eventType,
      event_data: event.eventData ?? {},
      timestamp: event.timestamp?.toISOString() ?? new Date().toISOString(),
      user_agent: event.metadata?.userAgent ?? null,
      referrer: event.metadata?.referrer ?? null,
      ip_address: event.metadata?.ipAddress ?? null,
    }));

    try {
      await retry(
        async () => {
          const { error } = await this.supabase.from('analytics').insert(eventsToInsert);
          if (error) {
            throw error;
          }
        },
        {
          ...AnalyticsTracker.RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            this.logger.warn('Retrying flush', {
              attempt,
              eventCount: eventsToInsert.length,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      this.logger.info('Analytics events flushed', { count: eventsToInsert.length });
    } catch (error) {
      if (this.batchQueue.length < AnalyticsTracker.MAX_QUEUE_SIZE) {
        this.batchQueue.unshift(...eventsToFlush);
      } else {
        this.logger.error('Queue overflow, dropping events', {
          droppedCount: eventsToFlush.length,
          queueSize: this.batchQueue.length,
        });
      }
      throw new AnalyticsError(
        AnalyticsErrorType.SYNC_FAILED,
        `Failed to insert analytics events: ${error instanceof Error ? error.message : String(error)}`,
        { eventCount: eventsToInsert.length },
        true,
      );
    }
  }

  destroy(): void {
    if (this.flushTimeoutId !== null) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }
  }

  private validateEvent(event: AnalyticsEvent): void {
    validateUUID(event.storeId, 'storeId');
    if (event.postId) {
      validateUUID(event.postId, 'postId');
    }
    if (!isEventType(event.eventType)) {
      throw new AnalyticsError(
        AnalyticsErrorType.VALIDATION_ERROR,
        `Invalid event type: ${event.eventType}`,
        { eventType: event.eventType },
      );
    }
    validateEventData(event.eventData);
    validateMetadata(event.metadata);
  }

  private scheduleFlush(): void {
    this.flushTimeoutId = setTimeout(async () => {
      try {
        await this.flush();
      } catch (error) {
        this.logger.error('Scheduled flush failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.scheduleFlush();
    }, AnalyticsTracker.FLUSH_INTERVAL_MS);
  }
}
