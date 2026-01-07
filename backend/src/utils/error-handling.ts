export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum ErrorCategory {
  NETWORK = 'network',
  TIMEOUT = 'timeout',
  RATE_LIMIT = 'rate_limit',
  AUTHENTICATION = 'authentication',
  AUTHORIZATION = 'authorization',
  VALIDATION = 'validation',
  SERVER_ERROR = 'server_error',
  CLIENT_ERROR = 'client_error',
  UNKNOWN = 'unknown',
}

export interface ErrorContext {
  readonly requestId?: string;
  readonly userId?: string;
  readonly timestamp: number;
  readonly service?: string;
  readonly operation?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly stackTrace?: string;
  readonly correlationId?: string;
  readonly cost?: number;
}

export interface ClassifiedError extends Error {
  readonly severity: ErrorSeverity;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly context: ErrorContext;
  readonly originalError?: unknown;
  readonly correlationId?: string;
}

interface ErrorObject {
  readonly message?: string;
  readonly response?: { readonly status?: number };
  readonly status?: number;
  readonly code?: string;
  readonly name?: string;
  readonly stack?: string;
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
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
};

const validateMaxAttempts = (maxAttempts: number): void => {
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > 100) {
    throw new Error('Invalid maxAttempts: must be an integer between 1 and 100');
  }
};

const validateDelay = (delay: number, name: string): void => {
  if (typeof delay !== 'number' || delay < 0 || delay > 600000) {
    throw new Error(`Invalid ${name}: must be a number between 0 and 600000ms`);
  }
};

const validateErrorSampling = (errorSampling: number): void => {
  if (typeof errorSampling !== 'number' || errorSampling < 0 || errorSampling > 1) {
    throw new Error('Invalid errorSampling: must be a number between 0 and 1');
  }
};

const validateRetryOptions = (options: RetryOptions): void => {
  if (options.maxAttempts !== undefined) {
    validateMaxAttempts(options.maxAttempts);
  }
  if (options.initialDelay !== undefined) {
    validateDelay(options.initialDelay, 'initialDelay');
  }
  if (options.maxDelay !== undefined) {
    validateDelay(options.maxDelay, 'maxDelay');
  }
  if (options.errorSampling !== undefined) {
    validateErrorSampling(options.errorSampling);
  }
  if (options.backoffMultiplier !== undefined && (typeof options.backoffMultiplier !== 'number' || options.backoffMultiplier <= 0 || options.backoffMultiplier > 100)) {
    throw new Error('Invalid backoffMultiplier: must be a number between 0 and 100');
  }
};

const isErrorSeverity = (severity: string): severity is ErrorSeverity => {
  return Object.values(ErrorSeverity).includes(severity as ErrorSeverity);
};

const isErrorCategory = (category: string): category is ErrorCategory => {
  return Object.values(ErrorCategory).includes(category as ErrorCategory);
};

const isRetryStrategy = (strategy: string): strategy is RetryStrategy => {
  return ['exponential', 'linear', 'polynomial', 'fixed', 'custom'].includes(strategy);
};

interface ClassificationCacheEntry {
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  readonly retryable: boolean;
  readonly expiresAt: number;
}

const classificationCache = new Map<string, ClassificationCacheEntry>();
const CLASSIFICATION_CACHE_TTL_MS = 5 * 60 * 1000;
const CLASSIFICATION_CACHE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

let cacheCleanupInterval: number | undefined;

const startCacheCleanup = (): void => {
  if (cacheCleanupInterval !== undefined) {
    return;
  }
  cacheCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of classificationCache.entries()) {
      if (entry.expiresAt < now) {
        classificationCache.delete(key);
      }
    }
  }, CLASSIFICATION_CACHE_CLEANUP_INTERVAL_MS) as unknown as number;
};

startCacheCleanup();

const getCacheKey = (error: unknown, statusCode?: number, errorCode?: string): string => {
  const errorObj = error as ErrorObject;
  const message = errorObj?.message ?? String(error);
  return `${statusCode ?? 'no-status'}_${errorCode ?? 'no-code'}_${message.substring(0, 100)}`;
};

export function classifyError(
  error: unknown,
  context?: Partial<ErrorContext>,
): ClassifiedError {
  const errorObj = error as ErrorObject;
  const errorMessage = errorObj?.message ?? String(error);
  const statusCode = errorObj?.response?.status ?? errorObj?.status;
  const errorCode = errorObj?.code;

  const cacheKey = getCacheKey(error, statusCode, errorCode);
  const cached = classificationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const classified: ClassifiedError = {
      name: errorObj?.name ?? 'Error',
      message: errorMessage,
      severity: cached.severity,
      category: cached.category,
      retryable: cached.retryable,
      context: {
        timestamp: Date.now(),
        ...context,
        stackTrace: errorObj?.stack,
        originalError: error,
      },
      correlationId: context?.correlationId ?? generateCorrelationId(),
    } as ClassifiedError;

    if (errorObj?.stack) {
      Object.setPrototypeOf(classified, Error.prototype);
      classified.stack = errorObj.stack;
    }

    return classified;
  }

  let category: ErrorCategory = ErrorCategory.UNKNOWN;
  let severity: ErrorSeverity = ErrorSeverity.MEDIUM;
  let retryable = false;

  if (errorCode === 'ECONNRESET' || errorCode === 'ETIMEDOUT' || errorCode === 'ENOTFOUND') {
    category = ErrorCategory.NETWORK;
    severity = ErrorSeverity.MEDIUM;
    retryable = true;
  } else if (errorCode === 'ETIMEDOUT' || errorMessage.includes('timeout')) {
    category = ErrorCategory.TIMEOUT;
    severity = ErrorSeverity.MEDIUM;
    retryable = true;
  } else if (statusCode === 429 || errorMessage.includes('rate limit')) {
    category = ErrorCategory.RATE_LIMIT;
    severity = ErrorSeverity.LOW;
    retryable = true;
  } else if (statusCode === 401) {
    category = ErrorCategory.AUTHENTICATION;
    severity = ErrorSeverity.HIGH;
    retryable = false;
  } else if (statusCode === 403) {
    category = ErrorCategory.AUTHORIZATION;
    severity = ErrorSeverity.HIGH;
    retryable = false;
  } else if (statusCode === 400 || statusCode === 422) {
    category = ErrorCategory.VALIDATION;
    severity = ErrorSeverity.MEDIUM;
    retryable = false;
  } else if (statusCode !== undefined && statusCode >= 500) {
    category = ErrorCategory.SERVER_ERROR;
    severity = ErrorSeverity.HIGH;
    retryable = true;
  } else if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    category = ErrorCategory.CLIENT_ERROR;
    severity = ErrorSeverity.MEDIUM;
    retryable = false;
  }

  classificationCache.set(cacheKey, {
    category,
    severity,
    retryable,
    expiresAt: Date.now() + CLASSIFICATION_CACHE_TTL_MS,
  });

  const classified: ClassifiedError = {
    name: errorObj?.name ?? 'Error',
    message: errorMessage,
    severity,
    category,
    retryable,
    context: {
      timestamp: Date.now(),
      ...context,
      stackTrace: errorObj?.stack,
      originalError: error,
    },
    correlationId: context?.correlationId ?? generateCorrelationId(),
  } as ClassifiedError;

  if (errorObj?.stack) {
    Object.setPrototypeOf(classified, Error.prototype);
    classified.stack = errorObj.stack;
  }

  return classified;
}

export type RetryStrategy = 'exponential' | 'linear' | 'polynomial' | 'fixed' | 'custom';

export interface RetryStrategyConfig {
  readonly type: RetryStrategy;
  readonly initialDelay?: number;
  readonly maxDelay?: number;
  readonly multiplier?: number;
  readonly customDelay?: (attempt: number, error: unknown) => number;
}

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly initialDelay?: number;
  readonly maxDelay?: number;
  readonly backoffMultiplier?: number;
  readonly retryableErrors?: readonly string[];
  readonly onRetry?: (attempt: number, error: Error) => void;
  readonly strategy?: RetryStrategy | RetryStrategyConfig;
  readonly jitter?: boolean | number;
  readonly adaptive?: boolean;
  readonly budget?: RetryBudget;
  readonly cancellationToken?: CancellationToken;
  readonly errorSampling?: number;
}

export interface RetryBudget {
  readonly maxRetries: number;
  readonly windowMs: number;
  used: number;
  resetAt: number;
}

export interface CancellationToken {
  readonly cancelled: boolean;
  readonly cancel: () => void;
  readonly onCancel: (callback: () => void) => void;
}

export class RetryError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError: Error,
    public readonly classifiedError?: ClassifiedError,
  ) {
    super(message);
    this.name = 'RetryError';
  }
}

export function createCancellationToken(): CancellationToken {
  let cancelled = false;
  const callbacks: Array<() => void> = [];

  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      cancelled = true;
      callbacks.forEach((cb) => {
        try {
          cb();
        } catch {
        }
      });
    },
    onCancel(callback: () => void) {
      if (typeof callback !== 'function') {
        throw new Error('Invalid callback: must be a function');
      }
      if (cancelled) {
        callback();
      } else {
        callbacks.push(callback);
      }
    },
  };
}

function calculateRetryDelay(
  attempt: number,
  strategy: RetryStrategy | RetryStrategyConfig,
  initialDelay: number,
  maxDelay: number,
  error?: unknown,
  responseTime?: number,
): number {
  let config: RetryStrategyConfig;
  if (typeof strategy === 'string') {
    if (!isRetryStrategy(strategy)) {
      throw new Error(`Invalid retry strategy: ${strategy}`);
    }
    config = { type: strategy };
  } else {
    if (!isRetryStrategy(strategy.type)) {
      throw new Error(`Invalid retry strategy: ${strategy.type}`);
    }
    config = strategy;
  }

  let delay: number;

  switch (config.type) {
    case 'exponential':
      delay = initialDelay * Math.pow(config.multiplier || 2, attempt - 1);
      break;
    case 'linear':
      delay = initialDelay * attempt;
      break;
    case 'polynomial':
      delay = initialDelay * Math.pow(attempt, config.multiplier || 2);
      break;
    case 'fixed':
      delay = initialDelay;
      break;
    case 'custom':
      if (config.customDelay) {
        delay = config.customDelay(attempt, error);
        if (typeof delay !== 'number' || delay < 0) {
          throw new Error('Custom delay function must return a non-negative number');
        }
      } else {
        delay = initialDelay;
      }
      break;
    default:
      delay = initialDelay * Math.pow(2, attempt - 1);
  }

  if (error && responseTime !== undefined) {
    const classified = classifyError(error);
    if (classified.category === ErrorCategory.RATE_LIMIT) {
      delay *= 2;
    } else if (classified.category === ErrorCategory.TIMEOUT && responseTime > 5000) {
      delay *= 1.5;
    }
  }

  return Math.min(delay, maxDelay);
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  if (typeof fn !== 'function') {
    throw new Error('Invalid function: must be a function that returns a Promise');
  }

  validateRetryOptions(options);

  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    backoffMultiplier = 2,
    retryableErrors = [],
    onRetry,
    strategy = 'exponential',
    jitter = true,
    adaptive = false,
    budget,
    cancellationToken,
    errorSampling = 1,
  } = options;

  const correlationId = generateCorrelationId();
  const startTime = Date.now();

  if (budget) {
    if (Date.now() > budget.resetAt) {
      budget.used = 0;
      budget.resetAt = Date.now() + budget.windowMs;
    }
    if (budget.used >= budget.maxRetries) {
      structuredLog('warn', 'Retry', 'Retry budget exhausted', {
        correlationId,
        maxRetries: budget.maxRetries,
        used: budget.used,
      });
      throw new RetryError('Retry budget exhausted', 0, new Error('Budget exceeded'));
    }
  }

  if (Math.random() > errorSampling) {
    return fn();
  }

  let lastError: Error | undefined;
  let lastResponseTime: number | undefined;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (cancellationToken?.cancelled) {
      structuredLog('warn', 'Retry', 'Retry cancelled', {
        correlationId,
        attempt,
      });
      throw new RetryError('Retry cancelled', attempt - 1, lastError ?? new Error('No error'));
    }

    const attemptStartTime = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - startTime;
      if (budget) {
        budget.used = Math.max(0, budget.used - 1);
      }
      structuredLog('info', 'Retry', 'Retry succeeded', {
        correlationId,
        attempt,
        durationMs: duration,
      });
      return result;
    } catch (error: unknown) {
      lastError = error as Error;
      lastResponseTime = Date.now() - attemptStartTime;

      if (attempt >= maxAttempts) {
        break;
      }

      const classified = classifyError(error, {
        operation: 'retry',
        metadata: { attempt, maxAttempts },
        correlationId,
      });

      const isRetryable = isRetryableError(error, retryableErrors, classified);
      if (!isRetryable) {
        const duration = Date.now() - startTime;
        structuredLog('warn', 'Retry', 'Non-retryable error encountered', {
          correlationId,
          attempt,
          category: classified.category,
          durationMs: duration,
        });
        throw error;
      }

      if (budget) {
        budget.used++;
      }

      if (onRetry) {
        try {
          onRetry(attempt, error as Error);
        } catch (callbackError) {
          structuredLog('error', 'Retry', 'Retry callback error', {
            correlationId,
            attempt,
            error: callbackError instanceof Error ? callbackError.message : String(callbackError),
          });
        }
      }

      delay = calculateRetryDelay(
        attempt,
        strategy,
        initialDelay,
        maxDelay,
        error,
        lastResponseTime,
      );

      if (jitter) {
        const jitterAmount = typeof jitter === 'number' ? jitter : 1000;
        delay += Math.random() * jitterAmount;
      }

      structuredLog('warn', 'Retry', 'Retrying operation', {
        correlationId,
        attempt,
        maxAttempts,
        delayMs: delay,
        category: classified.category,
        responseTimeMs: lastResponseTime,
      });

      await sleep(delay);
    }
  }

  const duration = Date.now() - startTime;
  const classified = classifyError(lastError!, {
    operation: 'retry',
    metadata: { attempts: maxAttempts },
    correlationId,
  });

  structuredLog('error', 'Retry', 'Retry failed after all attempts', {
    correlationId,
    maxAttempts,
    category: classified.category,
    severity: classified.severity,
    durationMs: duration,
  });

  throw new RetryError(
    `Failed after ${maxAttempts} attempts`,
    maxAttempts,
    lastError!,
    classified,
  );
}

export function isRetryableError(
  error: unknown,
  retryableErrors: readonly string[],
  classified?: ClassifiedError,
): boolean {
  if (classified) {
    return classified.retryable;
  }

  const errorObj = error as { readonly code?: string; readonly response?: { readonly status?: number }; readonly message?: string };
  if (errorObj.code === 'ECONNRESET' || errorObj.code === 'ETIMEDOUT' || errorObj.code === 'ENOTFOUND') {
    return true;
  }

  const retryableStatusCodes: readonly number[] = [429, 500, 502, 503, 504] as const;
  if (errorObj.response?.status && retryableStatusCodes.includes(errorObj.response.status)) {
    return true;
  }

  if (errorObj.message?.includes('rate limit') || errorObj.message?.includes('Rate limit')) {
    return true;
  }

  if (retryableErrors.length > 0) {
    const errorMessage = errorObj.message?.toLowerCase() ?? '';
    return retryableErrors.some((pattern) => errorMessage.includes(pattern.toLowerCase()));
  }

  if (errorObj.response?.status !== undefined) {
    const status = errorObj.response.status;
    if (status >= 400 && status < 500 && status !== 429) {
      return false;
    }
    return status >= 500;
  }

  return true;
}

const DEFAULT_DELETE_DELAY = 100;
const MAX_CACHE_SIZE = 1000;

interface DeduplicationCacheEntry {
  readonly promise: Promise<unknown>;
  readonly expiresAt: number;
}

const deduplicationCaches = new Map<unknown, Map<string, DeduplicationCacheEntry>>();

const cleanupDeduplicationCache = (cache: Map<string, DeduplicationCacheEntry>): void => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt < now) {
      cache.delete(key);
    }
  }
  if (cache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(cache.entries());
    entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const toDelete = entries.slice(0, entries.length - MAX_CACHE_SIZE);
    for (const [key] of toDelete) {
      cache.delete(key);
    }
  }
};

export function withDeduplication<T extends (...args: readonly unknown[]) => Promise<unknown>>(
  fn: T,
): T {
  const requestCache = new Map<string, DeduplicationCacheEntry>();
  deduplicationCaches.set(fn, requestCache);

  return ((...args: readonly unknown[]) => {
    let cacheKey: string;
    try {
      cacheKey = JSON.stringify(args);
    } catch {
      cacheKey = String(args);
    }

    const now = Date.now();
    const cached = requestCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.promise as ReturnType<T>;
    }

    cleanupDeduplicationCache(requestCache);

    const promise = fn(...args) as Promise<unknown>;

    requestCache.set(cacheKey, {
      promise,
      expiresAt: now + DEFAULT_DELETE_DELAY,
    });

    promise.finally(() => {
      setTimeout(() => {
        requestCache.delete(cacheKey);
      }, DEFAULT_DELETE_DELAY);
    }).catch(() => {
    });

    return promise as ReturnType<T>;
  }) as T;
}
