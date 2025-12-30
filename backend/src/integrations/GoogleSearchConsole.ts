import { retry } from '../utils/error-handling.ts';

export enum GSCErrorType {
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  INVALID_SITE = 'INVALID_SITE',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN',
}

export class GSCError extends Error {
  constructor(
    public readonly type: GSCErrorType,
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'GSCError';
  }
}

export interface SearchConsoleMetrics {
  readonly clicks: number;
  readonly impressions: number;
  readonly ctr: number;
  readonly position: number;
  readonly date: string;
  readonly query?: string;
  readonly page?: string;
  readonly country?: string;
  readonly device?: string;
  readonly searchAppearance?: string;
  readonly hour?: string;
  readonly [key: string]: unknown;
}

export interface SearchConsoleConfig {
  readonly accessToken: string;
  readonly siteUrl: string;
  readonly timezone?: string;
  readonly cacheTTL?: number;
  readonly enableCaching?: boolean;
  readonly rateLimitDelay?: number;
  readonly maxRetries?: number;
}

export interface SearchConsoleRequest {
  readonly startDate: string;
  readonly endDate: string;
  readonly dimensions?: readonly ('date' | 'query' | 'page' | 'country' | 'device' | 'searchAppearance' | 'hour')[];
  readonly type?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
  readonly dimensionFilterGroups?: ReadonlyArray<{
    readonly groupType?: 'and';
    readonly filters: ReadonlyArray<{
      readonly dimension: 'country' | 'device' | 'page' | 'query' | 'searchAppearance';
      readonly operator?: 'contains' | 'equals' | 'notContains' | 'notEquals' | 'includingRegex' | 'excludingRegex';
      readonly expression: string;
    }>;
  }>;
  readonly aggregationType?: 'auto' | 'byPage' | 'byProperty' | 'byNewsShowcasePanel';
  readonly rowLimit?: number;
  readonly startRow?: number;
  readonly dataState?: 'final' | 'all' | 'hourly_all';
}

export interface SearchConsoleResponse {
  readonly rows: ReadonlyArray<{
    readonly keys: readonly string[];
    readonly clicks: number;
    readonly impressions: number;
    readonly ctr: number;
    readonly position: number;
  }>;
  readonly responseAggregationType?: string;
  readonly metadata?: {
    readonly first_incomplete_date?: string;
    readonly first_incomplete_hour?: string;
  };
}

export interface GSCCacheEntry {
  readonly data: readonly SearchConsoleMetrics[];
  readonly expiresAt: number;
  readonly etag?: string;
}

export interface GSCRateLimitState {
  readonly remainingRequests: number;
  readonly resetTime: number;
  readonly queue: ReadonlyArray<() => Promise<unknown>>;
  readonly processing: boolean;
}

export interface GSCSearchAnalyticsOptions {
  readonly useCache?: boolean;
  readonly incremental?: boolean;
  readonly validateData?: boolean;
  readonly aggregate?: {
    readonly function: 'sum' | 'average' | 'count' | 'min' | 'max';
    readonly groupBy?: readonly string[];
  };
}

export interface GSCPageMetricsOptions {
  readonly useCache?: boolean;
  readonly incremental?: boolean;
}

export interface GSCSitemapResult {
  readonly success: boolean;
  readonly message?: string;
}

export interface GSCSitemapInfo {
  readonly path: string;
  readonly type: string;
  readonly lastSubmitted?: string;
  readonly isSitemapsIndex?: boolean;
  readonly isPending?: boolean;
  readonly errors?: number;
  readonly warnings?: number;
  readonly contents?: ReadonlyArray<{
    readonly type: string;
    readonly submitted: number;
  }>;
}

interface GSCDataQualityCheck {
  readonly completeness: number;
  readonly freshness: number;
  readonly anomalies: readonly string[];
  readonly missingData: readonly string[];
  readonly dataGaps: ReadonlyArray<{ readonly start: string; readonly end: string }>;
}

interface GSCErrorData {
  readonly error?: {
    readonly message?: string;
  };
}

interface GSCRequestBody {
  readonly startDate: string;
  readonly endDate: string;
  readonly dimensions?: readonly string[];
  readonly type?: string;
  readonly dimensionFilterGroups?: ReadonlyArray<{
    readonly groupType?: string;
    readonly filters: ReadonlyArray<{
      readonly dimension: string;
      readonly operator?: string;
      readonly expression: string;
    }>;
  }>;
  readonly aggregationType?: string;
  readonly rowLimit: number;
  readonly startRow: number;
  readonly dataState?: string;
}

interface MutableRateLimitState {
  remainingRequests: number;
  resetTime: number;
  queue: Array<() => Promise<unknown>>;
  processing: boolean;
}

export class GoogleSearchConsole {
  private readonly config: Required<SearchConsoleConfig>;
  private static readonly API_BASE = 'https://www.googleapis.com/webmasters/v3';
  private static readonly DEFAULT_TIMEZONE = 'UTC';
  private static readonly DEFAULT_CACHE_TTL = 300000;
  private static readonly DEFAULT_RATE_LIMIT_DELAY = 200;
  private static readonly DEFAULT_MAX_RETRIES = 3;
  private static readonly DEFAULT_RATE_LIMIT_REQUESTS = 600;
  private static readonly DEFAULT_RATE_LIMIT_RESET_MS = 60000;
  private static readonly DEFAULT_RETRY_DELAY = 1000;
  private static readonly DEFAULT_ROW_LIMIT = 1000;
  private static readonly DEFAULT_START_ROW = 0;
  private static readonly DEFAULT_PAGE_METRICS_LIMIT = 5000;
  private static readonly DATE_FORMAT_LENGTH = 10;
  private static readonly MS_PER_SECOND = 1000;
  private static readonly SECONDS_PER_MINUTE = 60;
  private static readonly MS_PER_MINUTE = GoogleSearchConsole.MS_PER_SECOND * GoogleSearchConsole.SECONDS_PER_MINUTE;
  private static readonly MS_PER_HOUR = GoogleSearchConsole.MS_PER_MINUTE * 60;
  private static readonly MS_PER_DAY = GoogleSearchConsole.MS_PER_HOUR * 24;
  private static readonly DAYS_FRESHNESS_THRESHOLD = 3;
  private static readonly DAYS_FRESHNESS_DIVISOR = 7;
  private static readonly COMPLETENESS_THRESHOLD = 0.9;
  private static readonly CTR_MIN = 0;
  private static readonly CTR_MAX = 1;
  private static readonly DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;
  private static readonly CACHE_KEY_SEPARATOR = ':';
  private static readonly DEDUP_SEPARATOR = '|';
  private static readonly HASH_SHIFT = 5;
  private static readonly RETRYABLE_ERRORS: readonly string[] = ['network', 'timeout', 'server_error'];
  private static readonly HTTP_STATUS_UNAUTHORIZED = 401;
  private static readonly HTTP_STATUS_FORBIDDEN = 403;
  private static readonly HTTP_STATUS_BAD_REQUEST = 400;
  private static readonly HTTP_STATUS_TOO_MANY_REQUESTS = 429;
  private static readonly HTTP_STATUS_INTERNAL_ERROR = 500;
  private static readonly HTTP_STATUS_BAD_GATEWAY = 502;
  private static readonly HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
  private static readonly WEEK_DAYS = 7;
  private static readonly SITEMAP_PATHS: readonly string[] = [
    '/sitemap.xml',
    '/sitemap_blog.xml',
    '/blogs/sitemap.xml',
  ];

  private readonly cache: Map<string, GSCCacheEntry>;
  private readonly rateLimitState: MutableRateLimitState;
  private readonly lastSyncTimestamps: Map<string, number>;
  private readonly processedDataHashes: Set<string>;

  constructor(config: SearchConsoleConfig) {
    this.config = {
      timezone: config.timezone || GoogleSearchConsole.DEFAULT_TIMEZONE,
      cacheTTL: config.cacheTTL || GoogleSearchConsole.DEFAULT_CACHE_TTL,
      enableCaching: config.enableCaching !== false,
      rateLimitDelay: config.rateLimitDelay || GoogleSearchConsole.DEFAULT_RATE_LIMIT_DELAY,
      maxRetries: config.maxRetries || GoogleSearchConsole.DEFAULT_MAX_RETRIES,
      accessToken: config.accessToken,
      siteUrl: config.siteUrl,
    };
    this.cache = new Map();
    this.rateLimitState = {
      remainingRequests: GoogleSearchConsole.DEFAULT_RATE_LIMIT_REQUESTS,
      resetTime: Date.now() + GoogleSearchConsole.DEFAULT_RATE_LIMIT_RESET_MS,
      queue: [],
      processing: false,
    };
    this.lastSyncTimestamps = new Map();
    this.processedDataHashes = new Set();
  }

  async getSearchAnalytics(
    request: SearchConsoleRequest,
    options?: GSCSearchAnalyticsOptions,
  ): Promise<ReadonlyArray<SearchConsoleMetrics>> {
    const {
      useCache = true,
      incremental = false,
      validateData = true,
      aggregate,
    } = options || {};

    const cacheKey = this.generateCacheKey(request);
    const adjustedRequest = incremental ? this.adjustRequestForIncremental(request, cacheKey) : request;

    if (useCache && this.config.enableCaching) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
      }
    }

    const response = await this.executeWithRateLimit(() =>
      this.executeSearchAnalyticsRequest(adjustedRequest),
    );

    const metrics = this.mapMetricsDynamically(response, adjustedRequest.dimensions || []);

    if (validateData) {
      this.validateDataQuality(metrics, adjustedRequest);
    }

    const finalMetrics = aggregate ? this.aggregateData(metrics, aggregate) : metrics;
    const deduplicated = this.deduplicateData(finalMetrics);

    if (useCache && this.config.enableCaching) {
      this.cache.set(cacheKey, {
        data: deduplicated,
        expiresAt: Date.now() + this.config.cacheTTL,
      });
    }

    if (incremental) {
      this.lastSyncTimestamps.set(cacheKey, Date.now());
    }

    return deduplicated;
  }

  async getPageMetrics(
    pageUrl: string,
    startDate: string,
    endDate: string,
    options?: GSCPageMetricsOptions,
  ): Promise<ReadonlyArray<SearchConsoleMetrics>> {
    return this.getSearchAnalytics(
      {
        startDate,
        endDate,
        dimensions: ['date', 'query'],
        dimensionFilterGroups: [
          {
            groupType: 'and',
            filters: [
              {
                dimension: 'page',
                operator: 'contains',
                expression: pageUrl,
              },
            ],
          },
        ],
        rowLimit: GoogleSearchConsole.DEFAULT_PAGE_METRICS_LIMIT,
      },
      options,
    );
  }

  async submitSitemap(sitemapUrl: string): Promise<GSCSitemapResult> {
    const url = `${GoogleSearchConsole.API_BASE}/sites/${encodeURIComponent(this.config.siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;

    try {
      await retry(
        async () => {
          const res = await fetch(url, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${this.config.accessToken}`,
              'Content-Type': 'application/json',
            },
          });

          if (!res.ok) {
            const error = await this.parseError(res);
            throw error;
          }
        },
        {
          maxAttempts: this.config.maxRetries,
          initialDelay: GoogleSearchConsole.DEFAULT_RETRY_DELAY,
          retryableErrors: GoogleSearchConsole.RETRYABLE_ERRORS,
        },
      );

      return { success: true };
    } catch (error) {
      if (error instanceof GSCError) {
        return {
          success: false,
          message: error.message,
        };
      }
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async submitSitemapForArticle(articleUrl: string): Promise<GSCSitemapResult> {
    const urlObj = new URL(articleUrl);
    const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

    let lastError: Error | null = null;

    for (const path of GoogleSearchConsole.SITEMAP_PATHS) {
      try {
        const result = await this.submitSitemap(`${baseUrl}${path}`);
        if (result.success) {
          return { success: true, message: `Sitemap submitted: ${baseUrl}${path}` };
        }
        lastError = new Error(result.message || 'Unknown error');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    return {
      success: false,
      message: lastError?.message || 'Failed to submit sitemap at any known location',
    };
  }

  /**
   * List all sitemaps for the site
   * Returns array of sitemap paths
   */
  async listSitemaps(): Promise<ReadonlyArray<GSCSitemapInfo>> {
    const url = `${GoogleSearchConsole.API_BASE}/sites/${encodeURIComponent(this.config.siteUrl)}/sitemaps`;

    try {
      const response = await retry(
        async () => {
          const res = await fetch(url, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${this.config.accessToken}`,
              'Content-Type': 'application/json',
            },
          });

          if (!res.ok) {
            const error = await this.parseError(res);
            throw error;
          }

          return res.json() as Promise<{ sitemap?: ReadonlyArray<GSCSitemapInfo> }>;
        },
        {
          maxAttempts: this.config.maxRetries,
          initialDelay: GoogleSearchConsole.DEFAULT_RETRY_DELAY,
          retryableErrors: GoogleSearchConsole.RETRYABLE_ERRORS,
        },
      );

      return response.sitemap || [];
    } catch (error) {
      if (error instanceof GSCError) {
        throw error;
      }
      throw new GSCError(
        GSCErrorType.UNKNOWN,
        `Failed to list sitemaps: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Detect and return the primary sitemap URL
   * Prefers sitemap.xml, then sitemap_index, then first available
   */
  async detectSitemapUrl(): Promise<string | null> {
    try {
      const sitemaps = await this.listSitemaps();

      if (sitemaps.length === 0) {
        return null;
      }

      // Prefer sitemap.xml (not a sitemap index)
      const sitemapXml = sitemaps.find((s) =>
        s.path.includes('sitemap.xml') &&
        !s.path.includes('sitemap_index') &&
        !s.isSitemapsIndex &&
        (s.type === 'sitemap' || !s.type)
      );
      if (sitemapXml) {
        return sitemapXml.path;
      }

      // Then prefer sitemap index
      const sitemapIndex = sitemaps.find((s) =>
        s.isSitemapsIndex ||
        s.path.includes('sitemap_index')
      );
      if (sitemapIndex) {
        return sitemapIndex.path;
      }

      // Then any sitemap type
      const anySitemap = sitemaps.find((s) => s.type === 'sitemap');
      if (anySitemap) {
        return anySitemap.path;
      }

      // Return first sitemap
      return sitemaps[0]?.path || null;
    } catch (error) {
      // If listing fails, return null (will fall back to common paths)
      console.warn('Failed to detect sitemap URL:', error);
      return null;
    }
  }

  /**
   * Submit a specific sitemap URL (preferred method)
   * Handles both full URLs and relative paths
   */
  async submitSitemapUrl(sitemapUrl: string): Promise<GSCSitemapResult> {
    // If sitemapUrl is a full URL, extract just the path relative to site
    let feedpath = sitemapUrl;

    try {
      const urlObj = new URL(sitemapUrl);
      const siteUrlObj = new URL(this.config.siteUrl);

      // If same domain, use just the path
      if (urlObj.host === siteUrlObj.host) {
        feedpath = urlObj.pathname + (urlObj.search || '');
      } else {
        // Different domain - use full URL
        feedpath = sitemapUrl;
      }
    } catch {
      // If not a valid URL, assume it's already a path or relative URL
      // GSC API accepts both full URLs and paths relative to the site
      feedpath = sitemapUrl;
    }

    return this.submitSitemap(feedpath);
  }

  private adjustRequestForIncremental(
    request: SearchConsoleRequest,
    cacheKey: string,
  ): SearchConsoleRequest {
    const lastSync = this.lastSyncTimestamps.get(cacheKey);
    if (!lastSync) {
      return request;
    }

    const lastSyncDate = new Date(lastSync).toISOString().split('T')[0];
    if (request.startDate < lastSyncDate) {
      return {
        ...request,
        startDate: lastSyncDate,
      };
    }

    return request;
  }

  private async executeSearchAnalyticsRequest(
    request: SearchConsoleRequest,
  ): Promise<SearchConsoleResponse> {
    const url = `${GoogleSearchConsole.API_BASE}/sites/${encodeURIComponent(this.config.siteUrl)}/searchAnalytics/query`;
    const requestBody = this.buildRequestBody(request);

    try {
      const response = await retry(
        async () => {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.config.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          if (!res.ok) {
            const error = await this.parseError(res);
            throw error;
          }

          return res.json() as Promise<SearchConsoleResponse>;
        },
        {
          maxAttempts: this.config.maxRetries,
          initialDelay: GoogleSearchConsole.DEFAULT_RETRY_DELAY,
          retryableErrors: GoogleSearchConsole.RETRYABLE_ERRORS,
        },
      );

      if (response.rows && response.rows.length >= (request.rowLimit || GoogleSearchConsole.DEFAULT_ROW_LIMIT)) {
        const nextPage = await this.executeSearchAnalyticsRequest({
          ...request,
          startRow: (request.startRow || GoogleSearchConsole.DEFAULT_START_ROW) + (request.rowLimit || GoogleSearchConsole.DEFAULT_ROW_LIMIT),
        });
        return {
          ...response,
          rows: [...(response.rows || []), ...(nextPage.rows || [])],
        };
      }

      return response;
    } catch (error) {
      if (error instanceof GSCError) {
        throw error;
      }
      throw new GSCError(
        GSCErrorType.UNKNOWN,
        `GSC API error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private buildRequestBody(request: SearchConsoleRequest): GSCRequestBody {
    const body: GSCRequestBody = {
      startDate: request.startDate,
      endDate: request.endDate,
      rowLimit: request.rowLimit || GoogleSearchConsole.DEFAULT_ROW_LIMIT,
      startRow: request.startRow || GoogleSearchConsole.DEFAULT_START_ROW,
    };

    if (request.dimensions && request.dimensions.length > 0) {
      body.dimensions = request.dimensions;
    }

    if (request.type) {
      body.type = request.type;
    }

    if (request.dimensionFilterGroups) {
      body.dimensionFilterGroups = request.dimensionFilterGroups;
    }

    if (request.aggregationType) {
      body.aggregationType = request.aggregationType;
    }

    if (request.dataState) {
      body.dataState = request.dataState;
    }

    return body;
  }

  private async parseError(response: Response): Promise<GSCError> {
    const status = response.status;
    let errorData: GSCErrorData = {};

    try {
      errorData = (await response.json()) as GSCErrorData;
    } catch {
    }

    const errorMessage = errorData.error?.message || response.statusText;
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfter = retryAfterHeader
      ? parseInt(retryAfterHeader, 10) * GoogleSearchConsole.MS_PER_SECOND
      : undefined;

    return this.createErrorFromStatus(status, errorMessage, retryAfter);
  }

  private createErrorFromStatus(
    status: number,
    errorMessage: string,
    retryAfter?: number,
  ): GSCError {
    switch (status) {
      case GoogleSearchConsole.HTTP_STATUS_UNAUTHORIZED:
        return new GSCError(
          GSCErrorType.AUTHENTICATION_FAILED,
          `Authentication failed: ${errorMessage}`,
          status,
        );
      case GoogleSearchConsole.HTTP_STATUS_FORBIDDEN:
        return this.createForbiddenError(errorMessage, status, retryAfter);
      case GoogleSearchConsole.HTTP_STATUS_TOO_MANY_REQUESTS:
        return new GSCError(
          GSCErrorType.RATE_LIMIT_EXCEEDED,
          `Rate limit exceeded: ${errorMessage}`,
          status,
          retryAfter,
        );
      case GoogleSearchConsole.HTTP_STATUS_BAD_REQUEST:
        return new GSCError(
          GSCErrorType.INVALID_SITE,
          `Invalid request: ${errorMessage}`,
          status,
        );
      case GoogleSearchConsole.HTTP_STATUS_INTERNAL_ERROR:
      case GoogleSearchConsole.HTTP_STATUS_BAD_GATEWAY:
      case GoogleSearchConsole.HTTP_STATUS_SERVICE_UNAVAILABLE:
        return new GSCError(
          GSCErrorType.INTERNAL_ERROR,
          `GSC internal error: ${errorMessage}`,
          status,
          retryAfter,
        );
      default:
        return new GSCError(
          GSCErrorType.UNKNOWN,
          `Unknown error: ${errorMessage}`,
          status,
        );
    }
  }

  private createForbiddenError(
    errorMessage: string,
    status: number,
    retryAfter?: number,
  ): GSCError {
    const lowerMessage = errorMessage.toLowerCase();
    if (lowerMessage.includes('quota')) {
      return new GSCError(
        GSCErrorType.QUOTA_EXCEEDED,
        `Quota exceeded: ${errorMessage}`,
        status,
        retryAfter,
      );
    }
    if (lowerMessage.includes('permission')) {
      return new GSCError(
        GSCErrorType.PERMISSION_DENIED,
        `Permission denied: ${errorMessage}`,
        status,
      );
    }
    return new GSCError(
      GSCErrorType.INVALID_SITE,
      `Invalid site or insufficient permissions: ${errorMessage}`,
      status,
    );
  }

  private async executeWithRateLimit<T>(requestFn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const executeRequest = async (): Promise<void> => {
        if (this.rateLimitState.remainingRequests <= 0) {
          const waitTime = Math.max(0, this.rateLimitState.resetTime - Date.now());
          if (waitTime > 0) {
            await new Promise((r) => setTimeout(r, waitTime));
            this.rateLimitState.remainingRequests = GoogleSearchConsole.DEFAULT_RATE_LIMIT_REQUESTS;
            this.rateLimitState.resetTime = Date.now() + GoogleSearchConsole.DEFAULT_RATE_LIMIT_RESET_MS;
          }
        }

        await new Promise((r) => setTimeout(r, this.config.rateLimitDelay));

        try {
          const result = await requestFn();
          this.rateLimitState.remainingRequests = Math.max(
            0,
            this.rateLimitState.remainingRequests - 1,
          );
          resolve(result);
        } catch (error) {
          if (error instanceof GSCError && error.type === GSCErrorType.RATE_LIMIT_EXCEEDED) {
            const retryAfter = error.retryAfter || GoogleSearchConsole.DEFAULT_RATE_LIMIT_RESET_MS;
            this.rateLimitState.remainingRequests = 0;
            this.rateLimitState.resetTime = Date.now() + retryAfter;
            setTimeout(() => {
              this.executeWithRateLimit(requestFn).then(resolve).catch(reject);
            }, retryAfter);
          } else {
            reject(error);
          }
        }
      };

      if (this.rateLimitState.processing) {
        this.rateLimitState.queue.push(executeRequest);
      } else {
        this.rateLimitState.processing = true;
        executeRequest().finally(() => {
          this.rateLimitState.processing = false;
          const next = this.rateLimitState.queue.shift();
          if (next) {
            this.executeWithRateLimit(() => Promise.resolve()).then(() => next());
          }
        });
      }
    });
  }

  private mapMetricsDynamically(
    response: SearchConsoleResponse,
    dimensions: readonly string[],
  ): ReadonlyArray<SearchConsoleMetrics> {
    if (!response.rows || response.rows.length === 0) {
      return [];
    }

    return response.rows.map((row) => {
      const metrics: Record<string, unknown> = {
        clicks: row.clicks || 0,
        impressions: row.impressions || 0,
        ctr: row.ctr || 0,
        position: row.position || 0,
      };

      dimensions.forEach((dim, index) => {
        const value = row.keys?.[index];
        if (value) {
          this.mapDimensionToMetric(metrics, dim, value);
        }
      });

      if (!metrics.date && row.keys && row.keys.length > 0) {
        const firstKey = row.keys[0];
        if (GoogleSearchConsole.DATE_PATTERN.test(firstKey)) {
          metrics.date = firstKey.substring(0, GoogleSearchConsole.DATE_FORMAT_LENGTH);
        } else if (dimensions.length > 0 && dimensions[0] === 'date') {
          metrics.date = firstKey;
        }
      }

      return this.buildMetricsObject(metrics);
    });
  }

  private mapDimensionToMetric(
    metrics: Record<string, unknown>,
    dim: string,
    value: string,
  ): void {
    switch (dim) {
      case 'date':
        metrics.date = this.formatDate(value);
        break;
      case 'query':
        metrics.query = value;
        break;
      case 'page':
        metrics.page = value;
        break;
      case 'country':
        metrics.country = value;
        break;
      case 'device':
        metrics.device = value;
        break;
      case 'searchAppearance':
        metrics.searchAppearance = value;
        break;
      case 'hour':
        metrics.hour = value;
        break;
      default:
        metrics[dim] = value;
    }
  }

  private buildMetricsObject(metrics: Record<string, unknown>): SearchConsoleMetrics {
    return {
      clicks: (metrics.clicks as number) || 0,
      impressions: (metrics.impressions as number) || 0,
      ctr: (metrics.ctr as number) || 0,
      position: (metrics.position as number) || 0,
      date: (metrics.date as string) || '',
      query: metrics.query as string | undefined,
      page: metrics.page as string | undefined,
      country: metrics.country as string | undefined,
      device: metrics.device as string | undefined,
      searchAppearance: metrics.searchAppearance as string | undefined,
      hour: metrics.hour as string | undefined,
      ...metrics,
    };
  }

  private formatDate(dateStr: string): string {
    if (GoogleSearchConsole.DATE_PATTERN.test(dateStr)) {
      return dateStr.substring(0, GoogleSearchConsole.DATE_FORMAT_LENGTH);
    }
    return dateStr;
  }

  private validateDataQuality(
    metrics: ReadonlyArray<SearchConsoleMetrics>,
    request: SearchConsoleRequest,
  ): GSCDataQualityCheck {
    const check: GSCDataQualityCheck = {
      completeness: 1,
      freshness: 1,
      anomalies: [],
      missingData: [],
      dataGaps: [],
    };

    if (metrics.length === 0) {
      check.completeness = 0;
      check.anomalies = ['No data returned'];
      return check;
    }

    if (request.dimensions?.includes('date')) {
      const expectedDays = this.getDaysBetween(request.startDate, request.endDate);
      const actualDays = new Set(metrics.map((m) => m.date)).size;

      if (actualDays < expectedDays * GoogleSearchConsole.COMPLETENESS_THRESHOLD) {
        check.completeness = actualDays / expectedDays;
        check.anomalies = [`Missing ${expectedDays - actualDays} days of data`];
      }
    }

    this.checkAnomalies(metrics, check);
    this.checkDataFreshness(metrics, check);

    return check;
  }

  private checkAnomalies(
    metrics: ReadonlyArray<SearchConsoleMetrics>,
    check: GSCDataQualityCheck,
  ): void {
    metrics.forEach((metric) => {
      if (metric.clicks < 0) {
        check.anomalies = [...check.anomalies, `Negative clicks on ${metric.date}`];
      }
      if (metric.impressions < 0) {
        check.anomalies = [...check.anomalies, `Negative impressions on ${metric.date}`];
      }
      if (metric.ctr < GoogleSearchConsole.CTR_MIN || metric.ctr > GoogleSearchConsole.CTR_MAX) {
        check.anomalies = [...check.anomalies, `Invalid CTR (${metric.ctr}) on ${metric.date}`];
      }
      if (metric.position < 0) {
        check.anomalies = [...check.anomalies, `Negative position on ${metric.date}`];
      }
    });
  }

  private checkDataFreshness(
    metrics: ReadonlyArray<SearchConsoleMetrics>,
    check: GSCDataQualityCheck,
  ): void {
    const latestDate = metrics
      .map((m) => new Date(m.date).getTime())
      .reduce((a, b) => Math.max(a, b), 0);
    const daysSinceLatest = (Date.now() - latestDate) / GoogleSearchConsole.MS_PER_DAY;

    if (daysSinceLatest > GoogleSearchConsole.DAYS_FRESHNESS_THRESHOLD) {
      check.freshness = Math.max(
        0,
        1 - daysSinceLatest / GoogleSearchConsole.DAYS_FRESHNESS_DIVISOR,
      );
      check.anomalies = [
        ...check.anomalies,
        `Data is ${Math.round(daysSinceLatest)} days old`,
      ];
    }
  }

  private getDaysBetween(startDate: string, endDate: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    return Math.ceil((end.getTime() - start.getTime()) / GoogleSearchConsole.MS_PER_DAY) + 1;
  }

  private aggregateData(
    metrics: ReadonlyArray<SearchConsoleMetrics>,
    aggregate: {
      readonly function: 'sum' | 'average' | 'count' | 'min' | 'max';
      readonly groupBy?: readonly string[];
    },
  ): ReadonlyArray<SearchConsoleMetrics> {
    if (!aggregate.groupBy || aggregate.groupBy.length === 0) {
      return [this.aggregateAllData(metrics, aggregate.function)];
    }

    return this.aggregateByGroup(metrics, aggregate);
  }

  private aggregateAllData(
    metrics: ReadonlyArray<SearchConsoleMetrics>,
    func: 'sum' | 'average' | 'count' | 'min' | 'max',
  ): SearchConsoleMetrics {
    const clicks = metrics.map((m) => m.clicks);
    const impressions = metrics.map((m) => m.impressions);
    const positions = metrics.map((m) => m.position);

    const aggregated: Record<string, unknown> = {
      clicks: this.applyAggregationFunction(clicks, func),
      impressions: this.applyAggregationFunction(impressions, func),
      position: this.applyAggregationFunction(positions, func),
      ctr: 0,
      date: '',
    };

    const aggregatedImpressions = aggregated.impressions as number;
    const aggregatedClicks = aggregated.clicks as number;
    aggregated.ctr = aggregatedImpressions > 0 ? aggregatedClicks / aggregatedImpressions : 0;

    return aggregated as SearchConsoleMetrics;
  }

  private applyAggregationFunction(
    values: readonly number[],
    func: 'sum' | 'average' | 'count' | 'min' | 'max',
  ): number {
    switch (func) {
      case 'sum':
        return values.reduce((a, b) => a + b, 0);
      case 'average':
        return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      case 'count':
        return values.length;
      case 'min':
        return Math.min(...values);
      case 'max':
        return Math.max(...values);
    }
  }

  private aggregateByGroup(
    metrics: ReadonlyArray<SearchConsoleMetrics>,
    aggregate: {
      readonly function: 'sum' | 'average' | 'count' | 'min' | 'max';
      readonly groupBy: readonly string[];
    },
  ): ReadonlyArray<SearchConsoleMetrics> {
    const groups = new Map<string, SearchConsoleMetrics[]>();

    metrics.forEach((metric) => {
      const key = aggregate.groupBy
        .map((dim) => (metric as Record<string, unknown>)[dim] as string || '')
        .join(GoogleSearchConsole.DEDUP_SEPARATOR);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(metric);
    });

    const result: SearchConsoleMetrics[] = [];
    groups.forEach((groupMetrics) => {
      const aggregated = this.aggregateAllData(groupMetrics, aggregate.function);
      aggregate.groupBy.forEach((dim) => {
        (aggregated as Record<string, unknown>)[dim] = (groupMetrics[0] as Record<string, unknown>)[dim];
      });
      result.push(aggregated);
    });

    return result;
  }

  private deduplicateData(metrics: ReadonlyArray<SearchConsoleMetrics>): ReadonlyArray<SearchConsoleMetrics> {
    const seen = new Set<string>();
    const unique: SearchConsoleMetrics[] = [];

    metrics.forEach((metric) => {
      const hash = `${metric.date}${GoogleSearchConsole.DEDUP_SEPARATOR}${metric.query || ''}${GoogleSearchConsole.DEDUP_SEPARATOR}${metric.page || ''}`;
      const dataHash = this.hashData(metric);

      if (!seen.has(hash) && !this.processedDataHashes.has(dataHash)) {
        seen.add(hash);
        this.processedDataHashes.add(dataHash);
        unique.push(metric);
      }
    });

    return unique;
  }

  private hashData(data: SearchConsoleMetrics): string {
    const str = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << GoogleSearchConsole.HASH_SHIFT) - hash + char;
      hash = hash & hash;
    }
    return hash.toString();
  }

  private generateCacheKey(request: SearchConsoleRequest): string {
    return `gsc${GoogleSearchConsole.CACHE_KEY_SEPARATOR}${this.config.siteUrl}${GoogleSearchConsole.CACHE_KEY_SEPARATOR}${JSON.stringify(request)}`;
  }
}

