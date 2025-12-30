import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { createClient } from '@supabase/supabase-js';

type RequestPriority = 'low' | 'medium' | 'high' | 'critical';

type ErrorCategory = 'network' | 'timeout' | 'auth' | 'validation' | 'server' | 'client' | 'unknown';

interface RequestConfig extends Omit<AxiosRequestConfig, 'cancelToken'> {
  priority?: RequestPriority;
  timeout?: number;
  retry?: RetryConfig;
  cache?: CacheConfig;
  deduplicate?: boolean;
  cancelToken?: AbortController;
  transform?: boolean;
  validate?: boolean;
  compress?: boolean;
  batch?: boolean;
  batchId?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface RetryConfig {
  enabled?: boolean;
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  retryableErrors?: string[];
}

export interface CacheConfig {
  enabled?: boolean;
  ttl?: number;
  key?: string;
  invalidateOn?: string[];
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
  name: string;
  beforeRequest?: (config: RequestConfig) => RequestConfig | null | Promise<RequestConfig | null>;
  afterResponse?: (response: AxiosResponse) => AxiosResponse | Promise<AxiosResponse>;
  onError?: (error: AxiosError) => AxiosError | Promise<AxiosError>;
}

interface BatchRequest {
  readonly id: string;
  readonly requests: ReadonlyArray<{ readonly method: string; readonly url: string; readonly data?: unknown; readonly config?: RequestConfig }>;
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

// ============================================================================
// Enhanced API Client Class
// ============================================================================

class EnhancedAPIClient {
  private instance: AxiosInstance;
  private readonly pendingRequests: Map<string, Promise<unknown>> = new Map();
  private readonly requestQueue: Array<{ readonly id: string; readonly config: RequestConfig; readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }> = [];
  private readonly cache: Map<string, { readonly data: unknown; readonly expiresAt: number }> = new Map();
  private metrics: RequestMetrics;
  private readonly logs: RequestLog[] = [];
  private middleware: Middleware[] = [];
  private readonly batchQueue: BatchRequest[] = [];
  private readonly rateLimiter: { count: number; resetAt: number; limit: number; window: number } = {
    count: 0,
    resetAt: Date.now(),
    limit: 100,
    window: 60000,
  };
  private offlineQueue: Array<{ readonly id: string; readonly config: RequestConfig; readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }> = [];
  private isOnline: boolean = navigator.onLine;

  private config: {
    enableDeduplication?: boolean;
    enableCaching?: boolean;
    enableRetry?: boolean;
    enableCompression?: boolean;
    enableLogging?: boolean;
    enableMetrics?: boolean;
    enableBatching?: boolean;
    enableRateLimiting?: boolean;
    enableOffline?: boolean;
    defaultTimeout?: number;
    defaultRetry?: RetryConfig;
    apiVersion?: string;
  };

  constructor(
    baseURL: string,
    private supabaseClient: ReturnType<typeof createClient>,
    config: {
      enableDeduplication?: boolean;
      enableCaching?: boolean;
      enableRetry?: boolean;
      enableCompression?: boolean;
      enableLogging?: boolean;
      enableMetrics?: boolean;
      enableBatching?: boolean;
      enableRateLimiting?: boolean;
      enableOffline?: boolean;
      defaultTimeout?: number;
      defaultRetry?: RetryConfig;
      apiVersion?: string;
    } = {},
  ) {
    this.config = config;
    this.instance = axios.create({
      baseURL,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: this.config.defaultTimeout || 30000,
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

  private setupInterceptors(): void {
    // Request interceptor
    this.instance.interceptors.request.use(
      async (config: InternalAxiosRequestConfig) => {
        const requestConfig = config as unknown as RequestConfig;

        // Apply middleware
        for (const mw of this.middleware) {
          if (mw.beforeRequest) {
            const result = await mw.beforeRequest(requestConfig);
            if (result === null) {
              throw new APIError('Request cancelled by middleware', 'unknown');
            }
            Object.assign(config, result);
          }
        }

        // Add authentication - use Supabase anon key for Shopify app context
        // In Shopify apps, we don't use Supabase auth sessions, so we use the anon key
        if (!config.headers.Authorization) {
          const anonKey = (import.meta.env as { readonly VITE_SUPABASE_ANON_KEY?: string }).VITE_SUPABASE_ANON_KEY;
          if (anonKey) {
            config.headers.Authorization = `Bearer ${anonKey}`;
          }
        }

        // Add API version
        if (this.config.apiVersion) {
          config.headers['API-Version'] = this.config.apiVersion;
        }

        // Add request ID
        const requestId = this.generateRequestId();
        config.headers['X-Request-Id'] = requestId;

        // Compress if enabled
        if (this.config.enableCompression && config.data) {
          config.data = await this.compress(config.data);
          config.headers['Content-Encoding'] = 'gzip';
        }

        // Log request
        if (this.config.enableLogging) {
          this.logRequest({
            id: requestId,
            method: config.method?.toUpperCase() || 'GET',
            url: config.url || '',
            timestamp: Date.now(),
            priority: requestConfig.priority,
          });
        }

        return config;
      },
      (error: unknown) => {
        return Promise.reject(error);
      },
    );

    // Response interceptor
    this.instance.interceptors.response.use(
      async (response: AxiosResponse) => {
        // Decompress if needed
        if (response.headers['content-encoding'] === 'gzip') {
          response.data = await this.decompress(response.data);
        }

        // Apply middleware
        for (const mw of this.middleware) {
          if (mw.afterResponse) {
            response = await mw.afterResponse(response);
          }
        }

        // Transform response
        if ((response.config as unknown as RequestConfig).transform !== false) {
          response.data = this.transformResponse(response.data);
        }

        return response;
      },
      async (error: AxiosError) => {
        // Apply middleware
        for (const mw of this.middleware) {
          if (mw.onError) {
            error = await mw.onError(error);
          }
        }

        // Classify error
        const apiError = this.classifyError(error);

        // Log error
        if (this.config.enableLogging) {
          this.logError(apiError);
        }

        return Promise.reject(apiError);
      },
    );
  }

  private setupNetworkMonitoring(): void {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.isOnline = true;
        this.syncOfflineQueue();
      });

      window.addEventListener('offline', () => {
        this.isOnline = false;
      });
    }
  }

  private async request<T>(config: RequestConfig): Promise<T> {
    const startTime = Date.now();
    const requestId = config.metadata?.requestId || this.generateRequestId();
    const cacheKey = this.getCacheKey(config);

    // Check cache
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

    // Check deduplication
    if (this.config.enableDeduplication && config.deduplicate !== false) {
      const dedupeKey = this.getDedupeKey(config);
      if (this.pendingRequests.has(dedupeKey)) {
        return this.pendingRequests.get(dedupeKey)! as Promise<T>;
      }
    }

    // Check rate limiting
    if (this.config.enableRateLimiting && !this.checkRateLimit()) {
      // Queue request
      return new Promise<T>((resolve, reject) => {
        this.requestQueue.push({
          id: requestId as string,
          config,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        this.processQueue();
      });
    }

    // Check offline
    if (!this.isOnline && this.config.enableOffline) {
      return new Promise<T>((resolve, reject) => {
        this.offlineQueue.push({
          id: requestId as string,
          config,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        reject(new APIError('Offline - request queued', 'network'));
      });
    }

    // Execute request
    const requestPromise = this.executeRequest<T>(config, requestId as string, startTime);

    // Store for deduplication
    if (this.config.enableDeduplication && config.deduplicate !== false) {
      const dedupeKey = this.getDedupeKey(config);
      this.pendingRequests.set(dedupeKey, requestPromise);
      requestPromise.finally(() => {
        setTimeout(() => this.pendingRequests.delete(dedupeKey), 100);
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
    const maxAttempts = retryConfig.maxAttempts || 3;

    while (attempts < maxAttempts) {
      try {
        // Check cancellation
        if (config.cancelToken?.signal.aborted) {
          this.metrics.cancellations++;
          throw new APIError('Request cancelled', 'unknown');
        }

        // Execute request
        const { cancelToken, ...axiosConfig } = config;
        const response = await this.instance.request<T>(axiosConfig as unknown as unknown as AxiosRequestConfig);

        // Cache response
        if (this.config.enableCaching && config.cache?.enabled !== false) {
          const cacheKey = this.getCacheKey(config);
          const ttl = config.cache?.ttl || 60000; // Default 1 minute
          this.cache.set(cacheKey, {
            data: response.data,
            expiresAt: Date.now() + ttl,
          });
        }

        // Update metrics
        const latency = Date.now() - startTime;
        this.metrics.successfulRequests++;
        this.metrics.totalRequests++;
        const url = (config as unknown as AxiosRequestConfig).url;
        if (this.config.enableMetrics && url) {
          this.updateMetrics(url, true, latency);
        }

        // Log success
        if (this.config.enableLogging) {
          this.logSuccess(requestId, latency, response.status);
        }

        return response.data;
      } catch (error: unknown) {
        attempts++;
        const isLastAttempt = attempts >= maxAttempts;

        const classifiedError = this.classifyError(error);

        if (!isLastAttempt && retryConfig.enabled && this.isRetryable(classifiedError, retryConfig)) {
          const delay = this.calculateRetryDelay(attempts, retryConfig);
          this.metrics.retries++;
          await this.sleep(delay);
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

      // Log error details for debugging
      if (status && status >= 500) {
        // Try to extract error message from various possible response structures
        const errorMessage = 
          (responseData as { error?: string })?.error || 
          (responseData as { message?: string })?.message ||
          message;
        const errorCode = 
          (responseData as { metadata?: { errorCode?: string } })?.metadata?.errorCode ||
          (responseData as { errorCode?: string })?.errorCode;
        const debugInfo = 
          (responseData as { metadata?: { debugInfo?: unknown } })?.metadata?.debugInfo ||
          (responseData as { debugInfo?: unknown })?.debugInfo;
        
        // Log the full response as JSON string so we can see everything
        console.error('[API Error] Full response data:', JSON.stringify(responseData, null, 2));
        console.error('[API Error] Server error summary:', {
          status,
          message: errorMessage,
          errorCode,
          url: axiosError.config?.url,
        });
        // Also log as a separate error for visibility
        console.error('[API Error] Error message:', errorMessage);
        if (errorCode) {
          console.error('[API Error] Error code:', errorCode);
        }
        if (debugInfo) {
          console.error('[API Error] Debug info:', JSON.stringify(debugInfo, null, 2));
        }
      }

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
        // Extract error message from response if available
        const errorMessage = (responseData as { error?: string })?.error || message;
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

    if (retryConfig.retryableErrors) {
      const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      return retryConfig.retryableErrors.some((pattern) =>
        errorMessage.includes(pattern.toLowerCase()),
      );
    }

    return false;
  }

  private calculateRetryDelay(attempt: number, retryConfig: RetryConfig): number {
    const initialDelay = retryConfig.initialDelay || 1000;
    const maxDelay = retryConfig.maxDelay || 30000;
    const multiplier = retryConfig.backoffMultiplier || 2;

    const delay = Math.min(initialDelay * Math.pow(multiplier, attempt - 1), maxDelay);
    return delay + Math.random() * 1000; // Add jitter
  }

  private getCacheKey(config: RequestConfig): string {
    if (config.cache?.key) {
      return config.cache.key;
    }
    const method = (config as unknown as AxiosRequestConfig).method || 'GET';
    const url = (config as unknown as AxiosRequestConfig).url || '';
    const params = (config as unknown as AxiosRequestConfig).params || {};
    const data = (config as unknown as AxiosRequestConfig).data || {};
    return `${method}:${url}:${JSON.stringify(params)}:${JSON.stringify(data)}`;
  }

  private getDedupeKey(config: RequestConfig): string {
    const method = (config as unknown as AxiosRequestConfig).method || 'GET';
    const url = (config as unknown as AxiosRequestConfig).url || '';
    const data = (config as unknown as AxiosRequestConfig).data || {};
    return `${method}:${url}:${JSON.stringify(data)}`;
  }

  private transformResponse(data: unknown): unknown {
    // If the response is an APIResponse object with a data field, extract it
    if (data && typeof data === 'object' && 'data' in data && !('error' in data)) {
      const apiResponse = data as { readonly data?: unknown; readonly correlationId?: string };
      return apiResponse.data;
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

    // Sort by priority
    this.requestQueue.sort((a, b) => {
      const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      const aPriority = priorityOrder[a.config.priority || 'medium'];
      const bPriority = priorityOrder[b.config.priority || 'medium'];
      return bPriority - aPriority;
    });

    const item = this.requestQueue.shift();
    if (item) {
      this.request(item.config)
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          setTimeout(() => this.processQueue(), 100);
        });
    }
  }

  private startBatchProcessor(): void {
    if (!this.config.enableBatching) return;

    setInterval(() => {
      if (this.batchQueue.length === 0) return;

      const batch = this.batchQueue.shift();
      if (batch) {
        this.executeBatch(batch);
      }
    }, 100); // Process batches every 100ms
  }

  private async executeBatch(batch: BatchRequest): Promise<void> {
    try {
      const promises = batch.requests.map((req) => {
        const { cancelToken, ...axiosConfig } = req.config || {};
        return this.instance.request({
          method: req.method as unknown as AxiosRequestConfig['method'],
          url: req.url,
          data: req.data,
          ...axiosConfig,
        } as unknown as AxiosRequestConfig);
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
    if (!this.config.enableOffline) return;

    setInterval(() => {
      if (this.isOnline && this.offlineQueue.length > 0) {
        this.syncOfflineQueue();
      }
    }, 5000); // Check every 5 seconds
  }

  private async syncOfflineQueue(): Promise<void> {
    const queue = [...this.offlineQueue];
    this.offlineQueue = [];

    for (const item of queue) {
      try {
        const result = await this.request(item.config);
        item.resolve(result);
      } catch (error) {
        // Re-queue if still failing
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

    metrics.averageLatency = (metrics.averageLatency * (metrics.count - 1) + latency) / metrics.count;
    this.metrics.averageLatency =
      (this.metrics.averageLatency * (this.metrics.totalRequests - 1) + latency) / this.metrics.totalRequests;
  }

  private logRequest(log: RequestLog): void {
    this.logs.push(log);
    if (this.logs.length > 1000) {
      this.logs.splice(0, this.logs.length - 1000);
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

  // Public API methods
  async get<T>(url: string, config?: RequestConfig): Promise<T> {
    return this.request<T>({ ...config, method: 'GET', url } as RequestConfig);
  }

  async post<T>(url: string, data?: unknown, config?: RequestConfig): Promise<T> {
    return this.request<T>({ ...config, method: 'POST', url, data } as RequestConfig);
  }

  async put<T>(url: string, data?: unknown, config?: RequestConfig): Promise<T> {
    return this.request<T>({ ...config, method: 'PUT', url, data } as RequestConfig);
  }

  async patch<T>(url: string, data?: unknown, config?: RequestConfig): Promise<T> {
    return this.request<T>({ ...config, method: 'PATCH', url, data } as RequestConfig);
  }

  async delete<T>(url: string, config?: RequestConfig): Promise<T> {
    return this.request<T>({ ...config, method: 'DELETE', url } as RequestConfig);
  }

  addMiddleware(middleware: Middleware): void {
    this.middleware.push(middleware);
  }

  removeMiddleware(name: string): void {
    this.middleware = this.middleware.filter((mw) => mw.name !== name);
  }

  getMetrics(): RequestMetrics {
    return { ...this.metrics };
  }

  getLogs(limit?: number): readonly RequestLog[] {
    if (limit) {
      return this.logs.slice(-limit);
    }
    return [...this.logs];
  }

  clearCache(pattern?: string): void {
    if (pattern) {
      const regex = new RegExp(pattern);
      for (const key of this.cache.keys()) {
        if (regex.test(key)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }

  setRateLimit(limit: number, window: number): void {
    this.rateLimiter.limit = limit;
    this.rateLimiter.window = window;
  }
}

// ============================================================================
// Supabase Client
// ============================================================================

const supabaseUrl = (import.meta.env as { readonly VITE_SUPABASE_URL?: string }).VITE_SUPABASE_URL || '';
const supabaseAnonKey = (import.meta.env as { readonly VITE_SUPABASE_ANON_KEY?: string }).VITE_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
  },
});

// ============================================================================
// API Client Instances
// ============================================================================

// Use relative URL so Vite proxy handles it, or absolute URL in production
const API_BASE_URL = (import.meta.env as { readonly VITE_API_BASE_URL?: string }).VITE_API_BASE_URL || '/functions/v1';

export const api = new EnhancedAPIClient(API_BASE_URL, supabase as any, {
  enableDeduplication: true,
  enableCaching: true,
  enableRetry: true,
  enableCompression: false,
  enableLogging: true,
  enableMetrics: true,
  enableBatching: true,
  enableRateLimiting: true,
  enableOffline: true,
  defaultTimeout: 30000,
  defaultRetry: {
    enabled: true,
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
  },
});


export interface Store {
  id: string;
  shop_domain: string;
  plan_id: string;
  readonly brand_dna: Readonly<Record<string, unknown>>;
  readonly tone_matrix: Readonly<Record<string, unknown>>;
  readonly frequency_settings?: {
    readonly interval?: string;
    readonly count?: number;
    readonly preferredDays?: number[];
    readonly preferredTimes?: string[];
  } | null;
  is_active: boolean;
  is_paused: boolean;
  require_approval?: boolean;
  review_window_hours?: number;
  brand_safety_enabled?: boolean;
  readonly integrations?: Readonly<Record<string, unknown>>;
  content_preferences?: {
    topic_preferences?: string[];
    keyword_focus?: string[];
    content_angles?: string[];
    internal_linking_preferences?: Record<string, unknown>;
  };
}

export interface BlogPost {
  id: string;
  store_id: string;
  title: string;
  content: string;
  status: 'draft' | 'queued' | 'scheduled' | 'published' | 'archived';
  published_at: string | null;
  scheduled_publish_at: string | null;
  seo_health_score: number;
  created_at: string;
  review_status?: 'pending' | 'approved' | 'rejected' | 'auto_approved';
  reviewed_at?: string | null;
  auto_publish_at?: string | null;
  review_feedback?: Record<string, unknown>;
  ai_metadata?: {
    topic_reason?: string;
    seo_goals?: string;
    keyword_opportunity?: string;
    generation_strategy?: string;
  };
}

export interface QuotaStatus {
  plan_name: string;
  price_monthly: number;
  is_trial: boolean;
  trial_ends_at: string | null;
  articles_used: number;
  articles_allowed: number;
  articles_allowed_display?: number; // Display limit (6 for trial, monthly for paid)
  articles_remaining: number;
  usage_percentage: number;
}



export const storeApi = {
  getStore: async (shopDomain: string): Promise<Store> => {
    // Path is relative to /functions/v1, so /store/{shopDomain} goes to api-router function
    // The api-router function will handle /store/{shopDomain} route
    try {
      // Store data is used for routing guards (e.g., setup completion),
      // so avoid long-lived client-side caching here.
      const result = await api.get<Store>(`/api-router/store/${shopDomain}`, {
        cache: { enabled: false },
      });
      return result;
    } catch (error) {
      throw error;
    }
  },

  getQuotaStatus: async (storeId: string): Promise<QuotaStatus> => {
    return api.post<QuotaStatus>(`/api-router/quota`, { storeId }, {
      cache: { enabled: true, ttl: 60000 }, // 1 minute
    });
  },

  updateStore: async (storeId: string, settings: Partial<import('../hooks/useSettingsData').SettingsData>): Promise<Store> => {
    // Update store settings directly via Supabase (respects RLS)
    const updates: Record<string, unknown> = {};

    if (settings.brand_safety_enabled !== undefined) {
      updates.brand_safety_enabled = settings.brand_safety_enabled;
    }

    // Note: Integrations are stored in the analytics_integrations table, not in stores table
    // The integration settings (enabled/disabled) are managed via the integrations table
    // Property IDs and site URLs are stored in the credentials JSONB field of analytics_integrations

    // Note: Notifications preferences are not stored in the database currently
    // They are client-side settings. If persistence is needed, add a notifications JSONB column
    // to the stores table or create a separate notifications_preferences table

    // Handle frequency settings if provided
    if ('generation_frequency' in settings || 'articles_per_period' in settings) {
      updates.frequency_settings = {
        interval: (settings as any).generation_frequency || 'weekly',
        count: (settings as any).articles_per_period || 2,
      };
    }

    const { data, error } = await supabase
      .from('stores')
      .update(updates)
      .eq('id', storeId)
      .select()
      .single();

    if (error) throw new Error(`Failed to update store: ${error.message}`);

    return data as Store;
  },
};

export interface QueuedArticle {
  id: string;
  store_id: string;
  title: string;
  status: 'queued';
  queue_position: number;
  scheduled_publish_at: string | null;
  created_at: string;
  content?: string;
}

export interface QueueMetrics {
  currentCount: number;
  targetCount: number;
  planName: string;
  needsRefill: boolean;
}

export const queueApi = {
  getQueue: async (storeId: string): Promise<QueuedArticle[]> => {
    return api.get<QueuedArticle[]>(`/api-router/queue`, {
      ...({ params: { storeId } } as RequestConfig),
      cache: { enabled: true, ttl: 30000 },
    });
  },

  getMetrics: async (storeId: string): Promise<QueueMetrics> => {
    return api.get<QueueMetrics>(`/api-router/queue/metrics`, {
      ...({ params: { storeId } } as RequestConfig),
      cache: { enabled: true, ttl: 30000 },
    });
  },

  reorder: async (storeId: string, articleIds: string[]): Promise<{ success: boolean }> => {
    return api.post<{ success: boolean }>(`/api-router/queue/reorder`, {
      storeId,
      articleIds,
    }, {
      cache: { enabled: false },
    });
  },

  regenerateTitle: async (storeId: string, articleId: string): Promise<{ title: string }> => {
    return api.post<{ title: string }>(`/api-router/queue/regenerate-title`, {
      storeId,
      articleId,
    }, {
      cache: { enabled: false },
    });
  },

  refill: async (storeId: string): Promise<{ created: number }> => {
    return api.post<{ created: number }>(`/api-router/queue/refill`, {
      storeId,
    }, {
      cache: { enabled: false },
    });
  },
};

export const postsApi = {
  list: async (storeId: string, filters?: { status?: string }): Promise<BlogPost[]> => {
    return api.get<BlogPost[]>(`/api-router/posts`, {
      ...({ params: { storeId, ...filters } } as RequestConfig),
      cache: { enabled: true, ttl: 30000 },
    });
  },

  get: async (postId: string): Promise<BlogPost> => {
    return api.get<BlogPost>(`/posts/${postId}`, {
      cache: { enabled: true, ttl: 30000 },
    });
  },

  update: async (postId: string, updates: Partial<BlogPost>): Promise<BlogPost> => {
    return api.patch<BlogPost>(`/posts-api/${postId}`, updates, {
      priority: 'high',
      cache: { enabled: false },
    });
  },

  delete: async (postId: string): Promise<void> => {
    await api.delete(`/posts-api/${postId}`, {
      priority: 'high',
      cache: { enabled: false },
    });
  },

  bulkDelete: async (postIds: string[]): Promise<void> => {
    await Promise.all(postIds.map((id) => api.delete(`/posts-api/${id}`, {
      priority: 'high',
      cache: { enabled: false },
    })));
  },

  bulkUpdate: async (postIds: string[], updates: Partial<BlogPost>): Promise<BlogPost[]> => {
    return Promise.all(postIds.map((id) => api.patch<BlogPost>(`/posts-api/${id}`, updates, {
      priority: 'high',
      cache: { enabled: false },
    })));
  },

  schedule: async (postId: string, scheduledAt: string): Promise<BlogPost> => {
    return api.post<BlogPost>(`/posts-api/${postId}/schedule`, { scheduled_at: scheduledAt }, {
      priority: 'high',
      cache: { enabled: false },
    });
  },

  checkScheduleConflicts: async (storeId: string, postId: string, scheduledAt: string) => {
    return api.post<{ conflicts: Array<{ conflictType: string; severity: string; scheduledAt: string; suggestedAlternative?: string }> }>(
      `/api-router/schedule/check-conflicts`,
      { storeId, postId, scheduledAt },
      { cache: { enabled: false } }
    );
  },

  approve: async (postId: string, feedback?: Record<string, unknown>): Promise<BlogPost> => {
    return api.patch<BlogPost>(`/posts-api/${postId}`, {
      review_status: 'approved',
      reviewed_at: new Date().toISOString(),
      review_feedback: feedback || {},
    }, {
      priority: 'high',
      cache: { enabled: false },
    });
  },

  reject: async (postId: string, feedback: Record<string, unknown>): Promise<BlogPost> => {
    return api.patch<BlogPost>(`/posts-api/${postId}`, {
      review_status: 'rejected',
      reviewed_at: new Date().toISOString(),
      review_feedback: feedback,
    }, {
      priority: 'high',
      cache: { enabled: false },
    });
  },

  regenerate: async (postId: string, feedback: Record<string, unknown>, storeId: string): Promise<BlogPost> => {
    // Regenerate creates a new article with feedback applied
    return api.post<BlogPost>(`/create-post`, {
      storeId,
      regenerateFrom: postId,
      feedback,
    }, {
      priority: 'high',
      cache: { enabled: false },
    });
  },

  checkRegenerationLimits: async (storeId: string, postId: string): Promise<{
    allowed: boolean;
    reason?: string;
    limit_type?: string;
    per_article_remaining?: number;
    monthly_remaining?: number;
    per_article_count?: number;
    monthly_count?: number;
  }> => {
    return api.post(`/api-router/regeneration/check-limits`, {
      storeId,
      postId,
    }, {
      cache: { enabled: false },
    });
  },
};

export const googleOAuthApi = {
  getAuthUrl: async (storeId: string, integrationType: 'google_analytics_4' | 'google_search_console', propertyId?: string, siteUrl?: string): Promise<{ authUrl: string }> => {
    const params = new URLSearchParams({
      storeId,
      integrationType,
    });
    if (propertyId) params.set('propertyId', propertyId);
    if (siteUrl) params.set('siteUrl', siteUrl);
    
    return api.get(`/google-oauth/authorize?${params.toString()}`, {
      cache: { enabled: false },
    });
  },

  refreshToken: async (storeId: string, integrationType: 'google_analytics_4' | 'google_search_console'): Promise<{ success: boolean }> => {
    const params = new URLSearchParams({
      storeId,
      integrationType,
    });
    
    return api.post(`/google-oauth/refresh?${params.toString()}`, {}, {
      cache: { enabled: false },
    });
  },
};

export const analyticsApi = {
  getMetrics: async (storeId: string, dateRange?: { start: string; end: string }) => {
    return api.get(`/api-router/analytics`, {
      ...({ params: { storeId, ...dateRange } } as RequestConfig),
      cache: { enabled: true, ttl: 300000 },
    });
  },

  getPostMetrics: async (postId: string) => {
    return api.get(`/analytics/posts/${postId}`, {
      cache: { enabled: true, ttl: 300000 },
    });
  },

};




export { EnhancedAPIClient };
