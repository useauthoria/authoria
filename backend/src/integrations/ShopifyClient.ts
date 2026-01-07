import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { retry, RetryOptions } from '../utils/error-handling.ts';
import { withDeduplication } from '../utils/error-handling.ts';
import { getShopifyRateLimiter } from '../utils/rate-limiter.ts';

const API_VERSION = '2025-10';

export enum ShopifyErrorType {
  RATE_LIMIT = 'RATE_LIMIT',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  SERVER_ERROR = 'SERVER_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  GRAPHQL_ERROR = 'GRAPHQL_ERROR',
  USER_ERROR = 'USER_ERROR',
  UNKNOWN = 'UNKNOWN',
}

export class ShopifyError extends Error {
  constructor(
    public readonly type: ShopifyErrorType,
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfter?: number,
    public readonly userErrors?: ReadonlyArray<{ readonly field: readonly string[]; readonly message: string }>,
    public readonly extensions?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ShopifyError';
  }

  isRetryable(): boolean {
    return [
      ShopifyErrorType.RATE_LIMIT,
      ShopifyErrorType.SERVER_ERROR,
      ShopifyErrorType.NETWORK_ERROR,
      ShopifyErrorType.TIMEOUT,
    ].includes(this.type);
  }
}

export interface CacheEntry<T> {
  readonly data: T;
  readonly expiresAt: number;
  readonly staleAt: number;
  readonly key: string;
  lastAccessed: number;
  accessCount: number;
}

export interface CacheEvent {
  readonly type: 'set' | 'get' | 'invalidate' | 'expire' | 'warm';
  readonly key: string;
  readonly timestamp: number;
}

interface MutableCacheEntry<T> {
  data: T;
  expiresAt: number;
  staleAt: number;
  key: string;
  lastAccessed: number;
  accessCount: number;
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

const validateShopDomain = (shopDomain: string): void => {
  if (!shopDomain || typeof shopDomain !== 'string' || shopDomain.trim().length === 0) {
    throw new Error('Invalid shop domain: must be a non-empty string');
  }
  if (!shopDomain.includes('.') || shopDomain.length > 255) {
    throw new Error('Invalid shop domain format');
  }
};

const validateAccessToken = (accessToken: string): void => {
  if (!accessToken || typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    throw new Error('Invalid access token: must be a non-empty string');
  }
  if (accessToken.length > 10000) {
    throw new Error('Invalid access token: exceeds maximum length');
  }
};

const validateQuery = (query: string): void => {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('Invalid query: must be a non-empty string');
  }
  if (query.length > 100000) {
    throw new Error('Invalid query: exceeds maximum length');
  }
};

const validateImageUrl = (imageUrl: string): void => {
  if (!imageUrl || typeof imageUrl !== 'string' || imageUrl.trim().length === 0) {
    throw new Error('Invalid image URL: must be a non-empty string');
  }
  try {
    new URL(imageUrl);
  } catch {
    throw new Error(`Invalid image URL format: ${imageUrl}`);
  }
  if (imageUrl.length > 2000) {
    throw new Error('Invalid image URL: exceeds maximum length');
  }
};

const validateBlogId = (blogId: number): void => {
  if (!Number.isInteger(blogId) || blogId <= 0) {
    throw new Error('Invalid blog ID: must be a positive integer');
  }
};

const validateArticleId = (articleId: number): void => {
  if (!Number.isInteger(articleId) || articleId <= 0) {
    throw new Error('Invalid article ID: must be a positive integer');
  }
};

const validateLimit = (limit: number): void => {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 250) {
    throw new Error('Invalid limit: must be an integer between 1 and 250');
  }
};

const validateSubscriptionId = (subscriptionId: string): void => {
  if (!subscriptionId || typeof subscriptionId !== 'string' || subscriptionId.trim().length === 0) {
    throw new Error('Invalid subscription ID: must be a non-empty string');
  }
  if (subscriptionId.length > 100) {
    throw new Error('Invalid subscription ID: exceeds maximum length');
  }
};

const validateArticleInput = (article: BlogArticleInput): void => {
  if (!article || typeof article !== 'object') {
    throw new Error('Invalid article: must be an object');
  }
  if (!article.title || typeof article.title !== 'string' || article.title.trim().length === 0) {
    throw new Error('Invalid article title: must be a non-empty string');
  }
  if (article.title.length > 500) {
    throw new Error('Invalid article title: exceeds maximum length');
  }
  if (!article.body_html || typeof article.body_html !== 'string') {
    throw new Error('Invalid article body: must be a string');
  }
  if (article.body_html.length > 10000000) {
    throw new Error('Invalid article body: exceeds maximum length of 10MB');
  }
  if (!article.author || typeof article.author !== 'string' || article.author.trim().length === 0) {
    throw new Error('Invalid article author: must be a non-empty string');
  }
  if (article.author.length > 200) {
    throw new Error('Invalid article author: exceeds maximum length');
  }
  if (article.tags && (typeof article.tags !== 'string' || article.tags.length > 1000)) {
    throw new Error('Invalid article tags: must be a string with max length 1000');
  }
  if (article.summary && (typeof article.summary !== 'string' || article.summary.length > 1000)) {
    throw new Error('Invalid article summary: must be a string with max length 1000');
  }
};

export class ShopifyCache {
  private static readonly DEFAULT_TTL_SHOP = 3600000;
  private static readonly DEFAULT_TTL_PRODUCTS = 1800000;
  private static readonly DEFAULT_TTL_BLOGS = 3600000;
  private static readonly DEFAULT_TTL_COLLECTIONS = 3600000;
  private static readonly DEFAULT_TTL_PAGES = 3600000;
  private static readonly DEFAULT_TTL_ARTICLES = 1800000;
  private static readonly DEFAULT_TTL_GRAPHQL = 300000;
  private static readonly DEFAULT_TTL_DEFAULT = 1800000;
  private static readonly STALE_WHILE_REVALIDATE_MULTIPLIER = 1.5;
  private static readonly MAX_EVENTS = 1000;
  private static readonly CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  static readonly CACHE_KEY_SEPARATOR = ':';
  private static readonly DEFAULT_CACHE_TYPE = 'default';

  private readonly cache: Map<string, MutableCacheEntry<unknown>>;
  private readonly events: CacheEvent[];
  private readonly listeners: Map<string, Set<(key: string) => void>>;
  private readonly defaultTTLs: Readonly<Record<string, number>>;
  private cacheCleanupInterval?: number;

  constructor() {
    this.cache = new Map();
    this.events = [];
    this.listeners = new Map();
    this.defaultTTLs = {
      shop: ShopifyCache.DEFAULT_TTL_SHOP,
      products: ShopifyCache.DEFAULT_TTL_PRODUCTS,
      blogs: ShopifyCache.DEFAULT_TTL_BLOGS,
      collections: ShopifyCache.DEFAULT_TTL_COLLECTIONS,
      pages: ShopifyCache.DEFAULT_TTL_PAGES,
      articles: ShopifyCache.DEFAULT_TTL_ARTICLES,
      graphql: ShopifyCache.DEFAULT_TTL_GRAPHQL,
    };
    this.startCacheCleanup();
  }

  destroy(): void {
    if (this.cacheCleanupInterval !== undefined) {
      clearInterval(this.cacheCleanupInterval);
      this.cacheCleanupInterval = undefined;
    }
    this.cache.clear();
    this.events.length = 0;
    this.listeners.clear();
  }

  private startCacheCleanup(): void {
    this.cacheCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.cache.entries()) {
        if (entry.expiresAt < now) {
          this.cache.delete(key);
          this.emitEvent('expire', key);
        }
      }
    }, ShopifyCache.CACHE_CLEANUP_INTERVAL_MS) as unknown as number;
  }

  get<T>(key: string, allowStale: boolean = true): { readonly data: T | null; readonly stale: boolean } {
    const entry = this.cache.get(key);
    if (!entry) {
      return { data: null, stale: false };
    }

    const now = Date.now();
    entry.lastAccessed = now;
    entry.accessCount++;

    if (now > entry.expiresAt) {
      if (allowStale && now <= entry.staleAt) {
        this.emitEvent('get', key);
        return { data: entry.data as T, stale: true };
      }
      this.cache.delete(key);
      this.emitEvent('expire', key);
      return { data: null, stale: false };
    }

    this.emitEvent('get', key);
    return { data: entry.data as T, stale: false };
  }

  set<T>(key: string, data: T, ttl?: number): void {
    const cacheType = this.getCacheType(key);
    const entryTTL = ttl || this.defaultTTLs[cacheType] || ShopifyCache.DEFAULT_TTL_DEFAULT;
    const staleTTL = entryTTL * ShopifyCache.STALE_WHILE_REVALIDATE_MULTIPLIER;

    this.cache.set(key, {
      data,
      expiresAt: Date.now() + entryTTL,
      staleAt: Date.now() + staleTTL,
      key,
      lastAccessed: Date.now(),
      accessCount: 0,
    });

    this.emitEvent('set', key);
    this.notifyListeners('set', key);
  }

  invalidate(pattern: string): void {
    const regex = new RegExp(pattern);
    const keysToInvalidate: string[] = [];

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        keysToInvalidate.push(key);
      }
    }

    keysToInvalidate.forEach((key) => {
      this.cache.delete(key);
      this.emitEvent('invalidate', key);
      this.notifyListeners('invalidate', key);
    });
  }

  invalidateStore(shopDomain: string): void {
    this.invalidate(`^${shopDomain}${ShopifyCache.CACHE_KEY_SEPARATOR}`);
  }

  static generateKey(shopDomain: string, resource: string, params?: Readonly<Record<string, unknown>>): string {
    const paramStr = params ? `${ShopifyCache.CACHE_KEY_SEPARATOR}${JSON.stringify(params)}` : '';
    return `${shopDomain}${ShopifyCache.CACHE_KEY_SEPARATOR}${resource}${paramStr}`;
  }

  private getCacheType(key: string): string {
    const parts = key.split(ShopifyCache.CACHE_KEY_SEPARATOR);
    return parts[1] || ShopifyCache.DEFAULT_CACHE_TYPE;
  }

  private emitEvent(type: CacheEvent['type'], key: string): void {
    this.events.push({ type, key, timestamp: Date.now() });
    if (this.events.length > ShopifyCache.MAX_EVENTS) {
      this.events.shift();
    }
  }

  private notifyListeners(event: string, key: string): void {
    this.listeners.get(event)?.forEach((callback) => {
      try {
        callback(key);
      } catch {
      }
    });
  }
}

let cacheInstance: ShopifyCache | null = null;

export function getShopifyCache(): ShopifyCache {
  if (!cacheInstance) {
    cacheInstance = new ShopifyCache();
  }
  return cacheInstance;
}

export interface QueuedRequest {
  readonly id: string;
  readonly priority: number;
  readonly execute: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  retries: number;
  readonly maxRetries: number;
  readonly timeout?: number;
}

export class RequestQueue {
  private static readonly DEFAULT_MAX_CONCURRENT = 5;
  private static readonly DEFAULT_PRIORITY = 5;
  private static readonly DEFAULT_MAX_RETRIES = 3;
  private static readonly DEFAULT_BACKOFF_BASE = 1000;
  private static readonly DEFAULT_BACKOFF_MAX = 30000;
  private static readonly JITTER_MAX = 1000;
  private static readonly RETRYABLE_STATUS_RATE_LIMIT = 429;
  private static readonly RETRYABLE_STATUS_MIN = 500;

  private readonly queue: QueuedRequest[];
  private processing: boolean;
  private readonly maxConcurrent: number;
  private currentConcurrent: number;

  constructor(maxConcurrent: number = RequestQueue.DEFAULT_MAX_CONCURRENT) {
    this.queue = [];
    this.processing = false;
    this.maxConcurrent = maxConcurrent;
    this.currentConcurrent = 0;
  }

  async enqueue<T>(
    execute: () => Promise<T>,
    options: {
      readonly priority?: number;
      readonly maxRetries?: number;
      readonly timeout?: number;
    } = {},
  ): Promise<T> {
    const {
      priority = RequestQueue.DEFAULT_PRIORITY,
      maxRetries = RequestQueue.DEFAULT_MAX_RETRIES,
      timeout,
    } = options;

    return new Promise<T>((resolve, reject) => {
      const request: QueuedRequest = {
        id: `req_${Date.now()}_${Math.random()}`,
        priority,
        execute,
        resolve: resolve as (value: unknown) => void,
        reject,
        retries: 0,
        maxRetries,
        timeout,
      };

      const insertIndex = this.queue.findIndex((r) => r.priority < priority);
      if (insertIndex === -1) {
        this.queue.push(request);
      } else {
        this.queue.splice(insertIndex, 0, request);
      }

      this.process();
    });
  }

  private async process(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0 && this.currentConcurrent < this.maxConcurrent) {
      const request = this.queue.shift();
      if (!request) break;

      this.currentConcurrent++;

      this.executeRequest(request).finally(() => {
        this.currentConcurrent--;
        this.process();
      });
    }

    this.processing = false;
  }

  private async executeRequest(request: QueuedRequest): Promise<void> {
    const executeWithTimeout = async (): Promise<unknown> => {
      if (request.timeout) {
        return Promise.race([
          request.execute(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new ShopifyError(ShopifyErrorType.TIMEOUT, 'Request timeout')), request.timeout),
          ),
        ]);
      }
      return request.execute();
    };

    try {
      const result = await executeWithTimeout();
      request.resolve(result);
    } catch (error) {
      if (request.retries < request.maxRetries && this.isRetryableError(error)) {
        request.retries++;
        const delay = Math.min(
          RequestQueue.DEFAULT_BACKOFF_BASE * Math.pow(2, request.retries) + Math.random() * RequestQueue.JITTER_MAX,
          RequestQueue.DEFAULT_BACKOFF_MAX,
        );
        setTimeout(() => {
          this.queue.unshift(request);
          this.process();
        }, delay);
      } else {
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof ShopifyError) {
      return error.isRetryable();
    }
    const axiosError = error as { response?: { status?: number } };
    return axiosError.response?.status === RequestQueue.RETRYABLE_STATUS_RATE_LIMIT || (axiosError.response?.status ?? 0) >= RequestQueue.RETRYABLE_STATUS_MIN;
  }

  getSize(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue.forEach((req) => {
      req.reject(new Error('Queue cleared'));
    });
    this.queue.length = 0;
  }
}

class ConnectionPool {
  private static readonly TIMEOUT_MS = 30000;
  private static readonly LARGE_PAYLOAD_THRESHOLD = 1024;
  private static readonly TOKEN_PREFIX_LENGTH = 10;

  private readonly pools: Map<string, AxiosInstance>;

  constructor() {
    this.pools = new Map();
  }

  getInstance(shopDomain: string, accessToken: string): AxiosInstance {
    const key = `${shopDomain}${ShopifyCache.CACHE_KEY_SEPARATOR}${accessToken.substring(0, ConnectionPool.TOKEN_PREFIX_LENGTH)}`;

    if (!this.pools.has(key)) {
      const instance = axios.create({
        baseURL: `https://${shopDomain}/admin/api/${API_VERSION}`,
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        timeout: ConnectionPool.TIMEOUT_MS,
        decompress: true,
      });

      instance.interceptors.request.use((config) => {
        if (config.data && typeof config.data === 'object') {
          const dataStr = JSON.stringify(config.data);
          if (dataStr.length > ConnectionPool.LARGE_PAYLOAD_THRESHOLD) {
            if (config.headers) {
              config.headers['Content-Encoding'] = 'gzip';
            }
          }
        }
        return config;
      });

      this.pools.set(key, instance);
    }

    return this.pools.get(key)!;
  }

  clear(shopDomain?: string): void {
    if (shopDomain) {
      const keysToDelete: string[] = [];
      for (const key of this.pools.keys()) {
        if (key.startsWith(shopDomain)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach((key) => this.pools.delete(key));
    } else {
      this.pools.clear();
    }
  }
}

const connectionPool = new ConnectionPool();

export class GraphQLQueryOptimizer {
  private static readonly BASE_COST = 1;
  private static readonly FIELD_COST_MULTIPLIER = 0.1;
  private static readonly CONNECTION_COST = 1;
  private static readonly LIMIT_COST_MULTIPLIER = 0.01;
  private static readonly FIELD_PATTERN = /\w+\s*\{/g;
  private static readonly CONNECTION_PATTERN = /\w+\(first:\s*\d+\)/g;
  private static readonly LIMIT_PATTERN = /first:\s*(\d+)/g;

  static estimateCost(query: string): number {
    const fieldCount = (query.match(GraphQLQueryOptimizer.FIELD_PATTERN) || []).length;
    const connectionCount = (query.match(GraphQLQueryOptimizer.CONNECTION_PATTERN) || []).length;
    const connectionLimits = (query.match(GraphQLQueryOptimizer.LIMIT_PATTERN) || []).map((m) => parseInt(m.split(':')[1].trim(), 10));
    const totalLimit = connectionLimits.reduce((sum, limit) => sum + limit, 0);

    return GraphQLQueryOptimizer.BASE_COST + fieldCount * GraphQLQueryOptimizer.FIELD_COST_MULTIPLIER + connectionCount * GraphQLQueryOptimizer.CONNECTION_COST + totalLimit * GraphQLQueryOptimizer.LIMIT_COST_MULTIPLIER;
  }
}

interface ShopResponse {
  readonly shop: unknown;
}

interface ProductsResponse {
  readonly products: readonly unknown[];
}

interface CollectionsResponse {
  readonly collections?: readonly unknown[];
}

interface PagesResponse {
  readonly pages?: readonly unknown[];
}

interface ArticlesResponse {
  readonly articles?: readonly unknown[];
}

interface BlogsResponse {
  readonly blogs?: readonly unknown[];
}

interface ArticleResponse {
  readonly article: unknown;
}

interface BlogArticleInput {
  readonly title: string;
  readonly body_html: string;
  readonly author: string;
  readonly tags?: string;
  readonly published?: boolean;
  readonly published_at?: string;
  readonly summary?: string;
  readonly image?: {
    readonly src: string;
    readonly alt?: string;
  };
}

export class ShopifyAPI {
  private static readonly SERVICE_NAME = 'ShopifyAPI';
  private static readonly DEFAULT_PRIORITY = 5;
  private static readonly DEFAULT_TIMEOUT = 30000;
  private static readonly DEFAULT_MAX_RETRIES = 3;
  private static readonly DEFAULT_RETRY_DELAY = 1000;
  private static readonly DEFAULT_MAX_DELAY = 30000;
  private static readonly DEFAULT_BACKOFF_MULTIPLIER = 2;
  private static readonly DEFAULT_PRIORITY_HIGH = 10;
  private static readonly DEFAULT_PRIORITY_MEDIUM = 8;
  private static readonly DEFAULT_PRODUCTS_LIMIT = 250;
  private static readonly DEFAULT_REQUEST_QUEUE_SIZE = 5;
  private static readonly RETRYABLE_ERRORS: readonly string[] = ['rate limit', 'timeout', 'network', 'server_error'] as const;
  private static readonly PAGE_INFO_PATTERN = /<[^>]+page_info=([^>]+)>; rel="next"/;
  private static readonly HTTP_STATUS_RATE_LIMIT = 429;
  private static readonly HTTP_STATUS_UNAUTHORIZED = 401;
  private static readonly HTTP_STATUS_FORBIDDEN = 403;
  private static readonly HTTP_STATUS_NOT_FOUND = 404;
  private static readonly HTTP_STATUS_UNPROCESSABLE_ENTITY = 422;
  private static readonly HTTP_STATUS_SERVER_ERROR_MIN = 500;

  private readonly api: AxiosInstance;
  public readonly shopDomain: string;
  public readonly accessToken: string;
  private readonly cache: ShopifyCache;
  private readonly rateLimiter: ReturnType<typeof getShopifyRateLimiter>;
  private readonly requestQueue: RequestQueue;

  constructor(shopDomain: string, accessToken: string) {
    validateShopDomain(shopDomain);
    validateAccessToken(accessToken);
    this.shopDomain = shopDomain;
    this.accessToken = accessToken;
    this.cache = getShopifyCache();
    this.rateLimiter = getShopifyRateLimiter();
    this.requestQueue = new RequestQueue(ShopifyAPI.DEFAULT_REQUEST_QUEUE_SIZE);

    this.api = connectionPool.getInstance(shopDomain, accessToken);

    this.api.get = withDeduplication(this.api.get.bind(this.api));
    this.api.post = withDeduplication(this.api.post.bind(this.api));
    this.api.put = withDeduplication(this.api.put.bind(this.api));
    this.api.delete = withDeduplication(this.api.delete.bind(this.api));

    this.api.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response) {
          const status = error.response.status;
          const data = error.response.data;

          if (status === ShopifyAPI.HTTP_STATUS_RATE_LIMIT) {
            const retryAfter = error.response.headers['retry-after'] || error.response.headers['x-shopify-api-version'];
            throw new ShopifyError(
              ShopifyErrorType.RATE_LIMIT,
              'Shopify API rate limit exceeded',
              status,
              retryAfter ? parseInt(String(retryAfter), 10) * 1000 : undefined,
            );
          }

          if (status === ShopifyAPI.HTTP_STATUS_UNAUTHORIZED) {
            throw new ShopifyError(
              ShopifyErrorType.AUTHENTICATION_FAILED,
              'Shopify authentication failed. Please reconnect your store.',
              status,
            );
          }

          if (status === ShopifyAPI.HTTP_STATUS_FORBIDDEN) {
            throw new ShopifyError(
              ShopifyErrorType.PERMISSION_DENIED,
              'Insufficient permissions for this Shopify operation',
              status,
            );
          }

          if (status === ShopifyAPI.HTTP_STATUS_NOT_FOUND) {
            throw new ShopifyError(
              ShopifyErrorType.NOT_FOUND,
              data?.errors?.[0]?.message || 'Resource not found in Shopify',
              status,
            );
          }

          if (status === ShopifyAPI.HTTP_STATUS_UNPROCESSABLE_ENTITY) {
            const errorMessage = data?.errors?.[0]?.message || data?.error || 'Validation error';
            throw new ShopifyError(
              ShopifyErrorType.VALIDATION_ERROR,
              errorMessage,
              status,
              undefined,
              data?.errors,
            );
          }

          if (status >= ShopifyAPI.HTTP_STATUS_SERVER_ERROR_MIN) {
            throw new ShopifyError(
              ShopifyErrorType.SERVER_ERROR,
              `Shopify server error: ${data?.error || error.message}`,
              status,
            );
          }

          throw new ShopifyError(
            ShopifyErrorType.UNKNOWN,
            `Shopify API error: ${data?.error || error.message}`,
            status,
          );
        }

        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
          throw new ShopifyError(ShopifyErrorType.TIMEOUT, 'Request to Shopify timed out', undefined, undefined);
        }

        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
          throw new ShopifyError(ShopifyErrorType.NETWORK_ERROR, 'Failed to connect to Shopify', undefined, undefined);
        }

        if (error instanceof ShopifyError) {
          throw error;
        }

        throw new ShopifyError(
          ShopifyErrorType.UNKNOWN,
          `Unexpected error: ${error.message || String(error)}`,
          undefined,
        );
      },
    );
  }

  destroy(): void {
    this.requestQueue.clear();
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    return retry(fn, {
      maxAttempts: options.maxAttempts || ShopifyAPI.DEFAULT_MAX_RETRIES,
      initialDelay: options.initialDelay || ShopifyAPI.DEFAULT_RETRY_DELAY,
      maxDelay: options.maxDelay || ShopifyAPI.DEFAULT_MAX_DELAY,
      backoffMultiplier: options.backoffMultiplier || ShopifyAPI.DEFAULT_BACKOFF_MULTIPLIER,
      retryableErrors: options.retryableErrors || ShopifyAPI.RETRYABLE_ERRORS,
      onRetry: options.onRetry,
    });
  }

  private async executeRequest<T>(
    requestFn: () => Promise<T>,
    options: {
      readonly priority?: number;
      readonly timeout?: number;
      readonly cacheKey?: string;
      readonly allowStale?: boolean;
    } = {},
  ): Promise<T> {
    const { priority = ShopifyAPI.DEFAULT_PRIORITY, timeout = ShopifyAPI.DEFAULT_TIMEOUT, cacheKey, allowStale = true } = options;

    if (cacheKey) {
      const cached = this.cache.get<T>(cacheKey, allowStale);
      if (cached.data !== null) {
        if (cached.stale) {
          this.requestQueue.enqueue(
            async () => {
              try {
                const fresh = await this.retryWithBackoff(requestFn);
                this.cache.set(cacheKey, fresh);
                return fresh;
              } catch {
                return cached.data as T;
              }
            },
            { priority: 1 },
          );
        }
        return cached.data as T;
      }
    }

    return this.requestQueue.enqueue(
      () => this.retryWithBackoff(requestFn),
      { priority, timeout, maxRetries: ShopifyAPI.DEFAULT_MAX_RETRIES },
    );
  }

  async getShop(shopDomain: string, accessToken: string): Promise<unknown> {
    validateShopDomain(shopDomain);
    validateAccessToken(accessToken);
    const cacheKey = ShopifyCache.generateKey(shopDomain, 'shop');
    const startTime = Date.now();
    return this.executeRequest(
      async () => {
        const rateLimitCheck = await this.rateLimiter.checkRestLimit(shopDomain);
        if (!rateLimitCheck.allowed) {
          await this.rateLimiter.waitForRestToken(shopDomain);
        }

        const response = await this.api.get<ShopResponse>('/shop.json');
        const shop = response.data.shop;
        this.cache.set(cacheKey, shop);
        
        const duration = Date.now() - startTime;
        structuredLog('info', ShopifyAPI.SERVICE_NAME, 'Shop fetched', {
          shopDomain,
          durationMs: duration,
        });

        return shop;
      },
      { cacheKey, priority: ShopifyAPI.DEFAULT_PRIORITY_HIGH },
    );
  }

  async getProducts(shopDomain: string, accessToken: string, limit: number = ShopifyAPI.DEFAULT_PRODUCTS_LIMIT): Promise<readonly unknown[]> {
    validateShopDomain(shopDomain);
    validateAccessToken(accessToken);
    validateLimit(limit);
    const cacheKey = ShopifyCache.generateKey(shopDomain, 'products', { limit });
    const startTime = Date.now();
    return this.executeRequest(
      async () => {
        const products: unknown[] = [];
        let pageInfo: string | null = null;

        do {
          const params: { limit: number; page_info?: string } = { limit };
          if (pageInfo) params.page_info = pageInfo;

          const response = await this.api.get<ProductsResponse>('/products.json', { params });
          products.push(...response.data.products);

          const linkHeader = response.headers.link;
          if (linkHeader) {
            const nextMatch = linkHeader.match(ShopifyAPI.PAGE_INFO_PATTERN);
            pageInfo = nextMatch ? nextMatch[1] : null;
          } else {
            pageInfo = null;
          }
        } while (pageInfo);

        this.cache.set(cacheKey, products);
        
        const duration = Date.now() - startTime;
        structuredLog('info', ShopifyAPI.SERVICE_NAME, 'Products fetched', {
          shopDomain,
          count: products.length,
          durationMs: duration,
        });

        return products;
      },
      { cacheKey },
    );
  }

  async getCollections(shopDomain: string, accessToken: string): Promise<readonly unknown[]> {
    validateShopDomain(shopDomain);
    validateAccessToken(accessToken);
    const cacheKey = ShopifyCache.generateKey(shopDomain, 'collections');
    const startTime = Date.now();
    return this.executeRequest(
      async () => {
        const response = await this.api.get<CollectionsResponse>('/collections.json');
        const collections = response.data.collections || [];
        this.cache.set(cacheKey, collections);
        
        const duration = Date.now() - startTime;
        structuredLog('info', ShopifyAPI.SERVICE_NAME, 'Collections fetched', {
          shopDomain,
          count: collections.length,
          durationMs: duration,
        });

        return collections;
      },
      { cacheKey },
    );
  }

  async getPages(shopDomain: string, accessToken: string): Promise<readonly unknown[]> {
    validateShopDomain(shopDomain);
    validateAccessToken(accessToken);
    const cacheKey = ShopifyCache.generateKey(shopDomain, 'pages');
    const startTime = Date.now();
    return this.executeRequest(
      async () => {
        const response = await this.api.get<PagesResponse>('/pages.json');
        const pages = response.data.pages || [];
        this.cache.set(cacheKey, pages);
        
        const duration = Date.now() - startTime;
        structuredLog('info', ShopifyAPI.SERVICE_NAME, 'Pages fetched', {
          shopDomain,
          count: pages.length,
          durationMs: duration,
        });

        return pages;
      },
      { cacheKey },
    );
  }

  async getBlogArticles(shopDomain: string, accessToken: string, blogId?: number): Promise<readonly unknown[]> {
    validateShopDomain(shopDomain);
    validateAccessToken(accessToken);
    if (blogId !== undefined) {
      validateBlogId(blogId);
    }
    if (!blogId) {
      const blogs = await this.getBlogs(shopDomain, accessToken);
      if (blogs.length === 0) return [];
      blogId = (blogs[0] as { id: number }).id;
    }

    const cacheKey = ShopifyCache.generateKey(shopDomain, 'articles', { blogId });
    const startTime = Date.now();
    return this.executeRequest(
      async () => {
        const response = await this.api.get<ArticlesResponse>(`/blogs/${blogId}/articles.json`);
        const articles = response.data.articles || [];
        this.cache.set(cacheKey, articles);
        
        const duration = Date.now() - startTime;
        structuredLog('info', ShopifyAPI.SERVICE_NAME, 'Blog articles fetched', {
          shopDomain,
          blogId,
          count: articles.length,
          durationMs: duration,
        });

        return articles;
      },
      { cacheKey },
    );
  }

  async createBlogArticle(
    shopDomain: string,
    accessToken: string,
    blogId: number,
    article: BlogArticleInput,
  ): Promise<unknown> {
    validateShopDomain(shopDomain);
    validateAccessToken(accessToken);
    validateBlogId(blogId);
    validateArticleInput(article);
    const idempotencyKey = `create_article_${blogId}_${article.title}_${Date.now()}`;
    const cacheKey = ShopifyCache.generateKey(shopDomain, 'article_create', { idempotencyKey });
    const startTime = Date.now();
    return this.executeRequest(
      async () => {
        const response = await this.api.post<ArticleResponse>(`/blogs/${blogId}/articles.json`, { article });
        const createdArticle = response.data.article;

        this.cache.invalidate(`^${shopDomain}${ShopifyCache.CACHE_KEY_SEPARATOR}articles:.*blogId.*${blogId}`);
        this.cache.invalidate(`^${shopDomain}${ShopifyCache.CACHE_KEY_SEPARATOR}blogs`);

        const duration = Date.now() - startTime;
        structuredLog('info', ShopifyAPI.SERVICE_NAME, 'Blog article created', {
          shopDomain,
          blogId,
          durationMs: duration,
        });

        return createdArticle;
      },
      { cacheKey, priority: ShopifyAPI.DEFAULT_PRIORITY_MEDIUM },
    );
  }

  async updateBlogArticle(
    shopDomain: string,
    accessToken: string,
    blogId: number,
    articleId: number,
    updates: Readonly<Partial<unknown>>,
  ): Promise<unknown> {
    validateShopDomain(shopDomain);
    validateAccessToken(accessToken);
    validateBlogId(blogId);
    validateArticleId(articleId);
    if (!updates || typeof updates !== 'object') {
      throw new Error('Invalid updates: must be an object');
    }
    const startTime = Date.now();
    return this.executeRequest(
      async () => {
        const response = await this.api.put<ArticleResponse>(`/blogs/${blogId}/articles/${articleId}.json`, { article: updates });
        const updatedArticle = response.data.article;

        this.cache.invalidate(`^${shopDomain}${ShopifyCache.CACHE_KEY_SEPARATOR}articles:.*blogId.*${blogId}`);

        const duration = Date.now() - startTime;
        structuredLog('info', ShopifyAPI.SERVICE_NAME, 'Blog article updated', {
          shopDomain,
          blogId,
          articleId,
          durationMs: duration,
        });

        return updatedArticle;
      },
      { priority: ShopifyAPI.DEFAULT_PRIORITY_MEDIUM },
    );
  }

  async deleteBlogArticle(
    shopDomain: string,
    accessToken: string,
    blogId: number,
    articleId: number,
  ): Promise<void> {
    validateShopDomain(shopDomain);
    validateAccessToken(accessToken);
    validateBlogId(blogId);
    validateArticleId(articleId);
    const startTime = Date.now();
    return this.executeRequest(
      async () => {
        await this.api.delete(`/blogs/${blogId}/articles/${articleId}.json`);

        this.cache.invalidate(`^${shopDomain}${ShopifyCache.CACHE_KEY_SEPARATOR}articles:.*blogId.*${blogId}`);
        this.cache.invalidate(`^${shopDomain}${ShopifyCache.CACHE_KEY_SEPARATOR}blogs`);

        const duration = Date.now() - startTime;
        structuredLog('info', ShopifyAPI.SERVICE_NAME, 'Blog article deleted', {
          shopDomain,
          blogId,
          articleId,
          durationMs: duration,
        });
      },
      { priority: ShopifyAPI.DEFAULT_PRIORITY_MEDIUM },
    );
  }

  async getBlogs(shopDomain: string, accessToken: string): Promise<readonly unknown[]> {
    validateShopDomain(shopDomain);
    validateAccessToken(accessToken);
    const cacheKey = ShopifyCache.generateKey(shopDomain, 'blogs');
    const startTime = Date.now();
    return this.executeRequest(
      async () => {
        const response = await this.api.get<BlogsResponse>('/blogs.json');
        const blogs = response.data.blogs || [];
        this.cache.set(cacheKey, blogs);
        
        const duration = Date.now() - startTime;
        structuredLog('info', ShopifyAPI.SERVICE_NAME, 'Blogs fetched', {
          shopDomain,
          count: blogs.length,
          durationMs: duration,
        });

        return blogs;
      },
      { cacheKey },
    );
  }
}

export interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: ReadonlyArray<{
    readonly message: string;
    readonly path?: ReadonlyArray<string | number>;
    readonly extensions?: Readonly<{
      readonly code?: string;
      readonly cost?: number;
      readonly maxCost?: number;
      readonly fieldName?: string;
      readonly argumentName?: string;
    }>;
  }>;
  readonly extensions?: Readonly<{
    readonly cost?: Readonly<{
      readonly requestedQueryCost: number;
      readonly actualQueryCost: number;
      readonly throttleStatus: Readonly<{
        readonly maximumAvailable: number;
        readonly currentlyAvailable: number;
        readonly restoreRate: number;
      }>;
    }>;
  }>;
}

interface FileUploadResult {
  readonly fileCreate: Readonly<{
    readonly files: ReadonlyArray<Readonly<{
      readonly id: string;
      readonly fileStatus: string;
      readonly image?: Readonly<{
        readonly url: string;
        readonly altText?: string;
      }>;
    }>>;
    readonly userErrors: ReadonlyArray<Readonly<{
      readonly field: readonly string[];
      readonly message: string;
    }>>;
  }>;
}

export class ShopifyGraphQL {
  private static readonly SERVICE_NAME = 'ShopifyGraphQL';
  private static readonly DEFAULT_PRIORITY = 5;
  private static readonly DEFAULT_TIMEOUT = 30000;
  private static readonly DEFAULT_USE_CACHE = true;
  private static readonly DEFAULT_MAX_RETRIES = 3;
  private static readonly DEFAULT_REQUEST_QUEUE_SIZE = 5;
  private static readonly DEFAULT_PRIORITY_LOW = 1;
  private static readonly DEFAULT_PRIORITY_MEDIUM = 6;
  private static readonly DEFAULT_PRIORITY_HIGH = 7;
  private static readonly DEFAULT_PRIORITY_VERY_HIGH = 8;
  private static readonly DEFAULT_PRIORITY_CRITICAL = 9;
  private static readonly DEFAULT_IMAGE_UPLOAD_TIMEOUT = 60000;
  private static readonly DEFAULT_IMAGE_UPLOAD_RETRIES = 3;
  private static readonly DEFAULT_POLL_ATTEMPTS = 10;
  private static readonly DEFAULT_POLL_DELAY = 2000;
  private static readonly DEFAULT_CACHE_KEY_LENGTH = 100;
  private static readonly THROTTLE_WARNING_THRESHOLD = 10;
  private static readonly HTTP_STATUS_UNAUTHORIZED = 401;
  private static readonly HTTP_STATUS_FORBIDDEN = 403;
  private static readonly HTTP_STATUS_NOT_FOUND = 404;
  private static readonly HTTP_STATUS_TOO_MANY_REQUESTS = 429;
  private static readonly HTTP_STATUS_UNPROCESSABLE_ENTITY = 422;
  private static readonly HTTP_STATUS_INTERNAL_ERROR = 500;
  private static readonly HTTP_STATUS_BAD_GATEWAY = 502;
  private static readonly HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
  private static readonly FILE_STATUS_READY = 'READY';
  private static readonly FILE_STATUS_FAILED = 'FAILED';
  private static readonly MEDIA_CONTENT_TYPE_IMAGE = 'IMAGE';
  private static readonly BACKOFF_BASE = 1000;
  private static readonly BACKOFF_MAX = 10000;
  private static readonly JITTER_MAX = 1000;

  private readonly shopDomain: string;
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly cache: ShopifyCache;
  private readonly rateLimiter: ReturnType<typeof getShopifyRateLimiter>;
  private readonly requestQueue: RequestQueue;

  constructor(shopDomain: string, accessToken: string) {
    validateShopDomain(shopDomain);
    validateAccessToken(accessToken);
    this.shopDomain = shopDomain;
    this.accessToken = accessToken;
    this.baseUrl = `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`;
    this.cache = getShopifyCache();
    this.rateLimiter = getShopifyRateLimiter();
    this.requestQueue = new RequestQueue(ShopifyGraphQL.DEFAULT_REQUEST_QUEUE_SIZE);
  }

  destroy(): void {
    this.requestQueue.clear();
  }

  async query<T>(
    query: string,
    variables?: Readonly<Record<string, unknown>>,
    options: {
      readonly priority?: number;
      readonly timeout?: number;
      readonly useCache?: boolean;
      readonly cacheKey?: string;
    } = {},
  ): Promise<T> {
    validateQuery(query);
    const { priority = ShopifyGraphQL.DEFAULT_PRIORITY, timeout = ShopifyGraphQL.DEFAULT_TIMEOUT, useCache = ShopifyGraphQL.DEFAULT_USE_CACHE, cacheKey } = options;

    const finalCacheKey = cacheKey || this.generateCacheKey(query, variables);

    if (useCache) {
      const cached = this.cache.get<T>(finalCacheKey);
      if (cached.data !== null) {
        if (cached.stale) {
          this.requestQueue.enqueue(
            async () => {
              try {
                const fresh = await this.executeQuery<T>(query, variables, priority, timeout);
                this.cache.set(finalCacheKey, fresh);
                return fresh;
              } catch {
                return cached.data!;
              }
            },
            { priority: ShopifyGraphQL.DEFAULT_PRIORITY_LOW },
          );
        }
        return cached.data!;
      }
    }

    return this.requestQueue.enqueue(
      () => this.executeQuery<T>(query, variables, priority, timeout),
      { priority, timeout, maxRetries: ShopifyGraphQL.DEFAULT_MAX_RETRIES },
    ).then((result: T) => {
      if (useCache) {
        this.cache.set(finalCacheKey, result);
      }
      return result;
    });
  }

  private async executeQuery<T>(
    query: string,
    variables?: Readonly<Record<string, unknown>>,
    priority: number = ShopifyGraphQL.DEFAULT_PRIORITY,
    timeout: number = ShopifyGraphQL.DEFAULT_TIMEOUT,
  ): Promise<T> {
    const startTime = Date.now();
    const estimatedCost = GraphQLQueryOptimizer.estimateCost(query);
    const rateLimitCheck = await this.rateLimiter.checkGraphQLLimit(this.shopDomain, estimatedCost);
    if (!rateLimitCheck.allowed) {
      await this.rateLimiter.waitForGraphQLToken(this.shopDomain);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': this.accessToken,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw this.parseHttpError(response);
      }

      const data: GraphQLResponse<T> = await response.json() as GraphQLResponse<T>;

      if (data.errors && data.errors.length > 0) {
        throw this.parseGraphQLErrors(data.errors);
      }

      if (data.extensions?.cost) {
        const { throttleStatus } = data.extensions.cost;
        if (throttleStatus.currentlyAvailable < ShopifyGraphQL.THROTTLE_WARNING_THRESHOLD) {
          structuredLog('warn', ShopifyGraphQL.SERVICE_NAME, 'GraphQL throttle warning', {
            shopDomain: this.shopDomain,
            currentlyAvailable: throttleStatus.currentlyAvailable,
            maximumAvailable: throttleStatus.maximumAvailable,
          });
        }
        await this.rateLimiter.recordGraphQLCost(this.shopDomain, data.extensions.cost.actualQueryCost);
      }

      if (!data.data) {
        throw new ShopifyError(ShopifyErrorType.GRAPHQL_ERROR, 'No data returned from GraphQL query');
      }

      const duration = Date.now() - startTime;
      structuredLog('info', ShopifyGraphQL.SERVICE_NAME, 'GraphQL query executed', {
        shopDomain: this.shopDomain,
        estimatedCost,
        actualCost: data.extensions?.cost?.actualQueryCost,
        durationMs: duration,
      });

      return data.data;
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      const duration = Date.now() - startTime;
      structuredLog('error', ShopifyGraphQL.SERVICE_NAME, 'GraphQL query failed', {
        shopDomain: this.shopDomain,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });

      if ((error as { name?: string }).name === 'AbortError') {
        throw new ShopifyError(ShopifyErrorType.TIMEOUT, 'GraphQL query timeout', undefined, timeout);
      }

      if (error instanceof ShopifyError) {
        throw error;
      }

      throw new ShopifyError(
        ShopifyErrorType.NETWORK_ERROR,
        `GraphQL request failed: ${error instanceof Error ? error.message : String(error)}`,
        (error as { status?: number }).status,
      );
    }
  }

  private parseHttpError(response: Response): ShopifyError {
    const status = response.status;

    switch (status) {
      case ShopifyGraphQL.HTTP_STATUS_UNAUTHORIZED:
        return new ShopifyError(ShopifyErrorType.AUTHENTICATION_FAILED, 'Authentication failed', status);
      case ShopifyGraphQL.HTTP_STATUS_FORBIDDEN:
        return new ShopifyError(ShopifyErrorType.PERMISSION_DENIED, 'Permission denied', status);
      case ShopifyGraphQL.HTTP_STATUS_NOT_FOUND:
        return new ShopifyError(ShopifyErrorType.NOT_FOUND, 'Resource not found', status);
      case ShopifyGraphQL.HTTP_STATUS_TOO_MANY_REQUESTS:
        const retryAfter = response.headers.get('Retry-After');
        return new ShopifyError(
          ShopifyErrorType.RATE_LIMIT,
          'Rate limit exceeded',
          status,
          retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined,
        );
      case ShopifyGraphQL.HTTP_STATUS_UNPROCESSABLE_ENTITY:
        return new ShopifyError(ShopifyErrorType.VALIDATION_ERROR, 'Validation error', status);
      case ShopifyGraphQL.HTTP_STATUS_INTERNAL_ERROR:
      case ShopifyGraphQL.HTTP_STATUS_BAD_GATEWAY:
      case ShopifyGraphQL.HTTP_STATUS_SERVICE_UNAVAILABLE:
        return new ShopifyError(ShopifyErrorType.SERVER_ERROR, 'Server error', status);
      default:
        return new ShopifyError(ShopifyErrorType.UNKNOWN, `HTTP error: ${status}`, status);
    }
  }

  private parseGraphQLErrors(errors: GraphQLResponse<unknown>['errors']): ShopifyError {
    const userErrors: Array<{ readonly field: readonly string[]; readonly message: string }> = [];
    const apiErrors: string[] = [];
    let errorType = ShopifyErrorType.GRAPHQL_ERROR;
    const extensions: Record<string, unknown> = {};

    for (const error of errors || []) {
      const code = error.extensions?.code;

      if (code === 'USER_ERROR' || error.path) {
        errorType = ShopifyErrorType.USER_ERROR;
        userErrors.push({
          field: error.path?.map(String) || [],
          message: error.message,
        });
      } else {
        apiErrors.push(error.message);
        if (code) {
          extensions[code] = error.extensions;
        }
      }
    }

    if (userErrors.length > 0) {
      return new ShopifyError(
        errorType,
        `GraphQL user errors: ${userErrors.map((e) => e.message).join(', ')}`,
        undefined,
        undefined,
        userErrors,
        extensions,
      );
    }

    return new ShopifyError(
      errorType,
      `GraphQL API errors: ${apiErrors.join(', ')}`,
      undefined,
      undefined,
      undefined,
      extensions,
    );
  }

  private generateCacheKey(query: string, variables?: Readonly<Record<string, unknown>>): string {
    const varStr = variables ? JSON.stringify(variables) : '';
    return ShopifyCache.generateKey(this.shopDomain, 'graphql', { query: query.substring(0, ShopifyGraphQL.DEFAULT_CACHE_KEY_LENGTH), vars: varStr });
  }

  async uploadImage(imageUrl: string, altText?: string, retries: number = ShopifyGraphQL.DEFAULT_IMAGE_UPLOAD_RETRIES): Promise<{ readonly id: string; readonly url: string } | null> {
    validateImageUrl(imageUrl);
    if (altText !== undefined && (typeof altText !== 'string' || altText.length > 500)) {
      throw new Error('Invalid alt text: must be a string with max length 500');
    }
    if (!Number.isInteger(retries) || retries < 1 || retries > 10) {
      throw new Error('Invalid retries: must be an integer between 1 and 10');
    }

    const mutation = `
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            fileStatus
            ... on MediaImage {
              image {
                url
                altText
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    let lastError: Error | null = null;
    const startTime = Date.now();

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await this.query<FileUploadResult>(
          mutation,
          {
            files: [
              {
                originalSource: imageUrl,
                alt: altText,
                mediaContentType: ShopifyGraphQL.MEDIA_CONTENT_TYPE_IMAGE,
              },
            ],
          },
          { useCache: false, priority: ShopifyGraphQL.DEFAULT_PRIORITY_MEDIUM, timeout: ShopifyGraphQL.DEFAULT_IMAGE_UPLOAD_TIMEOUT },
        );

        if (result.fileCreate.userErrors && result.fileCreate.userErrors.length > 0) {
          const errors = result.fileCreate.userErrors
            .map((e) => `${e.field.join('.')}: ${e.message}`)
            .join(', ');
          throw new ShopifyError(ShopifyErrorType.USER_ERROR, `Image upload errors: ${errors}`, undefined, undefined, result.fileCreate.userErrors);
        }

        const file = result.fileCreate.files[0];
        if (file && file.id && file.image?.url) {
          const duration = Date.now() - startTime;
          structuredLog('info', ShopifyGraphQL.SERVICE_NAME, 'Image uploaded', {
            shopDomain: this.shopDomain,
            fileId: file.id,
            durationMs: duration,
          });
          return {
            id: file.id,
            url: file.image.url,
          };
        }

        if (file && file.id && file.fileStatus !== ShopifyGraphQL.FILE_STATUS_READY) {
          const fileUrl = await this.pollFileStatus(file.id, ShopifyGraphQL.DEFAULT_POLL_ATTEMPTS);
          if (fileUrl) {
            const duration = Date.now() - startTime;
            structuredLog('info', ShopifyGraphQL.SERVICE_NAME, 'Image uploaded after polling', {
              shopDomain: this.shopDomain,
              fileId: file.id,
              durationMs: duration,
            });
            return { id: file.id, url: fileUrl };
          }
        }

        return null;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof ShopifyError && error.type === ShopifyErrorType.USER_ERROR) {
          throw error;
        }

        if (attempt < retries) {
          const delay = Math.min(
            ShopifyGraphQL.BACKOFF_BASE * Math.pow(2, attempt) + Math.random() * ShopifyGraphQL.JITTER_MAX,
            ShopifyGraphQL.BACKOFF_MAX,
          );
          structuredLog('warn', ShopifyGraphQL.SERVICE_NAME, 'Retrying image upload', {
            shopDomain: this.shopDomain,
            attempt,
            delayMs: delay,
            error: lastError.message,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    const duration = Date.now() - startTime;
    structuredLog('error', ShopifyGraphQL.SERVICE_NAME, 'Image upload failed after retries', {
      shopDomain: this.shopDomain,
      retries,
      durationMs: duration,
      error: lastError?.message,
    });

    return null;
  }

  private async pollFileStatus(fileId: string, maxAttempts: number = ShopifyGraphQL.DEFAULT_POLL_ATTEMPTS): Promise<string | null> {
    const query = `
      query getFile($id: ID!) {
        node(id: $id) {
          ... on MediaImage {
            image {
              url
            }
            fileStatus
          }
        }
      }
    `;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.query<{
          readonly node: Readonly<{
            readonly image?: Readonly<{ readonly url: string }>;
            readonly fileStatus: string;
          }> | null;
        }>(query, { id: fileId }, { useCache: false, priority: ShopifyGraphQL.DEFAULT_PRIORITY_LOW });

        if (result.node?.fileStatus === ShopifyGraphQL.FILE_STATUS_READY && result.node.image?.url) {
          return result.node.image.url;
        }

        if (result.node?.fileStatus === ShopifyGraphQL.FILE_STATUS_FAILED) {
          return null;
        }

        await new Promise((resolve) => setTimeout(resolve, ShopifyGraphQL.DEFAULT_POLL_DELAY));
      } catch {
        return null;
      }
    }

    return null;
  }

  async cancelSubscription(
    subscriptionId: string,
    prorate: boolean = false,
  ): Promise<Readonly<{
    readonly success: boolean;
    readonly userErrors: ReadonlyArray<Readonly<{ readonly field: readonly string[]; readonly message: string }>>;
  }>> {
    validateSubscriptionId(subscriptionId);
    const startTime = Date.now();
    const mutation = `
      mutation AppSubscriptionCancel($id: ID!, $prorate: Boolean) {
        appSubscriptionCancel(id: $id, prorate: $prorate) {
          userErrors {
            field
            message
          }
          appSubscription {
            id
            status
          }
        }
      }
    `;

    try {
      const result = await this.query<{
        readonly appSubscriptionCancel: Readonly<{
          readonly userErrors: ReadonlyArray<Readonly<{ readonly field: readonly string[]; readonly message: string }>>;
          readonly appSubscription: Readonly<{ readonly id: string; readonly status: string }> | null;
        }>;
      }>(mutation, {
        id: subscriptionId,
        prorate,
      }, { useCache: false, priority: ShopifyGraphQL.DEFAULT_PRIORITY_CRITICAL });

      const duration = Date.now() - startTime;
      structuredLog('info', ShopifyGraphQL.SERVICE_NAME, 'Subscription cancelled', {
        shopDomain: this.shopDomain,
        subscriptionId,
        success: result.appSubscriptionCancel.userErrors.length === 0,
        durationMs: duration,
      });

      return {
        success: result.appSubscriptionCancel.userErrors.length === 0,
        userErrors: result.appSubscriptionCancel.userErrors,
      };
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      structuredLog('error', ShopifyGraphQL.SERVICE_NAME, 'Failed to cancel subscription', {
        shopDomain: this.shopDomain,
        subscriptionId,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      return {
        success: false,
        userErrors: [
          {
            field: [],
            message: error instanceof Error ? error.message : 'Failed to cancel subscription',
          },
        ],
      };
    }
  }
}

export class ShopifyClient {
  public readonly rest: ShopifyAPI;
  public readonly graphql: ShopifyGraphQL;
  public readonly cache: ShopifyCache;
  public readonly imageCDN: ShopifyImageCDN;

  constructor(shopDomain: string, accessToken: string) {
    validateShopDomain(shopDomain);
    validateAccessToken(accessToken);
    this.rest = new ShopifyAPI(shopDomain, accessToken);
    this.graphql = new ShopifyGraphQL(shopDomain, accessToken);
    this.cache = getShopifyCache();
    this.imageCDN = new ShopifyImageCDN(this.graphql, shopDomain);
  }

  destroy(): void {
    this.rest.destroy();
    this.graphql.destroy();
  }

  get shopDomain(): string {
    return this.rest.shopDomain;
  }

  get accessToken(): string {
    return this.rest.accessToken;
  }
}

export interface ImageUploadOptions {
  readonly width?: number;
  readonly height?: number;
  readonly format?: 'webp' | 'avif' | 'jpeg' | 'png';
  readonly quality?: number;
  readonly altText?: string;
}

export interface ImageUploadResult {
  readonly url: string;
  readonly cdnUrl: string;
  readonly shopifyImageId: string | null;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly size: number;
}

export class ShopifyImageCDN {
  private static readonly DEFAULT_ALT_TEXT = 'Generated image';
  private static readonly DEFAULT_WIDTH = 1280;
  private static readonly DEFAULT_HEIGHT = 720;
  private static readonly DEFAULT_FORMAT = 'webp';
  private static readonly DEFAULT_FORMAT_FALLBACK = 'jpeg';
  private static readonly DEFAULT_IMAGE_UPLOAD_RETRIES = 3;

  private readonly shopifyGraphQL: ShopifyGraphQL;
  private readonly shopDomain: string;

  constructor(shopifyGraphQL: ShopifyGraphQL, shopDomain: string) {
    validateShopDomain(shopDomain);
    this.shopifyGraphQL = shopifyGraphQL;
    this.shopDomain = shopDomain;
  }

  async uploadImage(imageUrl: string, options?: ImageUploadOptions): Promise<ImageUploadResult> {
    validateImageUrl(imageUrl);
    if (options?.width !== undefined && (!Number.isInteger(options.width) || options.width <= 0 || options.width > 10000)) {
      throw new Error('Invalid width: must be an integer between 1 and 10000');
    }
    if (options?.height !== undefined && (!Number.isInteger(options.height) || options.height <= 0 || options.height > 10000)) {
      throw new Error('Invalid height: must be an integer between 1 and 10000');
    }
    if (options?.quality !== undefined && (typeof options.quality !== 'number' || options.quality < 0 || options.quality > 100)) {
      throw new Error('Invalid quality: must be a number between 0 and 100');
    }
    if (options?.altText !== undefined && (typeof options.altText !== 'string' || options.altText.length > 500)) {
      throw new Error('Invalid alt text: must be a string with max length 500');
    }

    const altText = options?.altText || ShopifyImageCDN.DEFAULT_ALT_TEXT;
    const startTime = Date.now();

    try {
      const uploadResult = await this.shopifyGraphQL.uploadImage(imageUrl, altText, ShopifyImageCDN.DEFAULT_IMAGE_UPLOAD_RETRIES);

      if (!uploadResult) {
        const duration = Date.now() - startTime;
        structuredLog('warn', 'ShopifyImageCDN', 'Image upload returned null', {
          shopDomain: this.shopDomain,
          imageUrl,
          durationMs: duration,
        });
        return {
          url: imageUrl,
          cdnUrl: imageUrl,
          shopifyImageId: null,
          width: options?.width || 0,
          height: options?.height || 0,
          format: options?.format || ShopifyImageCDN.DEFAULT_FORMAT_FALLBACK,
          size: 0,
        };
      }

      const duration = Date.now() - startTime;
      structuredLog('info', 'ShopifyImageCDN', 'Image uploaded successfully', {
        shopDomain: this.shopDomain,
        shopifyImageId: uploadResult.id,
        durationMs: duration,
      });

      return {
        url: uploadResult.url,
        cdnUrl: uploadResult.url,
        shopifyImageId: uploadResult.id,
        width: options?.width || ShopifyImageCDN.DEFAULT_WIDTH,
        height: options?.height || ShopifyImageCDN.DEFAULT_HEIGHT,
        format: options?.format || ShopifyImageCDN.DEFAULT_FORMAT,
        size: 0,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', 'ShopifyImageCDN', 'Image upload failed', {
        shopDomain: this.shopDomain,
        imageUrl,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      return {
        url: imageUrl,
        cdnUrl: imageUrl,
        shopifyImageId: null,
        width: options?.width || 0,
        height: options?.height || 0,
        format: options?.format || ShopifyImageCDN.DEFAULT_FORMAT_FALLBACK,
        size: 0,
      };
    }
  }
}
