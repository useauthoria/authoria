export type RateLimitAlgorithm = 'token-bucket' | 'leaky-bucket' | 'sliding-window' | 'fixed-window';

export interface RateLimitConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly burst?: number;
  readonly algorithm?: RateLimitAlgorithm;
  readonly restoreRate?: number;
  readonly distributed?: DistributedStorage;
  readonly keyPrefix?: string;
  readonly concurrency?: number;
}

export interface RateLimitState {
  tokens: number;
  lastRefill: number;
  requests: number;
  rejected: number;
  waitTime: number;
  history: Array<{ readonly timestamp: number; readonly allowed: boolean; readonly cost?: number }>;
  concurrency: {
    current: number;
    max: number;
  };
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
  readonly waitTime?: number;
  readonly cost?: number;
}

interface MutableRateLimitMetrics {
  totalRequests: number;
  totalAllowed: number;
  totalRejected: number;
  rejectionRate: number;
  averageWaitTime: number;
  averageCost: number;
  concurrency: {
    average: number;
    peak: number;
  };
  history: Array<{ readonly timestamp: number; readonly requests: number; readonly rejected: number }>;
}

export interface RateLimitMetrics {
  readonly totalRequests: number;
  readonly totalAllowed: number;
  readonly totalRejected: number;
  readonly rejectionRate: number;
  readonly averageWaitTime: number;
  readonly averageCost: number;
  readonly concurrency: {
    readonly average: number;
    readonly peak: number;
  };
  readonly history: ReadonlyArray<{ readonly timestamp: number; readonly requests: number; readonly rejected: number }>;
}

export interface DistributedStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttl?: number): Promise<void>;
  increment(key: string, by?: number, ttl?: number): Promise<number>;
  decrement(key: string, by?: number, ttl?: number): Promise<number>;
  delete(key: string): Promise<void>;
}

export enum ShopifyPlanTier {
  STANDARD = 'standard',
  ADVANCED = 'advanced',
  PLUS = 'plus',
  ENTERPRISE = 'enterprise',
}

export interface ShopifyRateLimitConfig {
  readonly planTier: ShopifyPlanTier;
  readonly restApiLimit?: number;
  readonly graphqlLimit?: number;
  readonly graphqlRestoreRate?: number;
  readonly graphqlBucketSize?: number;
}

interface CacheEntry {
  readonly result: RateLimitResult;
  readonly expiresAt: number;
}

interface PlanLimit {
  readonly pointsPerSecond: number;
  readonly restoreRate: number;
  readonly bucketSize: number;
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

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const generateCorrelationId = (): string => {
  return `rate_limit_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
};

const validateKey = (key: string): void => {
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    throw new Error('Invalid key: must be a non-empty string');
  }
  if (key.length > 500) {
    throw new Error('Invalid key: exceeds maximum length of 500');
  }
};

const validateShopDomain = (shopDomain: string): void => {
  if (!shopDomain || typeof shopDomain !== 'string' || shopDomain.trim().length === 0) {
    throw new Error('Invalid shop domain: must be a non-empty string');
  }
  if (!shopDomain.includes('.') || shopDomain.length > 255) {
    throw new Error('Invalid shop domain format');
  }
};

const validateMaxRequests = (maxRequests: number): void => {
  if (!Number.isInteger(maxRequests) || maxRequests <= 0 || maxRequests > 1000000) {
    throw new Error('Invalid maxRequests: must be an integer between 1 and 1000000');
  }
};

const validateWindowMs = (windowMs: number): void => {
  if (!Number.isInteger(windowMs) || windowMs <= 0 || windowMs > 3600000) {
    throw new Error('Invalid windowMs: must be an integer between 1 and 3600000ms');
  }
};

const validateBurst = (burst: number): void => {
  if (!Number.isFinite(burst) || burst <= 0 || burst > 10000000) {
    throw new Error('Invalid burst: must be a number between 0 and 10000000');
  }
};

const validateRestoreRate = (restoreRate: number): void => {
  if (!Number.isFinite(restoreRate) || restoreRate <= 0 || restoreRate > 1000000) {
    throw new Error('Invalid restoreRate: must be a number between 0 and 1000000');
  }
};

const validateConcurrency = (concurrency: number): void => {
  if (!Number.isFinite(concurrency) || concurrency <= 0 || concurrency > 100000) {
    throw new Error('Invalid concurrency: must be a number between 0 and 100000');
  }
};

const validateKeyPrefix = (keyPrefix: string): void => {
  if (keyPrefix !== undefined && (typeof keyPrefix !== 'string' || keyPrefix.length > 100)) {
    throw new Error('Invalid keyPrefix: must be a string with max length 100');
  }
};

const isRateLimitAlgorithm = (algorithm: string): algorithm is RateLimitAlgorithm => {
  return ['token-bucket', 'leaky-bucket', 'sliding-window', 'fixed-window'].includes(algorithm);
};

const isShopifyPlanTier = (tier: string): tier is ShopifyPlanTier => {
  return Object.values(ShopifyPlanTier).includes(tier as ShopifyPlanTier);
};

export class RateLimiter {
  private static readonly SERVICE_NAME = 'RateLimiter';
  private static readonly DEFAULT_ALGORITHM: RateLimitAlgorithm = 'token-bucket';
  private static readonly DEFAULT_CACHE_TTL = 1000;
  private static readonly DEFAULT_CONCURRENCY = Infinity;
  private static readonly DEFAULT_WAIT_TIME = 1000;
  private static readonly DEFAULT_BACKOFF_DELAY = 100;
  private static readonly DEFAULT_BACKOFF_MULTIPLIER = 1.5;
  private static readonly MAX_BACKOFF_DELAY = 5000;
  private static readonly JITTER_MAX = 100;
  private static readonly MAX_HISTORY_LENGTH = 1000;
  private static readonly METRICS_HISTORY_LENGTH = 100;
  private static readonly MILLISECONDS_PER_SECOND = 1000;
  private static readonly SECONDS_PER_MINUTE = 60;
  private static readonly MILLISECONDS_PER_MINUTE = 60000;
  static readonly MAX_QUERY_COST = 1000;
  static readonly KEY_SEPARATOR = ':';
  private static readonly CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly MAX_CACHE_SIZE = 10000;

  private readonly state: Map<string, RateLimitState>;
  private readonly config: Required<Omit<RateLimitConfig, 'distributed' | 'keyPrefix'>> &
    Pick<RateLimitConfig, 'distributed' | 'keyPrefix'>;
  private readonly metrics: Map<string, MutableRateLimitMetrics>;
  private readonly cache: Map<string, CacheEntry>;
  private readonly cacheTTL: number;
  private readonly validator: RateLimitValidator;
  private cacheCleanupInterval?: number;

  constructor(config: RateLimitConfig) {
    validateMaxRequests(config.maxRequests);
    validateWindowMs(config.windowMs);
    if (config.burst !== undefined) {
      validateBurst(config.burst);
    }
    if (config.restoreRate !== undefined) {
      validateRestoreRate(config.restoreRate);
    }
    if (config.concurrency !== undefined) {
      validateConcurrency(config.concurrency);
    }
    if (config.algorithm !== undefined && !isRateLimitAlgorithm(config.algorithm)) {
      throw new Error(`Invalid algorithm: ${config.algorithm}`);
    }
    validateKeyPrefix(config.keyPrefix ?? '');

    this.state = new Map();
    this.config = {
      maxRequests: config.maxRequests,
      windowMs: config.windowMs,
      burst: config.burst ?? config.maxRequests,
      algorithm: config.algorithm ?? RateLimiter.DEFAULT_ALGORITHM,
      restoreRate: config.restoreRate ?? config.maxRequests / (config.windowMs / RateLimiter.MILLISECONDS_PER_SECOND),
      concurrency: config.concurrency ?? RateLimiter.DEFAULT_CONCURRENCY,
      distributed: config.distributed,
      keyPrefix: config.keyPrefix,
    };
    this.metrics = new Map();
    this.cache = new Map();
    this.cacheTTL = RateLimiter.DEFAULT_CACHE_TTL;
    this.validator = new RateLimitValidator();
    this.startCacheCleanup();
  }

  destroy(): void {
    if (this.cacheCleanupInterval !== undefined) {
      clearInterval(this.cacheCleanupInterval);
      this.cacheCleanupInterval = undefined;
    }
    this.state.clear();
    this.metrics.clear();
    this.cache.clear();
  }

  private startCacheCleanup(): void {
    this.cacheCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.cache.entries()) {
        if (entry.expiresAt < now) {
          this.cache.delete(key);
        }
      }
      if (this.cache.size > RateLimiter.MAX_CACHE_SIZE) {
        const entries = Array.from(this.cache.entries());
        entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
        const toDelete = entries.slice(0, entries.length - RateLimiter.MAX_CACHE_SIZE);
        for (const [key] of toDelete) {
          this.cache.delete(key);
        }
      }
    }, RateLimiter.CACHE_CLEANUP_INTERVAL_MS) as unknown as number;
  }

  async checkLimit(
    key: string,
    cost: number = 1,
    priority: number = 5,
  ): Promise<RateLimitResult> {
    validateKey(key);
    this.validator.validateCost(cost);
    this.validator.validatePriority(priority);

    const correlationId = generateCorrelationId();
    const startTime = Date.now();
    const fullKey = this.getFullKey(key);

    const cached = this.cache.get(fullKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const state = this.getOrCreateState(fullKey);
    if (state.concurrency.current >= this.config.concurrency) {
      const result: RateLimitResult = {
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + RateLimiter.DEFAULT_WAIT_TIME,
        waitTime: RateLimiter.DEFAULT_WAIT_TIME,
      };
      this.recordMetrics(fullKey, false, cost, 0);
      const duration = Date.now() - startTime;
      structuredLog('warn', RateLimiter.SERVICE_NAME, 'Rate limit check - concurrency exceeded', {
        correlationId,
        key: fullKey,
        cost,
        durationMs: duration,
      });
      return result;
    }

    state.concurrency.current++;

    try {
      const now = Date.now();
      let result: RateLimitResult;

      switch (this.config.algorithm) {
        case 'leaky-bucket':
          result = await this.checkLeakyBucket(fullKey, cost, now);
          break;
        case 'sliding-window':
          result = await this.checkSlidingWindow(fullKey, cost, now);
          break;
        case 'fixed-window':
          result = await this.checkFixedWindow(fullKey, cost, now);
          break;
        case 'token-bucket':
        default:
          result = await this.checkTokenBucket(fullKey, cost, now);
          break;
      }

      this.recordMetrics(fullKey, result.allowed, cost, result.waitTime ?? 0);

      state.history.push({
        timestamp: now,
        allowed: result.allowed,
        cost,
      });

      if (state.history.length > RateLimiter.MAX_HISTORY_LENGTH) {
        state.history = state.history.slice(-RateLimiter.MAX_HISTORY_LENGTH);
      }

      this.cache.set(fullKey, {
        result,
        expiresAt: now + this.cacheTTL,
      });

      if (result.allowed) {
        state.concurrency.current = Math.max(0, state.concurrency.current - 1);
      }

      const duration = Date.now() - startTime;
      structuredLog('info', RateLimiter.SERVICE_NAME, 'Rate limit check completed', {
        correlationId,
        key: fullKey,
        allowed: result.allowed,
        remaining: result.remaining,
        cost,
        durationMs: duration,
      });

      return result;
    } catch (error) {
      state.concurrency.current = Math.max(0, state.concurrency.current - 1);
      const duration = Date.now() - startTime;
      structuredLog('error', RateLimiter.SERVICE_NAME, 'Rate limit check failed', {
        correlationId,
        key: fullKey,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      throw error;
    }
  }

  private async checkTokenBucket(
    key: string,
    cost: number,
    now: number,
  ): Promise<RateLimitResult> {
    const state = await this.getOrCreateStateDistributed(key);
    const timePassed = now - state.lastRefill;
    const tokensToAdd = Math.floor((timePassed / this.config.windowMs) * this.config.maxRequests);

    if (tokensToAdd > 0) {
      state.tokens = Math.min(this.config.burst, state.tokens + tokensToAdd);
      state.lastRefill = now;
    }

    if (state.tokens >= cost) {
      state.tokens -= cost;
      state.requests += 1;
      await this.saveStateDistributed(key, state);

      return {
        allowed: true,
        remaining: Math.floor(state.tokens),
        resetAt: now + this.config.windowMs,
        cost,
      };
    }

    const tokensNeeded = cost - state.tokens;
    const waitTime = (tokensNeeded / this.config.maxRequests) * this.config.windowMs;
    const resetAt = now + waitTime;

    state.rejected += 1;
    await this.saveStateDistributed(key, state);

    return {
      allowed: false,
      remaining: 0,
      resetAt,
      waitTime,
      cost,
    };
  }

  private async checkLeakyBucket(
    key: string,
    cost: number,
    now: number,
  ): Promise<RateLimitResult> {
    const state = await this.getOrCreateStateDistributed(key);
    const timePassed = (now - state.lastRefill) / RateLimiter.MILLISECONDS_PER_SECOND;
    const tokensToAdd = timePassed * this.config.restoreRate;

    if (tokensToAdd > 0) {
      state.tokens = Math.min(this.config.burst, state.tokens + tokensToAdd);
      state.lastRefill = now;
    }

    if (state.tokens >= cost) {
      state.tokens -= cost;
      state.requests += 1;
      await this.saveStateDistributed(key, state);

      return {
        allowed: true,
        remaining: Math.floor(state.tokens),
        resetAt: now + (this.config.burst / this.config.restoreRate) * RateLimiter.MILLISECONDS_PER_SECOND,
        cost,
      };
    }

    const tokensNeeded = cost - state.tokens;
    const waitTime = (tokensNeeded / this.config.restoreRate) * RateLimiter.MILLISECONDS_PER_SECOND;
    const resetAt = now + waitTime;

    state.rejected += 1;
    await this.saveStateDistributed(key, state);

    return {
      allowed: false,
      remaining: 0,
      resetAt,
      waitTime,
      cost,
    };
  }

  private async checkSlidingWindow(
    key: string,
    cost: number,
    now: number,
  ): Promise<RateLimitResult> {
    const state = await this.getOrCreateStateDistributed(key);
    const windowStart = now - this.config.windowMs;

    state.history = state.history.filter((h) => h.timestamp > windowStart);

    const requestsInWindow = state.history.filter((h) => h.allowed).length;
    const totalCostInWindow = state.history.reduce((sum, h) => sum + (h.cost ?? 1), 0);

    if (requestsInWindow < this.config.maxRequests && totalCostInWindow + cost <= this.config.burst) {
      state.requests += 1;
      await this.saveStateDistributed(key, state);

      return {
        allowed: true,
        remaining: this.config.maxRequests - requestsInWindow - 1,
        resetAt: now + this.config.windowMs,
        cost,
      };
    }

    const oldestRequest = state.history[0];
    const resetAt = oldestRequest ? oldestRequest.timestamp + this.config.windowMs : now + this.config.windowMs;
    const waitTime = Math.max(0, resetAt - now);

    state.rejected += 1;
    await this.saveStateDistributed(key, state);

    return {
      allowed: false,
      remaining: 0,
      resetAt,
      waitTime,
      cost,
    };
  }

  private async checkFixedWindow(
    key: string,
    cost: number,
    now: number,
  ): Promise<RateLimitResult> {
    const state = await this.getOrCreateStateDistributed(key);
    const windowStart = Math.floor(now / this.config.windowMs) * this.config.windowMs;

    if (state.lastRefill < windowStart) {
      state.tokens = this.config.burst;
      state.lastRefill = windowStart;
    }

    if (state.tokens >= cost) {
      state.tokens -= cost;
      state.requests += 1;
      await this.saveStateDistributed(key, state);

      return {
        allowed: true,
        remaining: Math.floor(state.tokens),
        resetAt: windowStart + this.config.windowMs,
        cost,
      };
    }

    const resetAt = windowStart + this.config.windowMs;
    const waitTime = resetAt - now;

    state.rejected += 1;
    await this.saveStateDistributed(key, state);

    return {
      allowed: false,
      remaining: 0,
      resetAt,
      waitTime,
      cost,
    };
  }

  async waitForToken(
    key: string,
    maxWaitMs: number = RateLimiter.MILLISECONDS_PER_MINUTE,
    cost: number = 1,
    priority: number = 5,
  ): Promise<boolean> {
    validateKey(key);
    this.validator.validateCost(cost);
    this.validator.validatePriority(priority);
    if (!Number.isInteger(maxWaitMs) || maxWaitMs <= 0 || maxWaitMs > 600000) {
      throw new Error('Invalid maxWaitMs: must be an integer between 1 and 600000ms');
    }

    const correlationId = generateCorrelationId();
    const startTime = Date.now();
    let backoffDelay = RateLimiter.DEFAULT_BACKOFF_DELAY;
    let attempt = 0;

    while (Date.now() - startTime < maxWaitMs) {
      attempt++;
      const result = await this.checkLimit(key, cost, priority);
      if (result.allowed) {
        const duration = Date.now() - startTime;
        structuredLog('info', RateLimiter.SERVICE_NAME, 'Token acquired after waiting', {
          correlationId,
          key,
          attempt,
          durationMs: duration,
        });
        return true;
      }

      const waitTime = Math.min(result.waitTime ?? RateLimiter.DEFAULT_WAIT_TIME, maxWaitMs - (Date.now() - startTime));
      if (waitTime > 0) {
        const jitter = Math.random() * RateLimiter.JITTER_MAX;
        await sleep(Math.min(waitTime + backoffDelay + jitter, maxWaitMs - (Date.now() - startTime)));
        backoffDelay = Math.min(backoffDelay * RateLimiter.DEFAULT_BACKOFF_MULTIPLIER, RateLimiter.MAX_BACKOFF_DELAY);
      }
    }

    const duration = Date.now() - startTime;
    structuredLog('warn', RateLimiter.SERVICE_NAME, 'Token wait timeout', {
      correlationId,
      key,
      attempt,
      maxWaitMs,
      durationMs: duration,
    });

    return false;
  }

  async getStatus(key: string): Promise<RateLimitResult> {
    validateKey(key);
    const fullKey = this.getFullKey(key);
    const state = await this.getOrCreateStateDistributed(fullKey);
    const now = Date.now();

    let remaining = 0;
    let resetAt = now + this.config.windowMs;

    switch (this.config.algorithm) {
      case 'leaky-bucket': {
        const timePassed = (now - state.lastRefill) / RateLimiter.MILLISECONDS_PER_SECOND;
        const tokensToAdd = timePassed * this.config.restoreRate;
        remaining = Math.min(this.config.burst, state.tokens + tokensToAdd);
        resetAt = now + ((this.config.burst - remaining) / this.config.restoreRate) * RateLimiter.MILLISECONDS_PER_SECOND;
        break;
      }
      case 'token-bucket':
      default: {
        const timePassedMs = now - state.lastRefill;
        const tokensToAddMs = Math.floor((timePassedMs / this.config.windowMs) * this.config.maxRequests);
        remaining = Math.min(this.config.burst, state.tokens + tokensToAddMs);
        resetAt = state.lastRefill + this.config.windowMs;
        break;
      }
    }

    return {
      allowed: remaining > 0,
      remaining: Math.floor(remaining),
      resetAt,
    };
  }

  getAllMetrics(): ReadonlyMap<string, RateLimitMetrics> {
    const result = new Map<string, RateLimitMetrics>();
    for (const [key, metrics] of this.metrics.entries()) {
      result.set(key, {
        totalRequests: metrics.totalRequests,
        totalAllowed: metrics.totalAllowed,
        totalRejected: metrics.totalRejected,
        rejectionRate: metrics.rejectionRate,
        averageWaitTime: metrics.averageWaitTime,
        averageCost: metrics.averageCost,
        concurrency: {
          average: metrics.concurrency.average,
          peak: metrics.concurrency.peak,
        },
        history: metrics.history,
      });
    }
    return result;
  }

  private recordMetrics(
    key: string,
    allowed: boolean,
    cost: number,
    waitTime: number,
  ): void {
    let metrics = this.metrics.get(key);
    if (!metrics) {
      metrics = {
        totalRequests: 0,
        totalAllowed: 0,
        totalRejected: 0,
        rejectionRate: 0,
        averageWaitTime: 0,
        averageCost: 0,
        concurrency: { average: 0, peak: 0 },
        history: [],
      };
      this.metrics.set(key, metrics);
    }

    metrics.totalRequests++;
    if (allowed) {
      metrics.totalAllowed++;
    } else {
      metrics.totalRejected++;
    }

    metrics.rejectionRate = metrics.totalRejected / metrics.totalRequests;
    metrics.averageWaitTime =
      (metrics.averageWaitTime * (metrics.totalRequests - 1) + waitTime) / metrics.totalRequests;
    metrics.averageCost = (metrics.averageCost * (metrics.totalRequests - 1) + cost) / metrics.totalRequests;

    const state = this.state.get(key);
    if (state) {
      metrics.concurrency.peak = Math.max(metrics.concurrency.peak, state.concurrency.current);
      metrics.concurrency.average =
        (metrics.concurrency.average * (metrics.totalRequests - 1) + state.concurrency.current) / metrics.totalRequests;
    }

    const now = Date.now();
    metrics.history.push({
      timestamp: now,
      requests: metrics.totalRequests,
      rejected: metrics.totalRejected,
    });

    if (metrics.history.length > RateLimiter.METRICS_HISTORY_LENGTH) {
      metrics.history = metrics.history.slice(-RateLimiter.METRICS_HISTORY_LENGTH);
    }
  }

  private getOrCreateState(key: string): RateLimitState {
    if (!this.state.has(key)) {
      this.state.set(key, {
        tokens: this.config.burst,
        lastRefill: Date.now(),
        requests: 0,
        rejected: 0,
        waitTime: 0,
        history: [],
        concurrency: {
          current: 0,
          max: this.config.concurrency,
        },
      });
    }
    return this.state.get(key)!;
  }

  private async getOrCreateStateDistributed(key: string): Promise<RateLimitState> {
    if (this.config.distributed) {
      try {
        const stored = await this.config.distributed.get(key);
        if (stored && typeof stored === 'object') {
          const state = stored as RateLimitState;
          if (typeof state.tokens === 'number' && typeof state.lastRefill === 'number') {
            return state;
          }
        }
      } catch (error) {
        structuredLog('warn', RateLimiter.SERVICE_NAME, 'Failed to get distributed state, using local', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return this.getOrCreateState(key);
  }

  private async saveStateDistributed(key: string, state: RateLimitState): Promise<void> {
    if (this.config.distributed) {
      try {
        await this.config.distributed.set(key, state, Math.ceil(this.config.windowMs / RateLimiter.MILLISECONDS_PER_SECOND));
      } catch (error) {
        structuredLog('warn', RateLimiter.SERVICE_NAME, 'Failed to save distributed state, using local', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        this.state.set(key, state);
      }
    } else {
      this.state.set(key, state);
    }
  }

  private getFullKey(key: string): string {
    return this.config.keyPrefix ? `${this.config.keyPrefix}${RateLimiter.KEY_SEPARATOR}${key}` : key;
  }
}

class RateLimitValidator {
  private static readonly MIN_PRIORITY = 0;
  private static readonly MAX_PRIORITY = 10;
  private static readonly MAX_COST = 1000000;

  validateCost(cost: number): void {
    if (!Number.isFinite(cost) || cost < 0 || cost > RateLimitValidator.MAX_COST) {
      throw new Error(`Invalid cost: must be a number between 0 and ${RateLimitValidator.MAX_COST}`);
    }
  }

  validatePriority(priority: number): void {
    if (!Number.isInteger(priority) || priority < RateLimitValidator.MIN_PRIORITY || priority > RateLimitValidator.MAX_PRIORITY) {
      throw new Error(`Invalid priority: must be an integer between ${RateLimitValidator.MIN_PRIORITY} and ${RateLimitValidator.MAX_PRIORITY}`);
    }
  }
}

export class ShopifyRateLimiter {
  private static readonly SERVICE_NAME = 'ShopifyRateLimiter';
  private static readonly DEFAULT_REST_API_LIMIT = 40;
  private static readonly DEFAULT_GRAPHQL_RESTORE_RATE = 50;
  private static readonly DEFAULT_WAIT_TIME = 1000;
  private static readonly DEFAULT_MAX_WAIT_MS = 60000;
  private static readonly REST_KEY_PREFIX = 'shopify-rest';
  private static readonly GRAPHQL_KEY_PREFIX = 'shopify-graphql';
  private static readonly STOREFRONT_KEY_PREFIX = 'shopify-storefront';
  private static readonly REST_WINDOW_MS = 60000;
  private static readonly GRAPHQL_WINDOW_MS = 1000;
  private static readonly STOREFRONT_WINDOW_MS = 60000;

  private readonly restLimiter: RateLimiter;
  private readonly graphqlLimiter: RateLimiter;
  private readonly storefrontLimiter: RateLimiter;
  private readonly config: ShopifyRateLimitConfig;
  private readonly planLimits: ReadonlyMap<ShopifyPlanTier, PlanLimit>;

  constructor(config: ShopifyRateLimitConfig) {
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid config: must be an object');
    }
    if (!isShopifyPlanTier(config.planTier)) {
      throw new Error(`Invalid planTier: ${config.planTier}`);
    }
    if (config.restApiLimit !== undefined && (!Number.isInteger(config.restApiLimit) || config.restApiLimit <= 0 || config.restApiLimit > 10000)) {
      throw new Error('Invalid restApiLimit: must be an integer between 1 and 10000');
    }
    if (config.graphqlLimit !== undefined && (!Number.isInteger(config.graphqlLimit) || config.graphqlLimit <= 0 || config.graphqlLimit > 100000)) {
      throw new Error('Invalid graphqlLimit: must be an integer between 1 and 100000');
    }
    if (config.graphqlRestoreRate !== undefined && (!Number.isFinite(config.graphqlRestoreRate) || config.graphqlRestoreRate <= 0 || config.graphqlRestoreRate > 100000)) {
      throw new Error('Invalid graphqlRestoreRate: must be a number between 0 and 100000');
    }
    if (config.graphqlBucketSize !== undefined && (!Number.isInteger(config.graphqlBucketSize) || config.graphqlBucketSize <= 0 || config.graphqlBucketSize > 1000000)) {
      throw new Error('Invalid graphqlBucketSize: must be an integer between 1 and 1000000');
    }

    this.config = config;
    this.planLimits = new Map([
      [ShopifyPlanTier.STANDARD, { pointsPerSecond: 100, restoreRate: ShopifyRateLimiter.DEFAULT_GRAPHQL_RESTORE_RATE, bucketSize: 1000 }],
      [ShopifyPlanTier.ADVANCED, { pointsPerSecond: 200, restoreRate: ShopifyRateLimiter.DEFAULT_GRAPHQL_RESTORE_RATE, bucketSize: 2000 }],
      [ShopifyPlanTier.PLUS, { pointsPerSecond: 1000, restoreRate: ShopifyRateLimiter.DEFAULT_GRAPHQL_RESTORE_RATE, bucketSize: 10000 }],
      [ShopifyPlanTier.ENTERPRISE, { pointsPerSecond: 2000, restoreRate: ShopifyRateLimiter.DEFAULT_GRAPHQL_RESTORE_RATE, bucketSize: 20000 }],
    ] as const);

    const planLimit = this.planLimits.get(config.planTier) ?? this.planLimits.get(ShopifyPlanTier.STANDARD)!;

    this.restLimiter = new RateLimiter({
      maxRequests: config.restApiLimit ?? ShopifyRateLimiter.DEFAULT_REST_API_LIMIT,
      windowMs: ShopifyRateLimiter.REST_WINDOW_MS,
      burst: config.restApiLimit ?? ShopifyRateLimiter.DEFAULT_REST_API_LIMIT,
      algorithm: 'token-bucket',
      keyPrefix: ShopifyRateLimiter.REST_KEY_PREFIX,
    });

    this.graphqlLimiter = new RateLimiter({
      maxRequests: config.graphqlLimit ?? planLimit.pointsPerSecond,
      windowMs: ShopifyRateLimiter.GRAPHQL_WINDOW_MS,
      burst: config.graphqlBucketSize ?? planLimit.bucketSize,
      algorithm: 'leaky-bucket',
      restoreRate: config.graphqlRestoreRate ?? planLimit.restoreRate,
      keyPrefix: ShopifyRateLimiter.GRAPHQL_KEY_PREFIX,
    });

    this.storefrontLimiter = new RateLimiter({
      maxRequests: Infinity,
      windowMs: ShopifyRateLimiter.STOREFRONT_WINDOW_MS,
      algorithm: 'token-bucket',
      keyPrefix: ShopifyRateLimiter.STOREFRONT_KEY_PREFIX,
    });
  }

  destroy(): void {
    this.restLimiter.destroy();
    this.graphqlLimiter.destroy();
    this.storefrontLimiter.destroy();
  }

  async checkRestLimit(shopDomain: string): Promise<RateLimitResult> {
    validateShopDomain(shopDomain);
    return this.restLimiter.checkLimit(shopDomain);
  }

  async checkGraphQLLimit(
    shopDomain: string,
    requestedCost: number,
    actualCost?: number,
  ): Promise<RateLimitResult> {
    validateShopDomain(shopDomain);
    if (!Number.isFinite(requestedCost) || requestedCost < 0 || requestedCost > RateLimiter.MAX_QUERY_COST) {
      structuredLog('warn', ShopifyRateLimiter.SERVICE_NAME, 'GraphQL query cost exceeds maximum', {
        shopDomain,
        requestedCost,
        maxCost: RateLimiter.MAX_QUERY_COST,
      });
      return {
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + ShopifyRateLimiter.DEFAULT_WAIT_TIME,
        waitTime: 0,
        cost: requestedCost,
      };
    }

    const result = await this.graphqlLimiter.checkLimit(shopDomain, requestedCost);

    if (result.allowed && actualCost !== undefined && actualCost < requestedCost) {
      const refund = requestedCost - actualCost;
      if (refund > 0) {
        const state = await this.getGraphQLState(shopDomain);
        if (state) {
          state.tokens = Math.min(
            this.getGraphQLBurst(),
            state.tokens + refund,
          );
          await this.saveGraphQLState(shopDomain, state);
        }
      }
    }

    return result;
  }

  async recordGraphQLCost(shopDomain: string, cost: number): Promise<void> {
    validateShopDomain(shopDomain);
    if (!Number.isFinite(cost) || cost < 0 || cost > RateLimiter.MAX_QUERY_COST) {
      throw new Error(`Invalid cost: must be a number between 0 and ${RateLimiter.MAX_QUERY_COST}`);
    }

    const state = await this.getGraphQLState(shopDomain);
    if (state) {
      const refund = Math.max(0, state.tokens - cost);
      state.tokens = Math.min(this.getGraphQLBurst(), refund);
      await this.saveGraphQLState(shopDomain, state);
    }
  }

  async waitForRestToken(shopDomain: string): Promise<boolean> {
    validateShopDomain(shopDomain);
    return this.restLimiter.waitForToken(shopDomain);
  }

  async waitForGraphQLToken(shopDomain: string, cost: number = 1): Promise<boolean> {
    validateShopDomain(shopDomain);
    if (!Number.isFinite(cost) || cost < 0 || cost > RateLimiter.MAX_QUERY_COST) {
      throw new Error(`Invalid cost: must be a number between 0 and ${RateLimiter.MAX_QUERY_COST}`);
    }
    return this.graphqlLimiter.waitForToken(shopDomain, ShopifyRateLimiter.DEFAULT_MAX_WAIT_MS, cost);
  }

  getAllMetrics(): Readonly<{
    readonly rest: ReadonlyMap<string, RateLimitMetrics>;
    readonly graphql: ReadonlyMap<string, RateLimitMetrics>;
    readonly storefront: ReadonlyMap<string, RateLimitMetrics>;
  }> {
    return {
      rest: this.restLimiter.getAllMetrics(),
      graphql: this.graphqlLimiter.getAllMetrics(),
      storefront: this.storefrontLimiter.getAllMetrics(),
    };
  }

  private async getGraphQLState(shopDomain: string): Promise<RateLimitState | null> {
    try {
      const key = `${ShopifyRateLimiter.GRAPHQL_KEY_PREFIX}${RateLimiter.KEY_SEPARATOR}${shopDomain}`;
      return await (this.graphqlLimiter as unknown as { getOrCreateStateDistributed: (key: string) => Promise<RateLimitState> }).getOrCreateStateDistributed(key);
    } catch (error) {
      structuredLog('warn', ShopifyRateLimiter.SERVICE_NAME, 'Failed to get GraphQL state', {
        shopDomain,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async saveGraphQLState(shopDomain: string, state: RateLimitState): Promise<void> {
    try {
      const key = `${ShopifyRateLimiter.GRAPHQL_KEY_PREFIX}${RateLimiter.KEY_SEPARATOR}${shopDomain}`;
      await (this.graphqlLimiter as unknown as { saveStateDistributed: (key: string, state: RateLimitState) => Promise<void> }).saveStateDistributed(key, state);
    } catch (error) {
      structuredLog('warn', ShopifyRateLimiter.SERVICE_NAME, 'Failed to save GraphQL state', {
        shopDomain,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getGraphQLBurst(): number {
    const planLimit = this.planLimits.get(this.config.planTier) ?? this.planLimits.get(ShopifyPlanTier.STANDARD)!;
    return this.config.graphqlBucketSize ?? planLimit.bucketSize;
  }
}

let shopifyRateLimiterInstance: ShopifyRateLimiter | null = null;

export function getShopifyRateLimiter(
  config?: ShopifyRateLimitConfig,
): ShopifyRateLimiter {
  if (config && (!shopifyRateLimiterInstance || shopifyRateLimiterInstance['config'].planTier !== config.planTier)) {
    if (shopifyRateLimiterInstance) {
      shopifyRateLimiterInstance.destroy();
    }
    shopifyRateLimiterInstance = new ShopifyRateLimiter(config);
  } else if (!shopifyRateLimiterInstance) {
    shopifyRateLimiterInstance = new ShopifyRateLimiter({ planTier: ShopifyPlanTier.STANDARD });
  }
  return shopifyRateLimiterInstance;
}
