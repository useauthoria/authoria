import { retry } from '../utils/error-handling.ts';

export enum GA4ErrorType {
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  INVALID_PROPERTY = 'INVALID_PROPERTY',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  INVALID_REQUEST = 'INVALID_REQUEST',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN',
}

export class GA4Error extends Error {
  constructor(
    public readonly type: GA4ErrorType,
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'GA4Error';
  }
}

export interface GA4Metrics {
  readonly pageViews: number;
  readonly sessions: number;
  readonly users: number;
  readonly bounceRate: number;
  readonly avgSessionDuration: number;
  readonly conversions: number;
  readonly revenue: number;
  readonly date: string;
  readonly pagePath?: string;
  readonly [key: string]: unknown;
}

export interface GA4Config {
  readonly accessToken: string;
  readonly propertyId: string;
  readonly timezone?: string;
  readonly cacheTTL?: number;
  readonly enableCaching?: boolean;
  readonly rateLimitDelay?: number;
  readonly maxRetries?: number;
}

export interface GA4ReportRequest {
  readonly startDate: string;
  readonly endDate: string;
  readonly dimensions?: readonly string[];
  readonly metrics?: readonly string[];
  readonly dimensionFilter?: Readonly<Record<string, unknown>>;
  readonly metricFilter?: Readonly<Record<string, unknown>>;
  readonly orderBys?: ReadonlyArray<{
    readonly dimension?: { readonly dimensionName: string };
    readonly metric?: { readonly metricName: string };
    readonly desc?: boolean;
  }>;
  readonly limit?: number;
  readonly offset?: number;
  readonly keepEmptyRows?: boolean;
  readonly currencyCode?: string;
  readonly cohortSpec?: Readonly<Record<string, unknown>>;
}

export interface GA4ReportResponse {
  readonly rows: ReadonlyArray<{
    readonly dimensionValues: ReadonlyArray<{ readonly value: string }>;
    readonly metricValues: ReadonlyArray<{ readonly value: string }>;
  }>;
  readonly rowCount: number;
  readonly metadata?: {
    readonly currencyCode?: string;
    readonly emptyReason?: string;
    readonly subjectToThresholding?: boolean;
  };
  readonly nextPageToken?: string;
}

export interface GA4CacheEntry {
  readonly data: readonly GA4Metrics[];
  readonly expiresAt: number;
  readonly etag?: string;
}

export interface GA4RateLimitState {
  readonly remainingRequests: number;
  readonly resetTime: number;
  readonly queue: ReadonlyArray<() => Promise<unknown>>;
  readonly processing: boolean;
}

export interface GA4ReportOptions {
  readonly useCache?: boolean;
  readonly incremental?: boolean;
  readonly validateData?: boolean;
  readonly aggregate?: {
    readonly function: 'sum' | 'average' | 'count' | 'min' | 'max';
    readonly groupBy?: readonly string[];
  };
}

export interface GA4PageMetricsOptions {
  readonly useCache?: boolean;
  readonly incremental?: boolean;
}

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

interface GA4DataQualityCheck {
  readonly completeness: number;
  readonly freshness: number;
  readonly anomalies: readonly string[];
  readonly missingData: readonly string[];
  readonly dataGaps: ReadonlyArray<{ readonly start: string; readonly end: string }>;
}

interface GA4ErrorData {
  readonly error?: {
    readonly message?: string;
  };
}

interface GA4RequestBody {
  readonly dateRanges: ReadonlyArray<{
    readonly startDate: string;
    readonly endDate: string;
    readonly name: string;
  }>;
  readonly dimensions: ReadonlyArray<{ readonly name: string }>;
  readonly metrics: ReadonlyArray<{ readonly name: string }>;
  readonly limit: number;
  readonly offset: number;
  readonly keepEmptyRows: boolean;
  readonly timeZone?: string;
  readonly currencyCode?: string;
  readonly dimensionFilter?: Readonly<Record<string, unknown>>;
  readonly metricFilter?: Readonly<Record<string, unknown>>;
  readonly orderBys?: ReadonlyArray<{
    readonly dimension?: { readonly dimensionName: string };
    readonly metric?: { readonly metricName: string };
    readonly desc?: boolean;
  }>;
  readonly cohortSpec?: Readonly<Record<string, unknown>>;
}

interface MutableRateLimitState {
  remainingRequests: number;
  resetTime: number;
  queue: Array<() => Promise<unknown>>;
  processing: boolean;
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

const hashData = (data: unknown): string => {
  const str = JSON.stringify(data);
  let hash = 0;
  const HASH_SHIFT = 5;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << HASH_SHIFT) - hash + char;
    hash = hash & hash;
  }
  return hash.toString();
};

const applyAggregationFunction = (
  values: readonly number[],
  func: 'sum' | 'average' | 'count' | 'min' | 'max',
): number => {
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
};

const getDaysBetween = (startDate: string, endDate: string): number => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const start = new Date(startDate);
  const end = new Date(endDate);
  return Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
};

const validateDate = (date: string): void => {
  if (!date || typeof date !== 'string' || date.trim().length === 0) {
    throw new Error('Invalid date: must be a non-empty string');
  }
  const dateObj = new Date(date);
  if (isNaN(dateObj.getTime())) {
    throw new Error(`Invalid date format: ${date}`);
  }
};

const validateDateRange = (startDate: string, endDate: string): void => {
  validateDate(startDate);
  validateDate(endDate);
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (start > end) {
    throw new Error('Invalid date range: startDate must be before or equal to endDate');
  }
  const daysDiff = getDaysBetween(startDate, endDate);
  if (daysDiff > 365) {
    throw new Error('Invalid date range: maximum 365 days allowed');
  }
};

const validateAccessToken = (token: string): void => {
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('Invalid access token: must be a non-empty string');
  }
  if (token.length > 10000) {
    throw new Error('Invalid access token: exceeds maximum length');
  }
};

const validatePropertyId = (propertyId: string): void => {
  if (!propertyId || typeof propertyId !== 'string' || propertyId.trim().length === 0) {
    throw new Error('Invalid property ID: must be a non-empty string');
  }
  if (propertyId.length > 100) {
    throw new Error('Invalid property ID: exceeds maximum length');
  }
};

const validateSiteUrl = (siteUrl: string): void => {
  if (!siteUrl || typeof siteUrl !== 'string' || siteUrl.trim().length === 0) {
    throw new Error('Invalid site URL: must be a non-empty string');
  }
  try {
    new URL(siteUrl);
  } catch {
    throw new Error(`Invalid site URL format: ${siteUrl}`);
  }
};

const validatePagePath = (pagePath: string): void => {
  if (!pagePath || typeof pagePath !== 'string') {
    throw new Error('Invalid page path: must be a string');
  }
  if (pagePath.length > 2000) {
    throw new Error('Invalid page path: exceeds maximum length');
  }
};

const validateSitemapUrl = (sitemapUrl: string): void => {
  if (!sitemapUrl || typeof sitemapUrl !== 'string' || sitemapUrl.trim().length === 0) {
    throw new Error('Invalid sitemap URL: must be a non-empty string');
  }
  if (sitemapUrl.length > 2000) {
    throw new Error('Invalid sitemap URL: exceeds maximum length');
  }
};

export class GoogleAnalytics4 {
  private readonly config: Required<GA4Config>;
  private static readonly SERVICE_NAME = 'GoogleAnalytics4';
  private static readonly API_BASE = 'https://analyticsdata.googleapis.com/v1beta';
  private static readonly DEFAULT_TIMEZONE = 'UTC';
  private static readonly DEFAULT_CACHE_TTL = 300000;
  private static readonly DEFAULT_RATE_LIMIT_DELAY = 100;
  private static readonly DEFAULT_MAX_RETRIES = 3;
  private static readonly DEFAULT_RATE_LIMIT_REQUESTS = 100;
  private static readonly DEFAULT_RATE_LIMIT_RESET_MS = 60000;
  private static readonly DEFAULT_RETRY_DELAY = 1000;
  private static readonly DEFAULT_LIMIT = 10000;
  private static readonly DATE_FORMAT_LENGTH = 8;
  private static readonly DATE_YEAR_START = 0;
  private static readonly DATE_YEAR_END = 4;
  private static readonly DATE_MONTH_START = 4;
  private static readonly DATE_MONTH_END = 6;
  private static readonly DATE_DAY_START = 6;
  private static readonly DATE_DAY_END = 8;
  private static readonly MS_PER_SECOND = 1000;
  private static readonly DAYS_FRESHNESS_THRESHOLD = 2;
  private static readonly DAYS_FRESHNESS_DIVISOR = 7;
  private static readonly COMPLETENESS_THRESHOLD = 0.9;
  private static readonly BOUNCE_RATE_MAX = 1;
  private static readonly DATE_PATTERN = /^\d{8}$/;
  private static readonly PAGE_PATH_PREFIX = '/';
  private static readonly CACHE_KEY_SEPARATOR = ':';
  private static readonly DEDUP_SEPARATOR = '|';
  private static readonly CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly NUMERIC_FIELDS: readonly string[] = [
    'pageViews',
    'sessions',
    'users',
    'conversions',
    'revenue',
    'avgSessionDuration',
  ] as const;
  private static readonly RETRYABLE_ERRORS: readonly string[] = ['network', 'timeout', 'server_error'] as const;
  private static readonly HTTP_STATUS_UNAUTHORIZED = 401;
  private static readonly HTTP_STATUS_FORBIDDEN = 403;
  private static readonly HTTP_STATUS_BAD_REQUEST = 400;
  private static readonly HTTP_STATUS_TOO_MANY_REQUESTS = 429;
  private static readonly HTTP_STATUS_INTERNAL_ERROR = 500;
  private static readonly HTTP_STATUS_BAD_GATEWAY = 502;
  private static readonly HTTP_STATUS_SERVICE_UNAVAILABLE = 503;

  private readonly cache: Map<string, GA4CacheEntry>;
  private readonly rateLimitState: MutableRateLimitState;
  private readonly lastSyncTimestamps: Map<string, number>;
  private readonly processedDataHashes: Set<string>;
  private cacheCleanupInterval?: number;

  constructor(config: GA4Config) {
    validateAccessToken(config.accessToken);
    validatePropertyId(config.propertyId);
    this.config = {
      timezone: config.timezone || GoogleAnalytics4.DEFAULT_TIMEZONE,
      cacheTTL: config.cacheTTL || GoogleAnalytics4.DEFAULT_CACHE_TTL,
      enableCaching: config.enableCaching !== false,
      rateLimitDelay: config.rateLimitDelay || GoogleAnalytics4.DEFAULT_RATE_LIMIT_DELAY,
      maxRetries: config.maxRetries || GoogleAnalytics4.DEFAULT_MAX_RETRIES,
      accessToken: config.accessToken,
      propertyId: config.propertyId,
    };
    this.cache = new Map();
    this.rateLimitState = {
      remainingRequests: GoogleAnalytics4.DEFAULT_RATE_LIMIT_REQUESTS,
      resetTime: Date.now() + GoogleAnalytics4.DEFAULT_RATE_LIMIT_RESET_MS,
      queue: [],
      processing: false,
    };
    this.lastSyncTimestamps = new Map();
    this.processedDataHashes = new Set();
    this.startCacheCleanup();
  }

  destroy(): void {
    if (this.cacheCleanupInterval !== undefined) {
      clearInterval(this.cacheCleanupInterval);
      this.cacheCleanupInterval = undefined;
    }
    this.cache.clear();
    this.processedDataHashes.clear();
    this.lastSyncTimestamps.clear();
  }

  private startCacheCleanup(): void {
    this.cacheCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.cache.entries()) {
        if (entry.expiresAt < now) {
          this.cache.delete(key);
        }
      }
    }, GoogleAnalytics4.CACHE_CLEANUP_INTERVAL_MS) as unknown as number;
  }

  async runReport(
    request: GA4ReportRequest,
    options?: GA4ReportOptions,
  ): Promise<ReadonlyArray<GA4Metrics>> {
    const startTime = Date.now();
    validateDateRange(request.startDate, request.endDate);
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
        structuredLog('info', GoogleAnalytics4.SERVICE_NAME, 'Cache hit', {
          cacheKey,
          durationMs: Date.now() - startTime,
        });
        return cached.data;
      }
    }

    try {
      const response = await this.executeWithRateLimit(() =>
        this.executeReportRequest(adjustedRequest),
      );

      const metrics = this.mapMetricsDynamically(response, adjustedRequest.metrics || []);

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

      const duration = Date.now() - startTime;
      structuredLog('info', GoogleAnalytics4.SERVICE_NAME, 'Report executed', {
        metricsCount: deduplicated.length,
        durationMs: duration,
      });

      return deduplicated;
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', GoogleAnalytics4.SERVICE_NAME, 'Report execution failed', {
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      throw error;
    }
  }

  async getPageMetrics(
    pagePath: string,
    startDate: string,
    endDate: string,
    options?: GA4PageMetricsOptions,
  ): Promise<ReadonlyArray<GA4Metrics>> {
    validatePagePath(pagePath);
    validateDateRange(startDate, endDate);
    return this.runReport(
      {
        startDate,
        endDate,
        dimensions: ['date', 'pagePath'],
        metrics: [
          'screenPageViews',
          'sessions',
          'totalUsers',
          'bounceRate',
          'averageSessionDuration',
          'conversions',
          'totalRevenue',
        ],
        dimensionFilter: {
          filter: {
            fieldName: 'pagePath',
            stringFilter: {
              matchType: 'CONTAINS',
              value: pagePath,
            },
          },
        },
      },
      options,
    );
  }

  private adjustRequestForIncremental(
    request: GA4ReportRequest,
    cacheKey: string,
  ): GA4ReportRequest {
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

  private async executeReportRequest(request: GA4ReportRequest): Promise<GA4ReportResponse> {
    const url = `${GoogleAnalytics4.API_BASE}/properties/${this.config.propertyId}:runReport`;
    const requestBody = this.buildRequestBody(request);

    try {
      const response = await retry(
        async () => {
          const start = Date.now();
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.config.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          structuredLog('info', GoogleAnalytics4.SERVICE_NAME, 'API request completed', {
            url,
            status: res.status,
            latencyMs: Date.now() - start,
          });

          if (!res.ok) {
            const error = await this.parseError(res);
            throw error;
          }

          return res.json() as Promise<GA4ReportResponse>;
        },
        {
          maxAttempts: this.config.maxRetries,
          initialDelay: GoogleAnalytics4.DEFAULT_RETRY_DELAY,
          retryableErrors: GoogleAnalytics4.RETRYABLE_ERRORS,
          onRetry: (attempt, err) => {
            structuredLog('warn', GoogleAnalytics4.SERVICE_NAME, 'Retrying API request', {
              attempt,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (response.nextPageToken && request.limit) {
        const nextPage = await this.executeReportRequest({
          ...request,
          offset: (request.offset || 0) + request.limit,
        });
        return {
          ...response,
          rows: [...(response.rows || []), ...(nextPage.rows || [])],
        };
      }

      return response;
    } catch (error) {
      if (error instanceof GA4Error) {
        throw error;
      }
      throw new GA4Error(
        GA4ErrorType.UNKNOWN,
        `GA4 API error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private buildRequestBody(request: GA4ReportRequest): GA4RequestBody {
    const body: GA4RequestBody = {
      dateRanges: [
        {
          startDate: request.startDate,
          endDate: request.endDate,
          name: 'date_range',
        },
      ],
      dimensions: (request.dimensions || []).map((dim) => ({ name: dim })),
      metrics: (request.metrics || []).map((met) => ({ name: met })),
      limit: request.limit || GoogleAnalytics4.DEFAULT_LIMIT,
      offset: request.offset || 0,
      keepEmptyRows: request.keepEmptyRows || false,
    };

    if (this.config.timezone && this.config.timezone !== GoogleAnalytics4.DEFAULT_TIMEZONE) {
      body.timeZone = this.config.timezone;
    }

    if (request.currencyCode) {
      body.currencyCode = request.currencyCode;
    }

    if (request.dimensionFilter) {
      body.dimensionFilter = request.dimensionFilter;
    }

    if (request.metricFilter) {
      body.metricFilter = request.metricFilter;
    }

    if (request.orderBys) {
      body.orderBys = request.orderBys;
    }

    if (request.cohortSpec) {
      body.cohortSpec = request.cohortSpec;
    }

    return body;
  }

  private async parseError(response: Response): Promise<GA4Error> {
    const status = response.status;
    let errorData: GA4ErrorData = {};

    try {
      errorData = (await response.json()) as GA4ErrorData;
    } catch {
    }

    const errorMessage = errorData.error?.message || response.statusText;
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfter = retryAfterHeader
      ? parseInt(retryAfterHeader, 10) * GoogleAnalytics4.MS_PER_SECOND
      : undefined;

    return this.createErrorFromStatus(status, errorMessage, retryAfter);
  }

  private createErrorFromStatus(
    status: number,
    errorMessage: string,
    retryAfter?: number,
  ): GA4Error {
    switch (status) {
      case GoogleAnalytics4.HTTP_STATUS_UNAUTHORIZED:
        return new GA4Error(
          GA4ErrorType.AUTHENTICATION_FAILED,
          `Authentication failed: ${errorMessage}`,
          status,
        );
      case GoogleAnalytics4.HTTP_STATUS_FORBIDDEN:
        return this.createForbiddenError(errorMessage, status, retryAfter);
      case GoogleAnalytics4.HTTP_STATUS_TOO_MANY_REQUESTS:
        return new GA4Error(
          GA4ErrorType.RATE_LIMIT_EXCEEDED,
          `Rate limit exceeded: ${errorMessage}`,
          status,
          retryAfter,
        );
      case GoogleAnalytics4.HTTP_STATUS_BAD_REQUEST:
        return new GA4Error(
          GA4ErrorType.INVALID_REQUEST,
          `Invalid request: ${errorMessage}`,
          status,
        );
      case GoogleAnalytics4.HTTP_STATUS_INTERNAL_ERROR:
      case GoogleAnalytics4.HTTP_STATUS_BAD_GATEWAY:
      case GoogleAnalytics4.HTTP_STATUS_SERVICE_UNAVAILABLE:
        return new GA4Error(
          GA4ErrorType.INTERNAL_ERROR,
          `GA4 internal error: ${errorMessage}`,
          status,
          retryAfter,
        );
      default:
        return new GA4Error(
          GA4ErrorType.UNKNOWN,
          `Unknown error: ${errorMessage}`,
          status,
        );
    }
  }

  private createForbiddenError(
    errorMessage: string,
    status: number,
    retryAfter?: number,
  ): GA4Error {
    if (errorMessage.toLowerCase().includes('quota')) {
      return new GA4Error(
        GA4ErrorType.QUOTA_EXCEEDED,
        `Quota exceeded: ${errorMessage}`,
        status,
        retryAfter,
      );
    }
    return new GA4Error(
      GA4ErrorType.INVALID_PROPERTY,
      `Invalid property or insufficient permissions: ${errorMessage}`,
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
            this.rateLimitState.remainingRequests = GoogleAnalytics4.DEFAULT_RATE_LIMIT_REQUESTS;
            this.rateLimitState.resetTime = Date.now() + GoogleAnalytics4.DEFAULT_RATE_LIMIT_RESET_MS;
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
          if (error instanceof GA4Error && error.type === GA4ErrorType.RATE_LIMIT_EXCEEDED) {
            const retryAfter = error.retryAfter || GoogleAnalytics4.DEFAULT_RATE_LIMIT_RESET_MS;
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
    response: GA4ReportResponse,
    requestedMetrics: readonly string[],
  ): ReadonlyArray<GA4Metrics> {
    if (!response.rows || response.rows.length === 0) {
      return [];
    }

    return response.rows.map((row) => {
      const dimensionValues = row.dimensionValues || [];
      const metricValues = row.metricValues || [];
      const metrics: Record<string, unknown> = {};

      const { dateIndex, pagePathIndex } = this.findDimensionIndices(dimensionValues);

      if (dateIndex >= 0) {
        metrics.date = this.formatDate(dimensionValues[dateIndex].value);
      }

      if (pagePathIndex >= 0) {
        metrics.pagePath = dimensionValues[pagePathIndex].value;
      }

      requestedMetrics.forEach((metricName, index) => {
        if (metricValues[index]) {
          const value = metricValues[index].value;
          const numericValue = parseFloat(value) || 0;
          this.mapMetricToStandardName(metrics, metricName, numericValue);
        }
      });

      return this.buildMetricsObject(metrics, dimensionValues);
    });
  }

  private findDimensionIndices(
    dimensionValues: ReadonlyArray<{ readonly value: string }>,
  ): { readonly dateIndex: number; readonly pagePathIndex: number } {
    let dateIndex = -1;
    let pagePathIndex = -1;

    dimensionValues.forEach((dim, index) => {
      const value = dim.value;
      if (GoogleAnalytics4.DATE_PATTERN.test(value)) {
        dateIndex = index;
      } else if (value.startsWith(GoogleAnalytics4.PAGE_PATH_PREFIX)) {
        pagePathIndex = index;
      }
    });

    return { dateIndex, pagePathIndex };
  }

  private mapMetricToStandardName(
    metrics: Record<string, unknown>,
    metricName: string,
    numericValue: number,
  ): void {
    switch (metricName) {
      case 'screenPageViews':
        metrics.pageViews = numericValue;
        break;
      case 'sessions':
        metrics.sessions = numericValue;
        break;
      case 'totalUsers':
      case 'activeUsers':
        metrics.users = numericValue;
        break;
      case 'bounceRate':
        metrics.bounceRate = numericValue;
        break;
      case 'averageSessionDuration':
        metrics.avgSessionDuration = numericValue;
        break;
      case 'conversions':
      case 'keyEvents':
        metrics.conversions = numericValue;
        break;
      case 'totalRevenue':
      case 'purchaseRevenue':
        metrics.revenue = numericValue;
        break;
      default:
        metrics[metricName] = numericValue;
    }
  }

  private buildMetricsObject(
    metrics: Record<string, unknown>,
    dimensionValues: ReadonlyArray<{ readonly value: string }>,
  ): GA4Metrics {
    return {
      pageViews: (metrics.pageViews as number) || 0,
      sessions: (metrics.sessions as number) || 0,
      users: (metrics.users as number) || 0,
      bounceRate: (metrics.bounceRate as number) || 0,
      avgSessionDuration: (metrics.avgSessionDuration as number) || 0,
      conversions: (metrics.conversions as number) || 0,
      revenue: (metrics.revenue as number) || 0,
      date: (metrics.date as string) || dimensionValues[0]?.value || '',
      pagePath: metrics.pagePath as string | undefined,
      ...metrics,
    };
  }

  private formatDate(dateStr: string): string {
    if (dateStr.length === GoogleAnalytics4.DATE_FORMAT_LENGTH) {
      return `${dateStr.substring(
        GoogleAnalytics4.DATE_YEAR_START,
        GoogleAnalytics4.DATE_YEAR_END,
      )}-${dateStr.substring(
        GoogleAnalytics4.DATE_MONTH_START,
        GoogleAnalytics4.DATE_MONTH_END,
      )}-${dateStr.substring(GoogleAnalytics4.DATE_DAY_START, GoogleAnalytics4.DATE_DAY_END)}`;
    }
    return dateStr;
  }

  private validateDataQuality(
    metrics: ReadonlyArray<GA4Metrics>,
    request: GA4ReportRequest,
  ): GA4DataQualityCheck {
    const check: GA4DataQualityCheck = {
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

    const expectedDays = getDaysBetween(request.startDate, request.endDate);
    const actualDays = new Set(metrics.map((m) => m.date)).size;

    if (actualDays < expectedDays * GoogleAnalytics4.COMPLETENESS_THRESHOLD) {
      check.completeness = actualDays / expectedDays;
      check.anomalies = [`Missing ${expectedDays - actualDays} days of data`];
    }

    this.checkAnomalies(metrics, check);
    this.checkDataFreshness(metrics, check);

    return check;
  }

  private checkAnomalies(metrics: ReadonlyArray<GA4Metrics>, check: GA4DataQualityCheck): void {
    metrics.forEach((metric) => {
      if (metric.pageViews < 0) {
        check.anomalies = [...check.anomalies, `Negative page views on ${metric.date}`];
      }
      if (metric.bounceRate > GoogleAnalytics4.BOUNCE_RATE_MAX) {
        check.anomalies = [...check.anomalies, `Bounce rate > 100% on ${metric.date}`];
      }
      if (metric.revenue < 0) {
        check.anomalies = [...check.anomalies, `Negative revenue on ${metric.date}`];
      }
    });
  }

  private checkDataFreshness(
    metrics: ReadonlyArray<GA4Metrics>,
    check: GA4DataQualityCheck,
  ): void {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const latestDate = metrics
      .map((m) => new Date(m.date).getTime())
      .reduce((a, b) => Math.max(a, b), 0);
    const daysSinceLatest = (Date.now() - latestDate) / MS_PER_DAY;

    if (daysSinceLatest > GoogleAnalytics4.DAYS_FRESHNESS_THRESHOLD) {
      check.freshness = Math.max(
        0,
        1 - daysSinceLatest / GoogleAnalytics4.DAYS_FRESHNESS_DIVISOR,
      );
      check.anomalies = [
        ...check.anomalies,
        `Data is ${Math.round(daysSinceLatest)} days old`,
      ];
    }
  }

  private aggregateData(
    metrics: ReadonlyArray<GA4Metrics>,
    aggregate: {
      readonly function: 'sum' | 'average' | 'count' | 'min' | 'max';
      readonly groupBy?: readonly string[];
    },
  ): ReadonlyArray<GA4Metrics> {
    if (!aggregate.groupBy || aggregate.groupBy.length === 0) {
      return [this.aggregateAllData(metrics, aggregate.function)];
    }

    return this.aggregateByGroup(metrics, aggregate);
  }

  private aggregateAllData(
    metrics: ReadonlyArray<GA4Metrics>,
    func: 'sum' | 'average' | 'count' | 'min' | 'max',
  ): GA4Metrics {
    const aggregated: Record<string, unknown> = {};

    GoogleAnalytics4.NUMERIC_FIELDS.forEach((field) => {
      const values = metrics.map((m) => (m as Record<string, unknown>)[field] as number || 0);
      aggregated[field] = applyAggregationFunction(values, func);
    });

    return aggregated as GA4Metrics;
  }

  private aggregateByGroup(
    metrics: ReadonlyArray<GA4Metrics>,
    aggregate: {
      readonly function: 'sum' | 'average' | 'count' | 'min' | 'max';
      readonly groupBy: readonly string[];
    },
  ): ReadonlyArray<GA4Metrics> {
    const groups = new Map<string, GA4Metrics[]>();

    metrics.forEach((metric) => {
      const key = aggregate.groupBy
        .map((dim) => (metric as Record<string, unknown>)[dim] as string || '')
        .join(GoogleAnalytics4.DEDUP_SEPARATOR);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(metric);
    });

    const result: GA4Metrics[] = [];
    groups.forEach((groupMetrics) => {
      const aggregated = this.aggregateAllData(groupMetrics, aggregate.function);
      aggregate.groupBy.forEach((dim) => {
        (aggregated as Record<string, unknown>)[dim] = (groupMetrics[0] as Record<string, unknown>)[dim];
      });
      result.push(aggregated);
    });

    return result;
  }

  private deduplicateData(metrics: ReadonlyArray<GA4Metrics>): ReadonlyArray<GA4Metrics> {
    const seen = new Set<string>();
    const unique: GA4Metrics[] = [];

    metrics.forEach((metric) => {
      const hash = `${metric.date}${GoogleAnalytics4.DEDUP_SEPARATOR}${metric.pagePath || ''}`;
      const dataHash = hashData(metric);

      if (!seen.has(hash) && !this.processedDataHashes.has(dataHash)) {
        seen.add(hash);
        this.processedDataHashes.add(dataHash);
        unique.push(metric);
      }
    });

    return unique;
  }

  private generateCacheKey(request: GA4ReportRequest): string {
    return `ga4${GoogleAnalytics4.CACHE_KEY_SEPARATOR}${this.config.propertyId}${GoogleAnalytics4.CACHE_KEY_SEPARATOR}${JSON.stringify(request)}`;
  }
}

export class GoogleSearchConsole {
  private readonly config: Required<SearchConsoleConfig>;
  private static readonly SERVICE_NAME = 'GoogleSearchConsole';
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
  private static readonly DAYS_FRESHNESS_THRESHOLD = 3;
  private static readonly DAYS_FRESHNESS_DIVISOR = 7;
  private static readonly COMPLETENESS_THRESHOLD = 0.9;
  private static readonly CTR_MIN = 0;
  private static readonly CTR_MAX = 1;
  private static readonly DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;
  private static readonly CACHE_KEY_SEPARATOR = ':';
  private static readonly DEDUP_SEPARATOR = '|';
  private static readonly CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly RETRYABLE_ERRORS: readonly string[] = ['network', 'timeout', 'server_error'] as const;
  private static readonly HTTP_STATUS_UNAUTHORIZED = 401;
  private static readonly HTTP_STATUS_FORBIDDEN = 403;
  private static readonly HTTP_STATUS_BAD_REQUEST = 400;
  private static readonly HTTP_STATUS_TOO_MANY_REQUESTS = 429;
  private static readonly HTTP_STATUS_INTERNAL_ERROR = 500;
  private static readonly HTTP_STATUS_BAD_GATEWAY = 502;
  private static readonly HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
  private static readonly SITEMAP_PATHS: readonly string[] = [
    '/sitemap.xml',
    '/sitemap_blog.xml',
    '/blogs/sitemap.xml',
  ] as const;

  private readonly cache: Map<string, GSCCacheEntry>;
  private readonly rateLimitState: MutableRateLimitState;
  private readonly lastSyncTimestamps: Map<string, number>;
  private readonly processedDataHashes: Set<string>;
  private cacheCleanupInterval?: number;

  constructor(config: SearchConsoleConfig) {
    validateAccessToken(config.accessToken);
    validateSiteUrl(config.siteUrl);
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
    this.startCacheCleanup();
  }

  destroy(): void {
    if (this.cacheCleanupInterval !== undefined) {
      clearInterval(this.cacheCleanupInterval);
      this.cacheCleanupInterval = undefined;
    }
    this.cache.clear();
    this.processedDataHashes.clear();
    this.lastSyncTimestamps.clear();
  }

  private startCacheCleanup(): void {
    this.cacheCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.cache.entries()) {
        if (entry.expiresAt < now) {
          this.cache.delete(key);
        }
      }
    }, GoogleSearchConsole.CACHE_CLEANUP_INTERVAL_MS) as unknown as number;
  }

  async getSearchAnalytics(
    request: SearchConsoleRequest,
    options?: GSCSearchAnalyticsOptions,
  ): Promise<ReadonlyArray<SearchConsoleMetrics>> {
    const startTime = Date.now();
    validateDateRange(request.startDate, request.endDate);
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
        structuredLog('info', GoogleSearchConsole.SERVICE_NAME, 'Cache hit', {
          cacheKey,
          durationMs: Date.now() - startTime,
        });
        return cached.data;
      }
    }

    try {
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

      const duration = Date.now() - startTime;
      structuredLog('info', GoogleSearchConsole.SERVICE_NAME, 'Search analytics retrieved', {
        metricsCount: deduplicated.length,
        durationMs: duration,
      });

      return deduplicated;
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', GoogleSearchConsole.SERVICE_NAME, 'Search analytics retrieval failed', {
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      throw error;
    }
  }

  async getPageMetrics(
    pageUrl: string,
    startDate: string,
    endDate: string,
    options?: GSCPageMetricsOptions,
  ): Promise<ReadonlyArray<SearchConsoleMetrics>> {
    validatePagePath(pageUrl);
    validateDateRange(startDate, endDate);
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
    validateSitemapUrl(sitemapUrl);
    const url = `${GoogleSearchConsole.API_BASE}/sites/${encodeURIComponent(this.config.siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;

    try {
      await retry(
        async () => {
          const start = Date.now();
          const res = await fetch(url, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${this.config.accessToken}`,
              'Content-Type': 'application/json',
            },
          });

          structuredLog('info', GoogleSearchConsole.SERVICE_NAME, 'Sitemap submission request', {
            url,
            status: res.status,
            latencyMs: Date.now() - start,
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
          onRetry: (attempt, err) => {
            structuredLog('warn', GoogleSearchConsole.SERVICE_NAME, 'Retrying sitemap submission', {
              attempt,
              error: err instanceof Error ? err.message : String(err),
            });
          },
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
    if (!articleUrl || typeof articleUrl !== 'string' || articleUrl.trim().length === 0) {
      throw new Error('Invalid article URL: must be a non-empty string');
    }
    try {
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
    } catch (error) {
      structuredLog('error', GoogleSearchConsole.SERVICE_NAME, 'Failed to submit sitemap for article', {
        articleUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listSitemaps(): Promise<ReadonlyArray<GSCSitemapInfo>> {
    const url = `${GoogleSearchConsole.API_BASE}/sites/${encodeURIComponent(this.config.siteUrl)}/sitemaps`;

    try {
      const response = await retry(
        async () => {
          const start = Date.now();
          const res = await fetch(url, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${this.config.accessToken}`,
              'Content-Type': 'application/json',
            },
          });

          structuredLog('info', GoogleSearchConsole.SERVICE_NAME, 'List sitemaps request', {
            url,
            status: res.status,
            latencyMs: Date.now() - start,
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
          onRetry: (attempt, err) => {
            structuredLog('warn', GoogleSearchConsole.SERVICE_NAME, 'Retrying list sitemaps', {
              attempt,
              error: err instanceof Error ? err.message : String(err),
            });
          },
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

  async detectSitemapUrl(): Promise<string | null> {
    try {
      const sitemaps = await this.listSitemaps();

      if (sitemaps.length === 0) {
        return null;
      }

      const sitemapXml = sitemaps.find((s) =>
        s.path.includes('sitemap.xml') &&
        !s.path.includes('sitemap_index') &&
        !s.isSitemapsIndex &&
        (s.type === 'sitemap' || !s.type)
      );
      if (sitemapXml) {
        return sitemapXml.path;
      }

      const sitemapIndex = sitemaps.find((s) =>
        s.isSitemapsIndex ||
        s.path.includes('sitemap_index')
      );
      if (sitemapIndex) {
        return sitemapIndex.path;
      }

      const anySitemap = sitemaps.find((s) => s.type === 'sitemap');
      if (anySitemap) {
        return anySitemap.path;
      }

      return sitemaps[0]?.path || null;
    } catch (error) {
      structuredLog('warn', GoogleSearchConsole.SERVICE_NAME, 'Failed to detect sitemap URL', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async submitSitemapUrl(sitemapUrl: string): Promise<GSCSitemapResult> {
    validateSitemapUrl(sitemapUrl);
    let feedpath = sitemapUrl;

    try {
      const urlObj = new URL(sitemapUrl);
      const siteUrlObj = new URL(this.config.siteUrl);

      if (urlObj.host === siteUrlObj.host) {
        feedpath = urlObj.pathname + (urlObj.search || '');
      } else {
        feedpath = sitemapUrl;
      }
    } catch {
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
          const start = Date.now();
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.config.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          structuredLog('info', GoogleSearchConsole.SERVICE_NAME, 'Search analytics API request', {
            url,
            status: res.status,
            latencyMs: Date.now() - start,
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
          onRetry: (attempt, err) => {
            structuredLog('warn', GoogleSearchConsole.SERVICE_NAME, 'Retrying search analytics request', {
              attempt,
              error: err instanceof Error ? err.message : String(err),
            });
          },
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
      const expectedDays = getDaysBetween(request.startDate, request.endDate);
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
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const latestDate = metrics
      .map((m) => new Date(m.date).getTime())
      .reduce((a, b) => Math.max(a, b), 0);
    const daysSinceLatest = (Date.now() - latestDate) / MS_PER_DAY;

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
      clicks: applyAggregationFunction(clicks, func),
      impressions: applyAggregationFunction(impressions, func),
      position: applyAggregationFunction(positions, func),
      ctr: 0,
      date: '',
    };

    const aggregatedImpressions = aggregated.impressions as number;
    const aggregatedClicks = aggregated.clicks as number;
    aggregated.ctr = aggregatedImpressions > 0 ? aggregatedClicks / aggregatedImpressions : 0;

    return aggregated as SearchConsoleMetrics;
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
      const dataHash = hashData(metric);

      if (!seen.has(hash) && !this.processedDataHashes.has(dataHash)) {
        seen.add(hash);
        this.processedDataHashes.add(dataHash);
        unique.push(metric);
      }
    });

    return unique;
  }

  private generateCacheKey(request: SearchConsoleRequest): string {
    return `gsc${GoogleSearchConsole.CACHE_KEY_SEPARATOR}${this.config.siteUrl}${GoogleSearchConsole.CACHE_KEY_SEPARATOR}${JSON.stringify(request)}`;
  }
}
