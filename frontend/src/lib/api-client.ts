import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  AxiosError,
  InternalAxiosRequestConfig,
} from 'axios';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { SettingsData } from '../hooks/useSettingsData';

type RequestPriority = 'low' | 'medium' | 'high' | 'critical';

type ErrorCategory = 'network' | 'timeout' | 'auth' | 'validation' | 'server' | 'client' | 'unknown';

interface RequestConfig extends Omit<AxiosRequestConfig, 'cancelToken'> {
  readonly priority?: RequestPriority;
  readonly timeout?: number;
  readonly retry?: RetryConfig;
  readonly cache?: CacheConfig;
  readonly deduplicate?: boolean;
  readonly cancelToken?: AbortController;
  readonly transform?: boolean;
  readonly validate?: boolean;
  readonly compress?: boolean;
  readonly batch?: boolean;
  readonly batchId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RetryConfig {
  readonly enabled?: boolean;
  readonly maxAttempts?: number;
  readonly initialDelay?: number;
  readonly maxDelay?: number;
  readonly backoffMultiplier?: number;
  readonly retryableErrors?: readonly string[];
}

export interface CacheConfig {
  readonly enabled?: boolean;
  readonly ttl?: number;
  readonly key?: string;
  readonly invalidateOn?: readonly string[];
}

interface RequestMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatency: number;
  cacheHits: number;
  cacheMisses: number;
  retries: number;
  timeouts: number;
  cancellations: number;
  byEndpoint: Map<string, EndpointMetrics>;
}

interface EndpointMetrics {
  count: number;
  success: number;
  failures: number;
  averageLatency: number;
  errors: Map<string, number>;
}

interface RequestLog {
  id: string;
  method: string;
  url: string;
  timestamp: number;
  duration?: number;
  status?: number;
  error?: string;
  cached?: boolean;
  retried?: boolean;
  priority?: RequestPriority;
}

interface Middleware {
  readonly name: string;
  readonly beforeRequest?: (
    config: RequestConfig,
  ) => RequestConfig | null | Promise<RequestConfig | null>;
  readonly afterResponse?: (response: AxiosResponse) => AxiosResponse | Promise<AxiosResponse>;
  readonly onError?: (error: AxiosError) => AxiosError | Promise<AxiosError>;
}

interface BatchRequest {
  readonly id: string;
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly url: string;
    readonly data?: unknown;
    readonly config?: RequestConfig;
  }>;
  readonly resolve: (results: readonly unknown[]) => void;
  readonly reject: (error: unknown) => void;
}

export class APIError extends Error {
  public readonly category: ErrorCategory;
  public readonly statusCode?: number;
  public readonly response?: unknown;
  public readonly request?: unknown;

  constructor(
    message: string,
    category: ErrorCategory,
    statusCode?: number,
    response?: unknown,
    request?: unknown,
  ) {
    super(message);
    this.name = 'APIError';
    this.category = category;
    this.statusCode = statusCode;
    this.response = response;
    this.request = request;
  }
}

interface APIClientConfig {
  readonly enableDeduplication?: boolean;
  readonly enableCaching?: boolean;
  readonly enableRetry?: boolean;
  readonly enableCompression?: boolean;
  readonly enableLogging?: boolean;
  readonly enableMetrics?: boolean;
  readonly enableBatching?: boolean;
  readonly enableRateLimiting?: boolean;
  readonly enableOffline?: boolean;
  readonly defaultTimeout?: number;
  readonly defaultRetry?: RetryConfig;
  readonly apiVersion?: string;
}

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_CACHE_TTL = 60000;
const DEFAULT_RATE_LIMIT = 100;
const DEFAULT_RATE_LIMIT_WINDOW = 60000;
const DEFAULT_BATCH_INTERVAL = 100;
const DEFAULT_OFFLINE_SYNC_INTERVAL = 5000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_INITIAL_RETRY_DELAY = 1000;
const DEFAULT_MAX_RETRY_DELAY = 30000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_RETRY_JITTER = 1000;
const MAX_LOG_ENTRIES = 1000;
const MAX_URL_LENGTH = 2048;
const MAX_STORE_ID_LENGTH = 200;
const MAX_SHOP_DOMAIN_LENGTH = 200;
const MAX_POST_ID_LENGTH = 200;
const MAX_CACHE_KEY_LENGTH = 1000;

const isRequestPriority = (priority: string | undefined): priority is RequestPriority => {
  return priority === 'low' || priority === 'medium' || priority === 'high' || priority === 'critical';
};

const validateUrl = (url: string | undefined): string | null => {
  if (!url || typeof url !== 'string') {
    return null;
  }
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) {
    return null;
  }
  return trimmed;
};

const validateStoreId = (storeId: string): string | null => {
  if (!storeId || typeof storeId !== 'string') {
    return null;
  }
  const trimmed = storeId.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_STORE_ID_LENGTH) {
    return null;
  }
  return trimmed;
};

const validateShopDomain = (shopDomain: string): string | null => {
  if (!shopDomain || typeof shopDomain !== 'string') {
    return null;
  }
  const trimmed = shopDomain.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SHOP_DOMAIN_LENGTH) {
    return null;
  }
  return trimmed;
};

const validatePostId = (postId: string): string | null => {
  if (!postId || typeof postId !== 'string') {
    return null;
  }
  const trimmed = postId.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_POST_ID_LENGTH) {
    return null;
  }
  return trimmed;
};

const validateCacheKey = (key: string): string | null => {
  if (!key || typeof key !== 'string') {
    return null;
  }
  const trimmed = key.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CACHE_KEY_LENGTH) {
    return null;
  }
  return trimmed;
};

const validateTimeout = (timeout: number | undefined): number => {
  if (timeout === undefined || timeout === null) {
    return DEFAULT_TIMEOUT;
  }
  if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
    return DEFAULT_TIMEOUT;
  }
  if (timeout < 0) {
    return DEFAULT_TIMEOUT;
  }
  return Math.floor(timeout);
};

const hasWindow = (): boolean => {
  return typeof window !== 'undefined';
};

const hasNavigator = (): boolean => {
  return typeof navigator !== 'undefined';
};

const safeGetNavigatorOnline = (): boolean => {
  if (!hasNavigator() || typeof navigator.onLine !== 'boolean') {
    return true;
  }
  return navigator.onLine;
};

interface ResponseWithData {
  readonly data?: unknown;
  readonly correlationId?: string;
  readonly error?: unknown;
}

const isWrappedResponse = (data: unknown): data is ResponseWithData => {
  return (
    data !== null &&
    typeof data === 'object' &&
    'data' in data &&
    !('error' in data)
  );
};

interface FrequencySettings {
  readonly generation_frequency?: string;
  readonly articles_per_period?: number;
}

const isFrequencySettings = (settings: unknown): settings is FrequencySettings => {
  return (
    settings !== null &&
    typeof settings === 'object' &&
    ('generation_frequency' in settings || 'articles_per_period' in settings)
  );
};

interface ServerErrorResponse {
  readonly error?: string;
  readonly message?: string;
  readonly errorCode?: string;
  readonly metadata?: {
    readonly errorCode?: string;
    readonly debugInfo?: unknown;
  };
  readonly debugInfo?: unknown;
}

const extractErrorMessage = (responseData: unknown): string => {
  if (!responseData || typeof responseData !== 'object') {
    return 'Request failed';
  }
  const data = responseData as ServerErrorResponse;
  return data.error || data.message || 'Request failed';
};

const extractErrorCode = (responseData: unknown): string | undefined => {
  if (!responseData || typeof responseData !== 'object') {
    return undefined;
  }
  const data = responseData as ServerErrorResponse;
  return data.metadata?.errorCode || data.errorCode;
};

class EnhancedAPIClient {
  private instance: AxiosInstance;
  private readonly pendingRequests: Map<string, Promise<unknown>> = new Map();
  private readonly requestQueue: Array<{
    readonly id: string;
    readonly config: RequestConfig;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private readonly cache: Map<string, { readonly data: unknown; readonly expiresAt: number }> =
    new Map();
  private metrics: RequestMetrics;
  private readonly logs: RequestLog[] = [];
  private middleware: Middleware[] = [];
  private readonly batchQueue: BatchRequest[] = [];
  private readonly rateLimiter: {
    count: number;
    resetAt: number;
    limit: number;
    window: number;
  } = {
    count: 0,
    resetAt: Date.now(),
    limit: DEFAULT_RATE_LIMIT,
    window: DEFAULT_RATE_LIMIT_WINDOW,
  };
  private offlineQueue: Array<{
    readonly id: string;
    readonly config: RequestConfig;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private isOnline: boolean = safeGetNavigatorOnline();
  private batchTimerId: ReturnType<typeof setInterval> | null = null;
  private offlineSyncTimerId: ReturnType<typeof setInterval> | null = null;
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;

  private readonly config: Required<APIClientConfig>;

  constructor(
    baseURL: string,
    private readonly supabaseClient: SupabaseClient,
    config: APIClientConfig = {},
  ) {
    this.config = {
      enableDeduplication: config.enableDeduplication ?? true,
      enableCaching: config.enableCaching ?? true,
      enableRetry: config.enableRetry ?? true,
      enableCompression: config.enableCompression ?? false,
      enableLogging: config.enableLogging ?? true,
      enableMetrics: config.enableMetrics ?? true,
      enableBatching: config.enableBatching ?? true,
      enableRateLimiting: config.enableRateLimiting ?? true,
      enableOffline: config.enableOffline ?? true,
      defaultTimeout: validateTimeout(config.defaultTimeout),
      defaultRetry: config.defaultRetry ?? {
        enabled: true,
        maxAttempts: DEFAULT_MAX_RETRY_ATTEMPTS,
        initialDelay: DEFAULT_INITIAL_RETRY_DELAY,
        maxDelay: DEFAULT_MAX_RETRY_DELAY,
        backoffMultiplier: DEFAULT_BACKOFF_MULTIPLIER,
      },
      apiVersion: config.apiVersion ?? '',
    };

    this.instance = axios.create({
      baseURL: validateUrl(baseURL) || baseURL,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: this.config.defaultTimeout,
    });

    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageLatency: 0,
      cacheHits: 0,
      cacheMisses: 0,
      retries: 0,
      timeouts: 0,
      cancellations: 0,
      byEndpoint: new Map(),
    };

    this.setupInterceptors();
    this.setupNetworkMonitoring();
    this.startBatchProcessor();
    this.startOfflineSync();
  }

  destroy(): void {
    if (this.batchTimerId !== null) {
      clearInterval(this.batchTimerId);
      this.batchTimerId = null;
    }
    if (this.offlineSyncTimerId !== null) {
      clearInterval(this.offlineSyncTimerId);
      this.offlineSyncTimerId = null;
    }
    if (hasWindow()) {
      if (this.onlineHandler) {
        window.removeEventListener('online', this.onlineHandler);
        this.onlineHandler = null;
      }
      if (this.offlineHandler) {
        window.removeEventListener('offline', this.offlineHandler);
        this.offlineHandler = null;
      }
    }
    this.pendingRequests.clear();
    this.requestQueue.length = 0;
    this.offlineQueue.length = 0;
    this.batchQueue.length = 0;
    this.cache.clear();
    this.middleware.length = 0;
    this.logs.length = 0;
  }

  private setupInterceptors(): void {
    this.instance.interceptors.request.use(
      async (config: InternalAxiosRequestConfig) => {
        const requestConfig = config as unknown as RequestConfig;

        for (const mw of this.middleware) {
          if (mw.beforeRequest) {
            try {
              const result = await mw.beforeRequest(requestConfig);
              if (result === null) {
                throw new APIError('Request cancelled by middleware', 'unknown');
              }
              Object.assign(config, result);
            } catch {
              throw new APIError('Request cancelled by middleware', 'unknown');
            }
          }
        }

        if (!config.headers.Authorization) {
          const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
          if (anonKey && typeof anonKey === 'string' && anonKey.trim().length > 0) {
            config.headers.Authorization = `Bearer ${anonKey}`;
          }
        }

        if (this.config.apiVersion) {
          config.headers['API-Version'] = this.config.apiVersion;
        }

        const requestId = this.generateRequestId();
        config.headers['X-Request-Id'] = requestId;

        if (this.config.enableCompression && config.data) {
          try {
            config.data = await this.compress(config.data);
            config.headers['Content-Encoding'] = 'gzip';
          } catch {
          }
        }

        if (this.config.enableLogging) {
          this.logRequest({
            id: requestId,
            method: config.method?.toUpperCase() || 'GET',
            url: config.url || '',
            timestamp: Date.now(),
            priority: isRequestPriority(requestConfig.priority)
              ? requestConfig.priority
              : undefined,
          });
        }

        return config;
      },
      (error: unknown) => {
        return Promise.reject(error);
      },
    );

    this.instance.interceptors.response.use(
      async (response: AxiosResponse) => {
        if (response.headers['content-encoding'] === 'gzip') {
          try {
            response.data = await this.decompress(response.data);
          } catch {
          }
        }

        for (const mw of this.middleware) {
          if (mw.afterResponse) {
            try {
              response = await mw.afterResponse(response);
            } catch {
            }
          }
        }

        const requestConfig = response.config as unknown as RequestConfig;
        if (requestConfig.transform !== false) {
          response.data = this.transformResponse(response.data);
        }

        return response;
      },
      async (error: AxiosError) => {
        for (const mw of this.middleware) {
          if (mw.onError) {
            try {
              error = await mw.onError(error);
            } catch {
            }
          }
        }

        const apiError = this.classifyError(error);

        if (this.config.enableLogging) {
          this.logError(apiError);
        }

        return Promise.reject(apiError);
      },
    );
  }

  private setupNetworkMonitoring(): void {
    if (!hasWindow()) {
      return;
    }

    this.onlineHandler = () => {
      this.isOnline = true;
      this.syncOfflineQueue().catch(() => {
      });
    };

    this.offlineHandler = () => {
      this.isOnline = false;
    };

    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
  }

  private async request<T>(config: RequestConfig): Promise<T> {
    const startTime = Date.now();
    const requestId =
      (config.metadata?.requestId &&
        typeof config.metadata.requestId === 'string' &&
        config.metadata.requestId) ||
      this.generateRequestId();
    const cacheKey = this.getCacheKey(config);

    if (this.config.enableCaching && config.cache?.enabled !== false) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        this.metrics.cacheHits++;
        const url = (config as unknown as AxiosRequestConfig).url;
        if (this.config.enableMetrics && url) {
          this.updateMetrics(url, true, Date.now() - startTime);
        }
        return cached.data as T;
      }
      this.metrics.cacheMisses++;
    }

    if (this.config.enableDeduplication && config.deduplicate !== false) {
      const dedupeKey = this.getDedupeKey(config);
      const existingPromise = this.pendingRequests.get(dedupeKey);
      if (existingPromise) {
        return existingPromise as Promise<T>;
      }
    }

    if (this.config.enableRateLimiting && !this.checkRateLimit()) {
      return new Promise<T>((resolve, reject) => {
        this.requestQueue.push({
          id: requestId,
          config,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        this.processQueue();
      });
    }

    if (!this.isOnline && this.config.enableOffline) {
      return new Promise<T>((resolve, reject) => {
        this.offlineQueue.push({
          id: requestId,
          config,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        reject(new APIError('Offline - request queued', 'network'));
      });
    }

    const requestPromise = this.executeRequest<T>(config, requestId, startTime);

    if (this.config.enableDeduplication && config.deduplicate !== false) {
      const dedupeKey = this.getDedupeKey(config);
      this.pendingRequests.set(dedupeKey, requestPromise);
      requestPromise.finally(() => {
        setTimeout(() => {
          this.pendingRequests.delete(dedupeKey);
        }, 100);
      });
    }

    return requestPromise;
  }

  private async executeRequest<T>(
    config: RequestConfig,
    requestId: string,
    startTime: number,
  ): Promise<T> {
    let attempts = 0;
    const retryConfig = config.retry || this.config.defaultRetry || { enabled: false };
    const maxAttempts = retryConfig.maxAttempts || DEFAULT_MAX_RETRY_ATTEMPTS;

    while (attempts < maxAttempts) {
      try {
        if (config.cancelToken?.signal.aborted) {
          this.metrics.cancellations++;
          throw new APIError('Request cancelled', 'unknown');
        }

        const { cancelToken, ...axiosConfig } = config;
        const response = await this.instance.request<T>(
          axiosConfig as unknown as AxiosRequestConfig,
        );

        if (this.config.enableCaching && config.cache?.enabled !== false) {
          const cacheKey = this.getCacheKey(config);
          const ttl = config.cache?.ttl || DEFAULT_CACHE_TTL;
          this.cache.set(cacheKey, {
            data: response.data,
            expiresAt: Date.now() + ttl,
          });
        }

        const latency = Date.now() - startTime;
        this.metrics.successfulRequests++;
        this.metrics.totalRequests++;
        const url = (config as unknown as AxiosRequestConfig).url;
        if (this.config.enableMetrics && url) {
          this.updateMetrics(url, true, latency);
        }

        if (this.config.enableLogging) {
          this.logSuccess(requestId, latency, response.status);
        }

        return response.data;
      } catch (error: unknown) {
        attempts++;
        const isLastAttempt = attempts >= maxAttempts;

        const classifiedError = this.classifyError(error);

        if (
          !isLastAttempt &&
          retryConfig.enabled &&
          this.isRetryable(classifiedError, retryConfig)
        ) {
          const delay = this.calculateRetryDelay(attempts, retryConfig);
          this.metrics.retries++;
          try {
            await this.sleep(delay);
          } catch {
          }
          continue;
        }

        const latency = Date.now() - startTime;
        this.metrics.failedRequests++;
        this.metrics.totalRequests++;
        const url = (config as unknown as AxiosRequestConfig).url;
        if (this.config.enableMetrics && url) {
          this.updateMetrics(url, false, latency);
        }

        if (this.config.enableLogging) {
          this.logError(classifiedError, requestId, latency);
        }

        throw classifiedError;
      }
    }

    throw new APIError('Max retry attempts exceeded', 'unknown');
  }

  private classifyError(error: unknown): APIError {
    if (error instanceof APIError) {
      return error;
    }

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const message = axiosError.message || 'Request failed';
      const errorCode = axiosError.code;
      const responseData = axiosError.response?.data;

      if (errorCode === 'ECONNABORTED' || message.includes('timeout')) {
        this.metrics.timeouts++;
        return new APIError(message, 'timeout', status, responseData, axiosError.request);
      }

      if (status === 401 || status === 403) {
        return new APIError(message, 'auth', status, responseData, axiosError.request);
      }

      if (status === 400 || status === 422) {
        return new APIError(message, 'validation', status, responseData, axiosError.request);
      }

      if (status && status >= 500) {
        const errorMessage = extractErrorMessage(responseData);
        return new APIError(errorMessage, 'server', status, responseData, axiosError.request);
      }

      if (status && status >= 400) {
        return new APIError(message, 'client', status, responseData, axiosError.request);
      }

      if (errorCode === 'ERR_NETWORK' || errorCode === 'ECONNRESET') {
        return new APIError(message, 'network', status, responseData, axiosError.request);
      }
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return new APIError(errorMessage || 'Unknown error', 'unknown', undefined, undefined, error);
  }

  private isRetryable(error: unknown, retryConfig: RetryConfig): boolean {
    if (error instanceof APIError) {
      const retryableCategories: ErrorCategory[] = ['network', 'timeout', 'server'];
      if (retryableCategories.includes(error.category)) {
        return true;
      }
    }

    if (retryConfig.retryableErrors && Array.isArray(retryConfig.retryableErrors)) {
      const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      return retryConfig.retryableErrors.some((pattern) => {
        if (typeof pattern !== 'string') {
          return false;
        }
        return errorMessage.includes(pattern.toLowerCase());
      });
    }

    return false;
  }

  private calculateRetryDelay(attempt: number, retryConfig: RetryConfig): number {
    const initialDelay = retryConfig.initialDelay || DEFAULT_INITIAL_RETRY_DELAY;
    const maxDelay = retryConfig.maxDelay || DEFAULT_MAX_RETRY_DELAY;
    const multiplier = retryConfig.backoffMultiplier || DEFAULT_BACKOFF_MULTIPLIER;

    const delay = Math.min(initialDelay * Math.pow(multiplier, attempt - 1), maxDelay);
    return delay + Math.random() * DEFAULT_RETRY_JITTER;
  }

  private getCacheKey(config: RequestConfig): string {
    if (config.cache?.key) {
      const validated = validateCacheKey(config.cache.key);
      if (validated) {
        return validated;
      }
    }
    const method = (config as unknown as AxiosRequestConfig).method || 'GET';
    const url = (config as unknown as AxiosRequestConfig).url || '';
    const params = (config as unknown as AxiosRequestConfig).params || {};
    const data = (config as unknown as AxiosRequestConfig).data || {};
    try {
      return `${method}:${url}:${JSON.stringify(params)}:${JSON.stringify(data)}`;
    } catch {
      return `${method}:${url}`;
    }
  }

  private getDedupeKey(config: RequestConfig): string {
    const method = (config as unknown as AxiosRequestConfig).method || 'GET';
    const url = (config as unknown as AxiosRequestConfig).url || '';
    const data = (config as unknown as AxiosRequestConfig).data || {};
    try {
      return `${method}:${url}:${JSON.stringify(data)}`;
    } catch {
      return `${method}:${url}`;
    }
  }

  private transformResponse(data: unknown): unknown {
    if (isWrappedResponse(data)) {
      return data.data;
    }
    return data;
  }

  private async compress(data: unknown): Promise<unknown> {
    return data;
  }

  private async decompress(data: unknown): Promise<unknown> {
    return data;
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    if (now > this.rateLimiter.resetAt) {
      this.rateLimiter.count = 0;
      this.rateLimiter.resetAt = now + this.rateLimiter.window;
    }

    if (this.rateLimiter.count >= this.rateLimiter.limit) {
      return false;
    }

    this.rateLimiter.count++;
    return true;
  }

  private processQueue(): void {
    if (this.requestQueue.length === 0 || !this.checkRateLimit()) {
      return;
    }

    const priorityOrder: Record<RequestPriority, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
    };

    this.requestQueue.sort((a, b) => {
      const aPriority = priorityOrder[a.config.priority || 'medium'] || 2;
      const bPriority = priorityOrder[b.config.priority || 'medium'] || 2;
      return bPriority - aPriority;
    });

    const item = this.requestQueue.shift();
    if (item) {
      this.request(item.config)
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          setTimeout(() => {
            this.processQueue();
          }, 100);
        });
    }
  }

  private startBatchProcessor(): void {
    if (!this.config.enableBatching || !hasWindow()) {
      return;
    }

    this.batchTimerId = setInterval(() => {
      if (this.batchQueue.length === 0) {
        return;
      }

      const batch = this.batchQueue.shift();
      if (batch) {
        this.executeBatch(batch).catch(() => {
        });
      }
    }, DEFAULT_BATCH_INTERVAL);
  }

  private async executeBatch(batch: BatchRequest): Promise<void> {
    try {
      const promises = batch.requests.map((req) => {
        const { cancelToken, ...axiosConfig } = req.config || {};
        return this.instance.request({
          method: req.method as AxiosRequestConfig['method'],
          url: req.url,
          data: req.data,
          ...axiosConfig,
        } as AxiosRequestConfig);
      });

      const results = await Promise.allSettled(promises);
      const data = results.map((result) =>
        result.status === 'fulfilled' ? result.value.data : { error: result.reason },
      );

      batch.resolve(data);
    } catch (error) {
      batch.reject(error);
    }
  }

  private startOfflineSync(): void {
    if (!this.config.enableOffline || !hasWindow()) {
      return;
    }

    this.offlineSyncTimerId = setInterval(() => {
      if (this.isOnline && this.offlineQueue.length > 0) {
        this.syncOfflineQueue().catch(() => {
        });
      }
    }, DEFAULT_OFFLINE_SYNC_INTERVAL);
  }

  private async syncOfflineQueue(): Promise<void> {
    const queue = [...this.offlineQueue];
    this.offlineQueue.length = 0;

    for (const item of queue) {
      try {
        const result = await this.request(item.config);
        item.resolve(result);
      } catch (error) {
        if (!this.isOnline) {
          this.offlineQueue.push(item);
        } else {
          item.reject(error);
        }
      }
    }
  }

  private updateMetrics(endpoint: string, success: boolean, latency: number): void {
    let metrics = this.metrics.byEndpoint.get(endpoint);
    if (!metrics) {
      metrics = {
        count: 0,
        success: 0,
        failures: 0,
        averageLatency: 0,
        errors: new Map(),
      };
      this.metrics.byEndpoint.set(endpoint, metrics);
    }

    metrics.count++;
    if (success) {
      metrics.success++;
    } else {
      metrics.failures++;
    }

    metrics.averageLatency =
      (metrics.averageLatency * (metrics.count - 1) + latency) / metrics.count;
    this.metrics.averageLatency =
      (this.metrics.averageLatency * (this.metrics.totalRequests - 1) + latency) /
      this.metrics.totalRequests;
  }

  private logRequest(log: RequestLog): void {
    this.logs.push(log);
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES);
    }
  }

  private logSuccess(requestId: string, duration: number, status: number): void {
    const log = this.logs.find((l) => l.id === requestId);
    if (log) {
      log.duration = duration;
      log.status = status;
    }
  }

  private logError(error: unknown, requestId?: string, duration?: number): void {
    if (requestId) {
      const log = this.logs.find((l) => l.id === requestId);
      if (log) {
        log.duration = duration;
        log.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  private generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async get<T>(url: string, config?: RequestConfig): Promise<T> {
    const validatedUrl = validateUrl(url);
    if (!validatedUrl) {
      throw new APIError('Invalid URL', 'validation');
    }
    return this.request<T>({ ...config, method: 'GET', url: validatedUrl } as RequestConfig);
  }

  async post<T>(url: string, data?: unknown, config?: RequestConfig): Promise<T> {
    const validatedUrl = validateUrl(url);
    if (!validatedUrl) {
      throw new APIError('Invalid URL', 'validation');
    }
    return this.request<T>({
      ...config,
      method: 'POST',
      url: validatedUrl,
      data,
    } as RequestConfig);
  }

  async put<T>(url: string, data?: unknown, config?: RequestConfig): Promise<T> {
    const validatedUrl = validateUrl(url);
    if (!validatedUrl) {
      throw new APIError('Invalid URL', 'validation');
    }
    return this.request<T>({
      ...config,
      method: 'PUT',
      url: validatedUrl,
      data,
    } as RequestConfig);
  }

  async patch<T>(url: string, data?: unknown, config?: RequestConfig): Promise<T> {
    const validatedUrl = validateUrl(url);
    if (!validatedUrl) {
      throw new APIError('Invalid URL', 'validation');
    }
    return this.request<T>({
      ...config,
      method: 'PATCH',
      url: validatedUrl,
      data,
    } as RequestConfig);
  }

  async delete<T>(url: string, config?: RequestConfig): Promise<T> {
    const validatedUrl = validateUrl(url);
    if (!validatedUrl) {
      throw new APIError('Invalid URL', 'validation');
    }
    return this.request<T>({
      ...config,
      method: 'DELETE',
      url: validatedUrl,
    } as RequestConfig);
  }

  addMiddleware(middleware: Middleware): void {
    this.middleware.push(middleware);
  }

  removeMiddleware(name: string): void {
    this.middleware = this.middleware.filter((mw) => mw.name !== name);
  }

  getMetrics(): Readonly<RequestMetrics> {
    return { ...this.metrics };
  }

  getLogs(limit?: number): readonly RequestLog[] {
    if (limit && typeof limit === 'number' && limit > 0) {
      return this.logs.slice(-limit);
    }
    return [...this.logs];
  }

  clearCache(pattern?: string): void {
    if (pattern && typeof pattern === 'string') {
      try {
        const regex = new RegExp(pattern);
        for (const key of this.cache.keys()) {
          if (regex.test(key)) {
            this.cache.delete(key);
          }
        }
      } catch {
      }
    } else {
      this.cache.clear();
    }
  }

  setRateLimit(limit: number, window: number): void {
    if (typeof limit === 'number' && limit > 0 && typeof window === 'number' && window > 0) {
      this.rateLimiter.limit = Math.floor(limit);
      this.rateLimiter.window = Math.floor(window);
    }
  }
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
  },
}) as SupabaseClient;

const getApiBaseUrl = (): string => {
  const envUrl = (import.meta.env as { readonly VITE_API_BASE_URL?: string }).VITE_API_BASE_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim().length > 0) {
    return envUrl.trim();
  }
  if (import.meta.env.MODE === 'development') {
    return '/functions/v1';
  }
  return 'https://mzfugvrgehzgupuowgme.supabase.co/functions/v1';
};

export const api = new EnhancedAPIClient(getApiBaseUrl(), supabase, {
  enableDeduplication: true,
  enableCaching: true,
  enableRetry: true,
  enableCompression: false,
  enableLogging: true,
  enableMetrics: true,
  enableBatching: true,
  enableRateLimiting: true,
  enableOffline: true,
  defaultTimeout: DEFAULT_TIMEOUT,
  defaultRetry: {
    enabled: true,
    maxAttempts: DEFAULT_MAX_RETRY_ATTEMPTS,
    initialDelay: DEFAULT_INITIAL_RETRY_DELAY,
    maxDelay: DEFAULT_MAX_RETRY_DELAY,
    backoffMultiplier: DEFAULT_BACKOFF_MULTIPLIER,
  },
});

export interface Store {
  readonly id: string;
  readonly shop_domain: string;
  readonly plan_id: string;
  readonly brand_dna: Readonly<Record<string, unknown>>;
  readonly tone_matrix: Readonly<Record<string, unknown>>;
  readonly frequency_settings?: {
    readonly interval?: string;
    readonly count?: number;
    readonly preferredDays?: readonly number[];
    readonly preferredTimes?: readonly string[];
  } | null;
  readonly is_active: boolean;
  readonly is_paused: boolean;
  readonly require_approval?: boolean;
  readonly review_window_hours?: number;
  readonly brand_safety_enabled?: boolean;
  readonly integrations?: Readonly<Record<string, unknown>>;
  readonly content_preferences?: {
    readonly topic_preferences?: readonly string[];
    readonly keyword_focus?: readonly string[];
    readonly content_angles?: readonly string[];
    readonly internal_linking_preferences?: Readonly<Record<string, unknown>>;
  };
}

export interface BlogPost {
  readonly id: string;
  readonly store_id: string;
  readonly title: string;
  readonly content: string;
  readonly status: 'draft' | 'queued' | 'scheduled' | 'published' | 'archived';
  readonly published_at: string | null;
  readonly scheduled_publish_at: string | null;
  readonly seo_health_score: number;
  readonly created_at: string;
  readonly review_status?: 'pending' | 'approved' | 'rejected' | 'auto_approved';
  readonly reviewed_at?: string | null;
  readonly auto_publish_at?: string | null;
  readonly review_feedback?: Readonly<Record<string, unknown>>;
  readonly ai_metadata?: {
    readonly topic_reason?: string;
    readonly seo_goals?: string;
    readonly keyword_opportunity?: string;
    readonly generation_strategy?: string;
  };
}

export interface QuotaStatus {
  readonly plan_name: string;
  readonly price_monthly: number;
  readonly is_trial: boolean;
  readonly trial_ends_at: string | null;
  readonly articles_used: number;
  readonly articles_allowed: number;
  readonly articles_allowed_display?: number;
  readonly articles_remaining: number;
  readonly usage_percentage: number;
}

export const storeApi = {
  getStore: async (shopDomain: string): Promise<Store> => {
    const validated = validateShopDomain(shopDomain);
    if (!validated) {
      throw new APIError('Invalid shop domain', 'validation');
    }
    try {
      const result = await api.get<Store>(`/api-router/store/${validated}`, {
        cache: { enabled: false },
      });
      return result;
    } catch (error) {
      throw error;
    }
  },

  getQuotaStatus: async (storeId: string): Promise<QuotaStatus> => {
    const validated = validateStoreId(storeId);
    if (!validated) {
      throw new APIError('Invalid store ID', 'validation');
    }
    return api.post<QuotaStatus>(
      `/api-router/quota`,
      { storeId: validated },
      {
        cache: { enabled: true, ttl: DEFAULT_CACHE_TTL },
      },
    );
  },

  updateStore: async (
    storeId: string,
    settings: Partial<SettingsData>,
  ): Promise<Store> => {
    const validated = validateStoreId(storeId);
    if (!validated) {
      throw new APIError('Invalid store ID', 'validation');
    }

    const updates: Record<string, unknown> = {};

    if (settings.brand_safety_enabled !== undefined) {
      updates.brand_safety_enabled = settings.brand_safety_enabled;
    }

    if (isFrequencySettings(settings)) {
      updates.frequency_settings = {
        interval: settings.generation_frequency || 'weekly',
        count: settings.articles_per_period || 2,
      };
    }

    try {
      const { data, error } = await supabase
        .from('stores')
        .update(updates)
        .eq('id', validated)
        .select()
        .single();

      if (error) {
        throw new APIError(`Failed to update store: ${error.message}`, 'server', undefined, error);
      }

      if (!data) {
        throw new APIError('No data returned from update', 'server');
      }

      return data as Store;
    } catch (error) {
      if (error instanceof APIError) {
        throw error;
      }
      throw new APIError(
        error instanceof Error ? error.message : 'Failed to update store',
        'server',
      );
    }
  },
};

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

export interface DashboardBatchData {
  readonly quota: QuotaStatus;
  readonly posts: readonly BlogPost[];
  readonly scheduledPosts: readonly BlogPost[];
  readonly draftPosts: readonly BlogPost[];
  readonly analytics: {
    readonly totalEvents: number;
    readonly pageviews: number;
    readonly clicks: number;
    readonly conversions: number;
  };
}

export const dashboardApi = {
  getBatch: async (storeId: string, shopDomain?: string): Promise<DashboardBatchData> => {
    const validatedStoreId = validateStoreId(storeId);
    if (!validatedStoreId && !shopDomain) {
      throw new APIError('Store ID or shop domain required', 'validation');
    }
    const validatedShopDomain = shopDomain ? validateShopDomain(shopDomain) : null;
    return api.get<DashboardBatchData>(`/api-router/dashboard/batch`, {
      params: {
        storeId: validatedStoreId || '',
        shopDomain: validatedShopDomain || '',
      },
      cache: { enabled: true, ttl: DEFAULT_CACHE_TTL },
    } as RequestConfig);
  },
};

export const queueApi = {
  getQueue: async (storeId: string): Promise<readonly QueuedArticle[]> => {
    const validated = validateStoreId(storeId);
    if (!validated) {
      throw new APIError('Invalid store ID', 'validation');
    }
    return api.get<readonly QueuedArticle[]>(`/api-router/queue`, {
      params: { storeId: validated },
      cache: { enabled: true, ttl: 30000 },
    } as RequestConfig);
  },

  getMetrics: async (storeId: string): Promise<QueueMetrics> => {
    const validated = validateStoreId(storeId);
    if (!validated) {
      throw new APIError('Invalid store ID', 'validation');
    }
    return api.get<QueueMetrics>(`/api-router/queue/metrics`, {
      params: { storeId: validated },
      cache: { enabled: true, ttl: 30000 },
    } as RequestConfig);
  },

  reorder: async (
    storeId: string,
    articleIds: readonly string[],
  ): Promise<{ readonly success: boolean }> => {
    const validated = validateStoreId(storeId);
    if (!validated) {
      throw new APIError('Invalid store ID', 'validation');
    }
    if (!Array.isArray(articleIds) || articleIds.length === 0) {
      throw new APIError('Invalid article IDs', 'validation');
    }
    return api.post<{ readonly success: boolean }>(`/api-router/queue/reorder`, {
      storeId: validated,
      articleIds: [...articleIds],
    }, {
      cache: { enabled: false },
    });
  },

  regenerateTitle: async (
    storeId: string,
    articleId: string,
  ): Promise<{ readonly title: string }> => {
    const validatedStoreId = validateStoreId(storeId);
    const validatedArticleId = validatePostId(articleId);
    if (!validatedStoreId) {
      throw new APIError('Invalid store ID', 'validation');
    }
    if (!validatedArticleId) {
      throw new APIError('Invalid article ID', 'validation');
    }
    return api.post<{ readonly title: string }>(`/api-router/queue/regenerate-title`, {
      storeId: validatedStoreId,
      articleId: validatedArticleId,
    }, {
      cache: { enabled: false },
    });
  },

  refill: async (storeId: string): Promise<{ readonly created: number }> => {
    const validated = validateStoreId(storeId);
    if (!validated) {
      throw new APIError('Invalid store ID', 'validation');
    }
    return api.post<{ readonly created: number }>(`/api-router/queue/refill`, {
      storeId: validated,
    }, {
      cache: { enabled: false },
    });
  },
};

export const postsApi = {
  list: async (
    storeId: string,
    filters?: { readonly status?: string },
  ): Promise<readonly BlogPost[]> => {
    const validated = validateStoreId(storeId);
    if (!validated) {
      throw new APIError('Invalid store ID', 'validation');
    }
    return api.get<readonly BlogPost[]>(`/api-router/posts`, {
      params: { storeId: validated, ...filters },
      cache: { enabled: true, ttl: 30000 },
    } as RequestConfig);
  },

  get: async (postId: string): Promise<BlogPost> => {
    const validated = validatePostId(postId);
    if (!validated) {
      throw new APIError('Invalid post ID', 'validation');
    }
    return api.get<BlogPost>(`/posts/${validated}`, {
      cache: { enabled: true, ttl: 30000 },
    });
  },

  update: async (postId: string, updates: Partial<BlogPost>): Promise<BlogPost> => {
    const validated = validatePostId(postId);
    if (!validated) {
      throw new APIError('Invalid post ID', 'validation');
    }
    return api.patch<BlogPost>(`/api-router/posts-api/${validated}`, updates, {
      priority: 'high',
      cache: { enabled: false },
    });
  },

  delete: async (postId: string): Promise<void> => {
    const validated = validatePostId(postId);
    if (!validated) {
      throw new APIError('Invalid post ID', 'validation');
    }
    await api.delete(`/api-router/posts-api/${validated}`, {
      priority: 'high',
      cache: { enabled: false },
    });
  },

  bulkDelete: async (postIds: readonly string[]): Promise<void> => {
    if (!Array.isArray(postIds) || postIds.length === 0) {
      return;
    }
    const validatedIds = postIds.map((id) => validatePostId(id)).filter((id): id is string => id !== null);
    if (validatedIds.length === 0) {
      throw new APIError('No valid post IDs provided', 'validation');
    }
    await Promise.all(
      validatedIds.map((id) =>
        api.delete(`/api-router/posts-api/${id}`, {
          priority: 'high',
          cache: { enabled: false },
        }),
      ),
    );
  },

  bulkUpdate: async (
    postIds: readonly string[],
    updates: Partial<BlogPost>,
  ): Promise<readonly BlogPost[]> => {
    if (!Array.isArray(postIds) || postIds.length === 0) {
      return [];
    }
    const validatedIds = postIds.map((id) => validatePostId(id)).filter((id): id is string => id !== null);
    if (validatedIds.length === 0) {
      throw new APIError('No valid post IDs provided', 'validation');
    }
    return Promise.all(
      validatedIds.map((id) =>
        api.patch<BlogPost>(`/api-router/posts-api/${id}`, updates, {
          priority: 'high',
          cache: { enabled: false },
        }),
      ),
    );
  },

  schedule: async (postId: string, scheduledAt: string): Promise<BlogPost> => {
    const validated = validatePostId(postId);
    if (!validated) {
      throw new APIError('Invalid post ID', 'validation');
    }
    if (!scheduledAt || typeof scheduledAt !== 'string' || scheduledAt.trim().length === 0) {
      throw new APIError('Invalid scheduled time', 'validation');
    }
    return api.post<BlogPost>(`/api-router/posts-api/${validated}/schedule`, {
      scheduled_at: scheduledAt.trim(),
    }, {
      priority: 'high',
      cache: { enabled: false },
    });
  },

  checkScheduleConflicts: async (
    storeId: string,
    postId: string,
    scheduledAt: string,
  ): Promise<{
    readonly conflicts: ReadonlyArray<{
      readonly conflictType: string;
      readonly severity: string;
      readonly scheduledAt: string;
      readonly suggestedAlternative?: string;
    }>;
  }> => {
    const validatedStoreId = validateStoreId(storeId);
    const validatedPostId = validatePostId(postId);
    if (!validatedStoreId) {
      throw new APIError('Invalid store ID', 'validation');
    }
    if (!validatedPostId) {
      throw new APIError('Invalid post ID', 'validation');
    }
    if (!scheduledAt || typeof scheduledAt !== 'string' || scheduledAt.trim().length === 0) {
      throw new APIError('Invalid scheduled time', 'validation');
    }
    return api.post<{
      readonly conflicts: ReadonlyArray<{
        readonly conflictType: string;
        readonly severity: string;
        readonly scheduledAt: string;
        readonly suggestedAlternative?: string;
      }>;
    }>(
      `/api-router/schedule/check-conflicts`,
      {
        storeId: validatedStoreId,
        postId: validatedPostId,
        scheduledAt: scheduledAt.trim(),
      },
      { cache: { enabled: false } },
    );
  },

  approve: async (
    postId: string,
    feedback?: Readonly<Record<string, unknown>>,
  ): Promise<BlogPost> => {
    const validated = validatePostId(postId);
    if (!validated) {
      throw new APIError('Invalid post ID', 'validation');
    }
    return api.patch<BlogPost>(
      `/api-router/posts-api/${validated}`,
      {
        review_status: 'approved',
        reviewed_at: new Date().toISOString(),
        review_feedback: feedback || {},
      },
      {
        priority: 'high',
        cache: { enabled: false },
      },
    );
  },

  reject: async (
    postId: string,
    feedback: Readonly<Record<string, unknown>>,
  ): Promise<BlogPost> => {
    const validated = validatePostId(postId);
    if (!validated) {
      throw new APIError('Invalid post ID', 'validation');
    }
    return api.patch<BlogPost>(
      `/api-router/posts-api/${validated}`,
      {
        review_status: 'rejected',
        reviewed_at: new Date().toISOString(),
        review_feedback: feedback,
      },
      {
        priority: 'high',
        cache: { enabled: false },
      },
    );
  },

  regenerate: async (
    postId: string,
    feedback: Readonly<Record<string, unknown>>,
    storeId: string,
  ): Promise<BlogPost> => {
    const validatedPostId = validatePostId(postId);
    const validatedStoreId = validateStoreId(storeId);
    if (!validatedPostId) {
      throw new APIError('Invalid post ID', 'validation');
    }
    if (!validatedStoreId) {
      throw new APIError('Invalid store ID', 'validation');
    }
    return api.post<BlogPost>(`/api-router/create-post`, {
      storeId: validatedStoreId,
      regenerateFrom: validatedPostId,
      feedback: feedback || {},
    }, {
      priority: 'high',
      cache: { enabled: false },
    });
  },

  checkRegenerationLimits: async (
    storeId: string,
    postId: string,
  ): Promise<{
    readonly allowed: boolean;
    readonly reason?: string;
    readonly limit_type?: string;
    readonly per_article_remaining?: number;
    readonly monthly_remaining?: number;
    readonly per_article_count?: number;
    readonly monthly_count?: number;
  }> => {
    const validatedStoreId = validateStoreId(storeId);
    const validatedPostId = validatePostId(postId);
    if (!validatedStoreId) {
      throw new APIError('Invalid store ID', 'validation');
    }
    if (!validatedPostId) {
      throw new APIError('Invalid post ID', 'validation');
    }
    return api.post<{
      readonly allowed: boolean;
      readonly reason?: string;
      readonly limit_type?: string;
      readonly per_article_remaining?: number;
      readonly monthly_remaining?: number;
      readonly per_article_count?: number;
      readonly monthly_count?: number;
    }>(
      `/api-router/regeneration/check-limits`,
      {
        storeId: validatedStoreId,
        postId: validatedPostId,
      },
      {
        cache: { enabled: false },
      },
    );
  },
};

export const googleOAuthApi = {
  getAuthUrl: async (
    storeId: string,
    integrationType: 'google_analytics_4' | 'google_search_console',
    propertyId?: string,
    siteUrl?: string,
  ): Promise<{ readonly authUrl: string }> => {
    const validatedStoreId = validateStoreId(storeId);
    if (!validatedStoreId) {
      throw new APIError('Invalid store ID', 'validation');
    }
    const params = new URLSearchParams({
      storeId: validatedStoreId,
      integrationType,
    });
    if (propertyId && typeof propertyId === 'string' && propertyId.trim().length > 0) {
      params.set('propertyId', propertyId.trim());
    }
    if (siteUrl && typeof siteUrl === 'string' && siteUrl.trim().length > 0) {
      params.set('siteUrl', siteUrl.trim());
    }
    return api.get<{ readonly authUrl: string }>(`/oauth/google/authorize?${params.toString()}`, {
      cache: { enabled: false },
    });
  },

  refreshToken: async (
    storeId: string,
    integrationType: 'google_analytics_4' | 'google_search_console',
  ): Promise<{ readonly success: boolean }> => {
    const validatedStoreId = validateStoreId(storeId);
    if (!validatedStoreId) {
      throw new APIError('Invalid store ID', 'validation');
    }
    const params = new URLSearchParams({
      storeId: validatedStoreId,
      integrationType,
    });
    return api.post<{ readonly success: boolean }>(`/oauth/google/refresh?${params.toString()}`, {}, {
      cache: { enabled: false },
    });
  },
};

export const analyticsApi = {
  getMetrics: async (
    storeId: string,
    dateRange?: { readonly start: string; readonly end: string },
  ): Promise<unknown> => {
    const validated = validateStoreId(storeId);
    if (!validated) {
      throw new APIError('Invalid store ID', 'validation');
    }
    return api.get(`/api-router/analytics`, {
      params: { storeId: validated, ...dateRange },
      cache: { enabled: true, ttl: 300000 },
    } as RequestConfig);
  },

  getPostMetrics: async (postId: string): Promise<unknown> => {
    const validated = validatePostId(postId);
    if (!validated) {
      throw new APIError('Invalid post ID', 'validation');
    }
    return api.get(`/analytics/posts/${validated}`, {
      cache: { enabled: true, ttl: 300000 },
    });
  },
};

export { EnhancedAPIClient };
