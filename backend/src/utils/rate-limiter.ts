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
  readonly history: readonly Array<{ readonly timestamp: number; readonly requests: number; readonly rejected: number }>;
}

export interface DistributedStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttl?: number): Promise<void>;
  increment(key: string, by?: number, ttl?: number): Promise<number>;
  decrement(key: string, by?: number): Promise<number>;
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

export class RateLimiter {
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
  private static readonly MAX_QUERY_COST = 1000;
  private static readonly KEY_SEPARATOR = ':';

  private readonly state: Map<string, RateLimitState>;
  private readonly config: Required<Omit<RateLimitConfig, 'distributed' | 'keyPrefix'>> &
    Pick<RateLimitConfig, 'distributed' | 'keyPrefix'>;
  private readonly metrics: Map<string, RateLimitMetrics>;
  private readonly cache: Map<string, CacheEntry>;
  private readonly cacheTTL: number;
  private readonly validator: RateLimitValidator;

  constructor(config: RateLimitConfig) {
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
  }

  async checkLimit(
    key: string,
    cost: number = 1,
    priority: number = 5,
  ): Promise<RateLimitResult> {
    this.validator.validateCost(cost);
    this.validator.validatePriority(priority);

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

      return result;
    } catch (error) {
      state.concurrency.current = Math.max(0, state.concurrency.current - 1);
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
    const startTime = Date.now();
    let backoffDelay = RateLimiter.DEFAULT_BACKOFF_DELAY;

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.checkLimit(key, cost, priority);
      if (result.allowed) {
        return true;
      }

      const waitTime = Math.min(result.waitTime ?? RateLimiter.DEFAULT_WAIT_TIME, maxWaitMs - (Date.now() - startTime));
      if (waitTime > 0) {
        const jitter = Math.random() * RateLimiter.JITTER_MAX;
        await sleep(Math.min(waitTime + backoffDelay + jitter, maxWaitMs - (Date.now() - startTime)));
        backoffDelay = Math.min(backoffDelay * RateLimiter.DEFAULT_BACKOFF_MULTIPLIER, RateLimiter.MAX_BACKOFF_DELAY);
      }
    }

    return false;
  }

  async getStatus(key: string): Promise<RateLimitResult> {
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
    return new Map(this.metrics);
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
        if (stored) {
          return stored as RateLimitState;
        }
      } catch {
      }
    }

    return this.getOrCreateState(key);
  }

  private async saveStateDistributed(key: string, state: RateLimitState): Promise<void> {
    if (this.config.distributed) {
      try {
        await this.config.distributed.set(key, state, Math.ceil(this.config.windowMs / RateLimiter.MILLISECONDS_PER_SECOND));
      } catch {
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

  validateCost(cost: number): void {
    if (cost < 0 || !Number.isFinite(cost)) {
      throw new Error(`Invalid cost: ${cost}`);
    }
  }

  validatePriority(priority: number): void {
    if (priority < RateLimitValidator.MIN_PRIORITY || priority > RateLimitValidator.MAX_PRIORITY) {
      throw new Error(`Invalid priority: ${priority}. Must be between ${RateLimitValidator.MIN_PRIORITY} and ${RateLimitValidator.MAX_PRIORITY}`);
    }
  }
}

export class ShopifyRateLimiter {
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
  private config: ShopifyRateLimitConfig;
  private readonly planLimits: ReadonlyMap<ShopifyPlanTier, PlanLimit>;

  constructor(config: ShopifyRateLimitConfig) {
    this.config = config;
    this.planLimits = new Map([
      [ShopifyPlanTier.STANDARD, { pointsPerSecond: 100, restoreRate: ShopifyRateLimiter.DEFAULT_GRAPHQL_RESTORE_RATE, bucketSize: 1000 }],
      [ShopifyPlanTier.ADVANCED, { pointsPerSecond: 200, restoreRate: ShopifyRateLimiter.DEFAULT_GRAPHQL_RESTORE_RATE, bucketSize: 2000 }],
      [ShopifyPlanTier.PLUS, { pointsPerSecond: 1000, restoreRate: ShopifyRateLimiter.DEFAULT_GRAPHQL_RESTORE_RATE, bucketSize: 10000 }],
      [ShopifyPlanTier.ENTERPRISE, { pointsPerSecond: 2000, restoreRate: ShopifyRateLimiter.DEFAULT_GRAPHQL_RESTORE_RATE, bucketSize: 20000 }],
    ]);

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

  async checkRestLimit(shopDomain: string): Promise<RateLimitResult> {
    return this.restLimiter.checkLimit(shopDomain);
  }

  async checkGraphQLLimit(
    shopDomain: string,
    requestedCost: number,
    actualCost?: number,
  ): Promise<RateLimitResult> {
    if (requestedCost > RateLimiter.MAX_QUERY_COST) {
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
      const state = await this.getGraphQLState(shopDomain);
      if (state) {
        state.tokens = Math.min(
          this.getGraphQLBurst(),
          state.tokens + refund,
        );
      }
    }

    return result;
  }

  async recordGraphQLCost(shopDomain: string, cost: number): Promise<void> {
  }

  async waitForRestToken(shopDomain: string): Promise<boolean> {
    return this.restLimiter.waitForToken(shopDomain);
  }

  async waitForGraphQLToken(shopDomain: string, cost: number = 1): Promise<boolean> {
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
      const state = await (this.graphqlLimiter as unknown as { getOrCreateStateDistributed: (key: string) => Promise<RateLimitState> }).getOrCreateStateDistributed(key);
      return state;
    } catch {
      return null;
    }
  }

  private getGraphQLBurst(): number {
    const planLimit = this.planLimits.get(this.config.planTier) ?? this.planLimits.get(ShopifyPlanTier.STANDARD)!;
    return this.config.graphqlBucketSize ?? planLimit.bucketSize;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let shopifyRateLimiterInstance: ShopifyRateLimiter | null = null;

export function getShopifyRateLimiter(
  config?: ShopifyRateLimitConfig,
): ShopifyRateLimiter {
  if (!shopifyRateLimiterInstance) {
    shopifyRateLimiterInstance = new ShopifyRateLimiter(
      config ?? { planTier: ShopifyPlanTier.STANDARD },
    );
  }
  return shopifyRateLimiterInstance;
}
