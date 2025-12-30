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


export class GoogleAnalytics4 {
  private readonly config: Required<GA4Config>;
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
  private static readonly SECONDS_PER_MINUTE = 60;
  private static readonly MS_PER_MINUTE = GoogleAnalytics4.MS_PER_SECOND * GoogleAnalytics4.SECONDS_PER_MINUTE;
  private static readonly MS_PER_HOUR = GoogleAnalytics4.MS_PER_MINUTE * 60;
  private static readonly MS_PER_DAY = GoogleAnalytics4.MS_PER_HOUR * 24;
  private static readonly DAYS_FRESHNESS_THRESHOLD = 2;
  private static readonly DAYS_FRESHNESS_DIVISOR = 7;
  private static readonly COMPLETENESS_THRESHOLD = 0.9;
  private static readonly BOUNCE_RATE_MAX = 1;
  private static readonly DATE_PATTERN = /^\d{8}$/;
  private static readonly PAGE_PATH_PREFIX = '/';
  private static readonly CACHE_KEY_SEPARATOR = ':';
  private static readonly DEDUP_SEPARATOR = '|';
  private static readonly HASH_SHIFT = 5;
  private static readonly NUMERIC_FIELDS: readonly string[] = [
    'pageViews',
    'sessions',
    'users',
    'conversions',
    'revenue',
    'avgSessionDuration',
  ];
  private static readonly RETRYABLE_ERRORS: readonly string[] = ['network', 'timeout', 'server_error'];
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

  constructor(config: GA4Config) {
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
  }

  async runReport(
    request: GA4ReportRequest,
    options?: GA4ReportOptions,
  ): Promise<ReadonlyArray<GA4Metrics>> {
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

    return deduplicated;
  }

  async getPageMetrics(
    pagePath: string,
    startDate: string,
    endDate: string,
    options?: GA4PageMetricsOptions,
  ): Promise<ReadonlyArray<GA4Metrics>> {
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

          return res.json() as Promise<GA4ReportResponse>;
        },
        {
          maxAttempts: this.config.maxRetries,
          initialDelay: GoogleAnalytics4.DEFAULT_RETRY_DELAY,
          retryableErrors: GoogleAnalytics4.RETRYABLE_ERRORS,
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

    const expectedDays = this.getDaysBetween(request.startDate, request.endDate);
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
    const latestDate = metrics
      .map((m) => new Date(m.date).getTime())
      .reduce((a, b) => Math.max(a, b), 0);
    const daysSinceLatest = (Date.now() - latestDate) / GoogleAnalytics4.MS_PER_DAY;

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

  private getDaysBetween(startDate: string, endDate: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    return Math.ceil((end.getTime() - start.getTime()) / GoogleAnalytics4.MS_PER_DAY) + 1;
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
      aggregated[field] = this.applyAggregationFunction(values, func);
    });

    return aggregated as GA4Metrics;
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
      const dataHash = this.hashData(metric);

      if (!seen.has(hash) && !this.processedDataHashes.has(dataHash)) {
        seen.add(hash);
        this.processedDataHashes.add(dataHash);
        unique.push(metric);
      }
    });

    return unique;
  }

  private hashData(data: GA4Metrics): string {
    const str = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << GoogleAnalytics4.HASH_SHIFT) - hash + char;
      hash = hash & hash;
    }
    return hash.toString();
  }

  private generateCacheKey(request: GA4ReportRequest): string {
    return `ga4${GoogleAnalytics4.CACHE_KEY_SEPARATOR}${this.config.propertyId}${GoogleAnalytics4.CACHE_KEY_SEPARATOR}${JSON.stringify(request)}`;
  }
}
