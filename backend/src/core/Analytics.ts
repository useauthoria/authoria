import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { GoogleSearchConsole, SearchConsoleMetrics, GSCError, GSCErrorType } from '../integrations/GoogleSearchConsole';
import { GoogleAnalytics4, GA4Metrics, GA4Error, GA4ErrorType } from '../integrations/GoogleAnalytics4';
import { DatabaseBatch } from '../utils/database-utils';

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

interface StoreMetricsResult {
  readonly totalImpressions: number;
  readonly totalClicks: number;
  readonly totalConversions: number;
  readonly totalRevenue: number;
  readonly avgCTR: number;
  readonly avgPosition: number;
  readonly metrics: readonly DatabaseMetricRow[];
}

interface SyncOptions {
  readonly incremental?: boolean;
  readonly useCache?: boolean;
  readonly validateData?: boolean;
}

interface EventMetadata {
  readonly userAgent?: string;
  readonly referrer?: string;
  readonly ipAddress?: string;
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

interface IntegrationCredentials {
  readonly access_token: string;
  readonly site_url: string;
  readonly property_id?: string;
}

interface IntegrationData {
  readonly credentials: IntegrationCredentials;
}

type IntegrationType = 'google_search_console' | 'google_analytics_4';

export class AnalyticsCollector {
  private readonly supabase: SupabaseClient;
  private readonly cache: Map<string, CacheEntry<unknown>> = new Map();
  private static readonly CACHE_TTL = 300000;
  private static readonly DEFAULT_DAYS = 30;
  private static readonly DEFAULT_SOURCE = 'google' as const;
  private static readonly DATE_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  async recordBatchMetrics(metrics: readonly BatchMetricItem[]): Promise<void> {
    const batch = new DatabaseBatch(this.supabase);

    for (const item of metrics) {
      batch.add({
        type: 'upsert',
        table: 'analytics',
        data: {
          store_id: item.storeId,
          post_id: item.postId,
          event_type: 'performance_metric',
          metric_date: this.formatDate(item.date || new Date()),
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
          source: item.source || AnalyticsCollector.DEFAULT_SOURCE,
        },
      });
    }

    await batch.execute();
  }

  async getPostMetrics(postId: string, days: number = AnalyticsCollector.DEFAULT_DAYS): Promise<readonly PerformanceMetrics[]> {
    const cacheKey = `post_metrics_${postId}_${days}`;
    const cached = this.getCached<readonly PerformanceMetrics[]>(cacheKey);
    if (cached) return cached;

    const startDate = this.getDateDaysAgo(days);

    const { data, error } = await this.supabase
      .from('performance_metrics')
      .select('*')
      .eq('post_id', postId)
      .gte('metric_date', this.formatDate(startDate))
      .order('metric_date', { ascending: true });

    if (error) throw error;

    const result = this.mapMetricsToPerformance(data || []);
    this.setCached(cacheKey, result);
    return result;
  }

  async getStoreMetrics(storeId: string, days: number = AnalyticsCollector.DEFAULT_DAYS): Promise<StoreMetricsResult> {
    const cacheKey = `store_metrics_${storeId}_${days}`;
    const cached = this.getCached<StoreMetricsResult>(cacheKey);
    if (cached) return cached;

    const startDate = this.getDateDaysAgo(days);

    const { data, error } = await this.supabase
      .from('performance_metrics')
      .select('*')
      .eq('store_id', storeId)
      .gte('metric_date', this.formatDate(startDate));

    if (error) throw error;

    const metricRows = (data || []) as readonly DatabaseMetricRow[];
    const result = this.calculateStoreMetrics(metricRows);
    this.setCached(cacheKey, result);
    return result;
  }

  async calculateAdvancedSEOHealthScore(postId: string): Promise<SEOHealthScoreResult> {
    const postRow = await this.getPostRow(postId);
    const metrics = await this.getPostMetrics(postId, AnalyticsCollector.DEFAULT_DAYS);
    const eventData = await this.getEventData(postId);

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

    const totalScore = Object.values(breakdown).reduce((sum, score) => sum + score, 0);
    const recommendations = this.generateRecommendations(breakdown, postRow, metrics);

    await Promise.all([
      this.supabase.from('seo_health_scores').insert({
        post_id: postId,
        store_id: postRow.store_id,
        score: totalScore,
        score_breakdown: breakdown,
        recommendations,
      }),
      this.supabase
        .from('blog_posts')
        .update({ seo_health_score: totalScore })
        .eq('id', postId),
    ]);

    return {
      score: totalScore,
      breakdown,
      recommendations,
    } as const;
  }

  async syncGoogleSearchConsole(
    storeId: string,
    postId: string,
    startDate: string,
    endDate: string,
    options?: SyncOptions,
  ): Promise<void> {
    const { incremental = true, useCache = true } = options ?? {};

    const integration = await this.getIntegration(storeId, 'google_search_console');
    const store = await this.getStore(storeId);
    const post = await this.getPost(postId);

    if (!post.shopify_article_id) {
      throw new Error('Post not found or missing shopify_article_id');
    }

    const gsc = new GoogleSearchConsole({
      accessToken: integration.credentials.access_token,
      siteUrl: integration.credentials.site_url,
      timezone: store?.timezone ?? 'UTC',
      enableCaching: useCache,
      cacheTTL: AnalyticsCollector.CACHE_TTL,
      rateLimitDelay: 200,
      maxRetries: 3,
    });

    try {
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
    } catch (error) {
      if (error instanceof GSCError) {
        await this.handleGSCError(error, storeId);
      }
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
    const { incremental = true, useCache = true } = options ?? {};

    const integration = await this.getIntegration(storeId, 'google_analytics_4');
    const store = await this.getStore(storeId);
    const post = await this.getPost(postId);

    if (!post.shopify_article_id) {
      throw new Error('Post not found or missing shopify_article_id');
    }

    const ga4 = new GoogleAnalytics4({
      accessToken: integration.credentials.access_token,
      propertyId: integration.credentials.property_id!,
      timezone: store?.timezone ?? 'UTC',
      enableCaching: useCache,
      cacheTTL: AnalyticsCollector.CACHE_TTL,
      rateLimitDelay: 100,
      maxRetries: 3,
    });

    try {
      const ga4Metrics = await ga4.getPageMetrics(
        `/blogs/${post.shopify_article_id}`,
        startDate,
        endDate,
        { useCache, incremental },
      );

      const metricsToRecord = this.mapGA4MetricsToBatchItems(ga4Metrics, postId, storeId);
      await this.recordBatchMetrics(metricsToRecord);
      await this.updateLastSyncTime(storeId, 'google_analytics_4');
    } catch (error) {
      if (error instanceof GA4Error) {
        await this.handleGA4Error(error, storeId);
      }
      throw error;
    }
  }

  async recordBatchEvents(events: readonly BatchEventItem[]): Promise<void> {
    const batch = new DatabaseBatch(this.supabase);

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

    await batch.execute();
  }

  private calculateSearchPerformanceScore(avgPosition: number, avgCTR: number): number {
    let score = 0;

    if (avgPosition <= 3) score += 15;
    else if (avgPosition <= 10) score += 12;
    else if (avgPosition <= 20) score += 8;
    else if (avgPosition <= 50) score += 4;

    if (avgCTR >= 0.05) score += 10;
    else if (avgCTR >= 0.03) score += 7;
    else if (avgCTR >= 0.01) score += 4;
    else if (avgCTR > 0) score += 2;

    return Math.min(25, score);
  }

  private calculateUserEngagementScore(
    avgScrollDepth: number,
    avgTimeOnPage: number,
    pageviews: number,
  ): number {
    let score = 0;

    if (avgScrollDepth >= 0.9) score += 10;
    else if (avgScrollDepth >= 0.7) score += 7;
    else if (avgScrollDepth >= 0.5) score += 5;
    else if (avgScrollDepth > 0) score += 2;

    if (avgTimeOnPage >= 180) score += 10;
    else if (avgTimeOnPage >= 120) score += 7;
    else if (avgTimeOnPage >= 60) score += 5;
    else if (avgTimeOnPage > 0) score += 2;

    if (pageviews >= 1000) score += 5;
    else if (pageviews >= 500) score += 3;
    else if (pageviews >= 100) score += 2;
    else if (pageviews > 0) score += 1;

    return Math.min(25, score);
  }

  private calculateTechnicalSEOScore(post: DatabasePostRow): number {
    let score = 0;

    if (post.seo_title && post.seo_title.length >= 50 && post.seo_title.length <= 60) score += 5;
    else if (post.seo_title && post.seo_title.length > 0) score += 3;

    if (post.seo_description && post.seo_description.length >= 150 && post.seo_description.length <= 160) {
      score += 5;
    } else if (post.seo_description && post.seo_description.length > 0) {
      score += 3;
    }

    if (post.structured_data) score += 5;
    if (post.featured_image_url) score += 5;
    if (post.shopify_article_id) score += 5;

    return Math.min(25, score);
  }

  private calculateContentQualityScore(post: DatabasePostRow): number {
    let score = 0;
    const wordCount = post.content?.split(/\s+/).length ?? 0;

    if (wordCount >= 2000) score += 10;
    else if (wordCount >= 1500) score += 8;
    else if (wordCount >= 1000) score += 6;
    else if (wordCount >= 500) score += 4;
    else if (wordCount > 0) score += 2;

    const headingCount = (post.content?.match(/^#+\s/gm) || []).length;
    if (headingCount >= 5) score += 5;
    else if (headingCount >= 3) score += 3;
    else if (headingCount > 0) score += 2;

    if (post.keywords && post.keywords.length > 0) score += 5;

    if (wordCount > 0 && post.content) {
      const sentences = post.content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
      const avgSentenceLength = sentences.length > 0 ? wordCount / sentences.length : 0;
      if (avgSentenceLength > 0 && avgSentenceLength < 20) score += 5;
      else score += 3;
    }

    return Math.min(25, score);
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
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  private setCached<T>(key: string, data: T): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + AnalyticsCollector.CACHE_TTL,
    });
  }

  private async getIntegration(storeId: string, integrationType: IntegrationType): Promise<IntegrationData> {
    const { data: integration, error } = await this.supabase
      .from('analytics_integrations')
      .select('credentials')
      .eq('store_id', storeId)
      .eq('integration_type', integrationType)
      .eq('is_active', true)
      .single();

    if (error || !integration) {
      throw new Error(`${integrationType} integration not configured`);
    }

    const credentials = integration.credentials as {
      readonly access_token?: string;
      readonly refresh_token?: string;
      readonly expires_at?: string;
      readonly property_id?: string;
      readonly site_url?: string;
    };

    // Check if token needs refresh
    if (credentials.access_token && credentials.expires_at && credentials.refresh_token) {
      const expiresAt = new Date(credentials.expires_at);
      const now = new Date();
      const bufferTime = 5 * 60 * 1000;

      if (expiresAt.getTime() - now.getTime() < bufferTime) {
        try {
          const refreshedToken = await this.getValidAccessToken(
            storeId,
            integrationType as 'google_analytics_4' | 'google_search_console',
          );

          if (refreshedToken) {
            const { data: updatedIntegration } = await this.supabase
              .from('analytics_integrations')
              .select('credentials')
              .eq('store_id', storeId)
              .eq('integration_type', integrationType)
              .single();

            if (updatedIntegration) {
              const updatedCreds = updatedIntegration.credentials as {
                readonly access_token?: string;
                readonly property_id?: string;
                readonly site_url?: string;
              };
              return {
                credentials: {
                  access_token: refreshedToken,
                  property_id: updatedCreds.property_id || credentials.property_id,
                  site_url: updatedCreds.site_url || credentials.site_url || '',
                },
              };
            }
          }
        } catch (refreshError) {
          console.error('Token refresh failed:', refreshError);
        }
      }
    }

    if (!credentials.access_token) {
      throw new Error(`No access token available for ${integrationType}. Please reconnect.`);
    }

    return {
      credentials: {
        access_token: credentials.access_token,
        property_id: credentials.property_id,
        site_url: credentials.site_url || '',
      },
    };
  }

  private async getValidAccessToken(
    storeId: string,
    integrationType: 'google_analytics_4' | 'google_search_console',
  ): Promise<string | null> {
    const { data: integration } = await this.supabase
      .from('analytics_integrations')
      .select('credentials')
      .eq('store_id', storeId)
      .eq('integration_type', integrationType)
      .single();

    if (!integration) {
      return null;
    }

    const credentials = integration.credentials as {
      readonly access_token?: string;
      readonly expires_at?: string;
      readonly refresh_token?: string;
    };

    if (!credentials.access_token) {
      return null;
    }

    const expiresAt = credentials.expires_at ? new Date(credentials.expires_at) : null;
    const now = new Date();
    const bufferTime = 5 * 60 * 1000;

    // If token is still valid, return it
    if (expiresAt && expiresAt.getTime() - now.getTime() >= bufferTime) {
      return credentials.access_token;
    }

    // Token expired or about to expire, but we can't refresh without OAuth credentials
    // The refresh should be handled by the OAuth refresh endpoint
    // For now, return the token if it exists (even if expired, let the API call fail and user can reconnect)
    return credentials.access_token;
  }

  private async getStore(storeId: string): Promise<{ readonly timezone?: string | null } | null> {
    const { data: store } = await this.supabase
      .from('stores')
      .select('timezone')
      .eq('id', storeId)
      .single();

    return store;
  }

  private async getPost(postId: string): Promise<{ readonly shopify_article_id?: string | null }> {
    const { data: post, error } = await this.supabase
      .from('blog_posts')
      .select('shopify_article_id')
      .eq('id', postId)
      .single();

    if (error || !post) {
      throw new Error('Post not found');
    }

    return post;
  }

  private async getPostRow(postId: string): Promise<DatabasePostRow> {
    const { data: post, error } = await this.supabase
      .from('blog_posts')
      .select('*')
      .eq('id', postId)
      .single();

    if (error || !post) {
      throw new Error(`Post not found: ${postId}`);
    }

    return post as DatabasePostRow;
  }

  private async updateLastSyncTime(storeId: string, integrationType: IntegrationType): Promise<void> {
    await this.supabase
      .from('analytics_integrations')
      .update({ last_sync_at: new Date().toISOString() })
      .eq('store_id', storeId)
      .eq('integration_type', integrationType);
  }

  private async ensureSitemapUrlDetected(
    storeId: string,
    integration: IntegrationData,
    gsc: GoogleSearchConsole,
  ): Promise<void> {
    const credentials = integration.credentials as {
      access_token?: string;
      site_url?: string;
      sitemap_url?: string;
    };

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

        await this.supabase
          .from('analytics_integrations')
          .update({ credentials: updatedCredentials })
          .eq('store_id', storeId)
          .eq('integration_type', 'google_search_console');
      }
    } catch (error) {
      console.warn('Failed to detect sitemap URL for GSC integration', {
        storeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleGSCError(error: GSCError, storeId: string): Promise<void> {
    switch (error.type) {
      case GSCErrorType.QUOTA_EXCEEDED:
        throw new Error('GSC quota exceeded. Please try again later.');
      case GSCErrorType.AUTHENTICATION_FAILED:
        await this.supabase
          .from('analytics_integrations')
          .update({ is_active: false })
          .eq('store_id', storeId)
          .eq('integration_type', 'google_search_console');
        throw new Error('GSC authentication failed. Please reconnect your Google Search Console account.');
      case GSCErrorType.INVALID_SITE:
        throw new Error('Invalid GSC site. Please check your site URL.');
      case GSCErrorType.PERMISSION_DENIED:
        throw new Error('Permission denied. Please check your GSC permissions.');
      case GSCErrorType.RATE_LIMIT_EXCEEDED:
        throw new Error('GSC rate limit exceeded. Please try again later.');
      default:
        throw error;
    }
  }

  private async handleGA4Error(error: GA4Error, storeId: string): Promise<void> {
    switch (error.type) {
      case GA4ErrorType.QUOTA_EXCEEDED:
        throw new Error('GA4 quota exceeded. Please try again later.');
      case GA4ErrorType.AUTHENTICATION_FAILED:
        await this.supabase
          .from('analytics_integrations')
          .update({ is_active: false })
          .eq('store_id', storeId)
          .eq('integration_type', 'google_analytics_4');
        throw new Error('GA4 authentication failed. Please reconnect your Google Analytics account.');
      case GA4ErrorType.INVALID_PROPERTY:
        throw new Error('Invalid GA4 property. Please check your property ID.');
      case GA4ErrorType.RATE_LIMIT_EXCEEDED:
        throw new Error('GA4 rate limit exceeded. Please try again later.');
      default:
        throw error;
    }
  }

  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  private getDateDaysAgo(days: number): Date {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date;
  }

  private mapMetricsToPerformance(data: readonly DatabaseMetricRow[]): readonly PerformanceMetrics[] {
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
    if (!revenue) return undefined;
    return typeof revenue === 'string' ? parseFloat(revenue) : revenue;
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
    const avgPosition = metricRows.length > 0
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
    if (items.length === 0) return 0;
    return items.reduce((sum, item) => sum + getValue(item), 0) / items.length;
  }

  private calculateAverageScrollDepth(scrollEvents: readonly DatabaseEventRow[]): number {
    if (scrollEvents.length === 0) return 0;
    return scrollEvents.reduce((sum, e) => {
      const depth = parseFloat(e.event_data?.scrollDepth ?? '0') || 0;
      return sum + depth;
    }, 0) / scrollEvents.length;
  }

  private calculateAverageTimeOnPage(timeEvents: readonly DatabaseEventRow[]): number {
    if (timeEvents.length === 0) return 0;
    return timeEvents.reduce((sum, e) => {
      const time = parseInt(e.event_data?.timeOnPage ?? '0', 10) || 0;
      return sum + time;
    }, 0) / timeEvents.length;
  }

  private async getEventData(postId: string): Promise<{
    readonly pageviews: number;
    readonly scrollEvents: readonly DatabaseEventRow[];
    readonly timeEvents: readonly DatabaseEventRow[];
  }> {
    const thirtyDaysAgo = new Date(Date.now() - AnalyticsCollector.DATE_30_DAYS_MS).toISOString();
    const { data: events } = await this.supabase
      .from('analytics_events')
      .select('event_type, event_data')
      .eq('post_id', postId)
      .gte('timestamp', thirtyDaysAgo);

    const eventRows = (events || []) as readonly DatabaseEventRow[];
    const pageviews = eventRows.filter((e) => e.event_type === 'pageview').length;
    const scrollEvents = eventRows.filter((e) => e.event_type === 'scroll');
    const timeEvents = eventRows.filter((e) => e.event_type === 'time');

    return {
      pageviews,
      scrollEvents,
      timeEvents,
    };
  }

  private mapGSCMetricsToBatchItems(
    gscMetrics: readonly SearchConsoleMetrics[],
    postId: string,
    storeId: string,
  ): BatchMetricItem[] {
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
  ): BatchMetricItem[] {
    return ga4Metrics.map((m) => ({
      postId,
      storeId,
      metrics: {
        impressions: m.pageViews,
        clicks: m.sessions,
        ctr: m.bounceRate > 0 ? 1 - m.bounceRate : 0,
        position: 0,
        timeOnPage: Math.round(m.avgSessionDuration),
        conversionRate: m.conversions > 0 ? m.conversions / m.sessions : 0,
        conversions: m.conversions,
        revenue: m.revenue,
      },
      source: 'google_analytics_4',
      date: new Date(m.date),
    }));
  }
}

export class AnalyticsTracker {
  private readonly supabase: SupabaseClient;
  private readonly batchQueue: AnalyticsEvent[];
  private readonly batchSize: number;

  constructor(
    supabase: SupabaseClient,
    batchSize: number = 50,
  ) {
    this.supabase = supabase;
    this.batchQueue = [];
    this.batchSize = batchSize;
  }

  async trackEvent(event: AnalyticsEvent): Promise<void> {
    this.batchQueue.push(event);

    if (this.batchQueue.length >= this.batchSize) {
      await this.flush();
    }
  }

  async trackEvents(events: readonly AnalyticsEvent[]): Promise<void> {
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

    try {
      const eventsToInsert = eventsToFlush.map((event) => ({
        store_id: event.storeId,
        post_id: event.postId || null,
        event_type: event.eventType,
        event_data: event.eventData || {},
        timestamp: event.timestamp?.toISOString() || new Date().toISOString(),
        user_agent: event.metadata?.userAgent || null,
        referrer: event.metadata?.referrer || null,
        ip_address: event.metadata?.ipAddress || null,
      }));

      const { error } = await this.supabase
        .from('analytics')
        .insert(eventsToInsert);

      if (error) {
        throw new Error(`Failed to insert analytics events: ${error.message}`);
      }
    } catch (error) {
      // Re-queue events on error (with limit to prevent infinite loops)
      if (this.batchQueue.length < this.batchSize * 10) {
        this.batchQueue.unshift(...eventsToFlush);
      }
      throw error;
    }
  }
}
