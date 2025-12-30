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

export function classifyError(
  error: unknown,
  context?: Partial<ErrorContext>,
): ClassifiedError {
  const errorObj = error as ErrorObject;
  const errorMessage = errorObj?.message ?? String(error);
  const statusCode = errorObj?.response?.status ?? errorObj?.status;
  const errorCode = errorObj?.code;

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

function generateCorrelationId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
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
      callbacks.forEach((cb) => cb());
    },
    onCancel(callback: () => void) {
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
    config = { type: strategy };
  } else {
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
      delay = config.customDelay
        ? config.customDelay(attempt, error)
        : initialDelay;
      break;
    default:
      delay = initialDelay * Math.pow(2, attempt - 1);
  }

  if (error && responseTime) {
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

  if (budget) {
    if (Date.now() > budget.resetAt) {
      budget.used = 0;
      budget.resetAt = Date.now() + budget.windowMs;
    }
    if (budget.used >= budget.maxRetries) {
      throw new RetryError('Retry budget exhausted', 0, new Error('Budget exceeded'));
    }
  }

  if (Math.random() > errorSampling) {
    return fn();
  }

  let lastError: Error;
  let lastResponseTime: number | undefined;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (cancellationToken?.cancelled) {
      throw new RetryError('Retry cancelled', attempt - 1, lastError!);
    }

    const startTime = Date.now();
    try {
      const result = await fn();
      if (budget) {
        budget.used = Math.max(0, budget.used - 1);
      }
      return result;
    } catch (error: unknown) {
      lastError = error as Error;
      lastResponseTime = Date.now() - startTime;

      if (attempt >= maxAttempts) {
        break;
      }

      const classified = classifyError(error, {
        operation: 'retry',
        metadata: { attempt, maxAttempts },
      });

      const isRetryable = isRetryableError(error, retryableErrors, classified);
      if (!isRetryable) {
        throw error;
      }

      if (budget) {
        budget.used++;
      }

      if (onRetry) {
        onRetry(attempt, error as Error);
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

      await sleep(delay);
    }
  }

  const classified = classifyError(lastError!, {
    operation: 'retry',
    metadata: { attempts: maxAttempts },
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

  const retryableStatusCodes: readonly number[] = [429, 500, 502, 503, 504];
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

export function withDeduplication<T extends (...args: any[]) => Promise<any>>(
  fn: T,
): T {
  const requestCache = new Map<string, Promise<any>>();

  return ((...args: any[]) => {
    const cacheKey = JSON.stringify(args);

    if (requestCache.has(cacheKey)) {
      return requestCache.get(cacheKey)!;
    }

    const promise = fn(...args);

    requestCache.set(cacheKey, promise);

    promise.finally(() => {
      setTimeout(() => {
        requestCache.delete(cacheKey);
      }, DEFAULT_DELETE_DELAY);
    });

    return promise;
  }) as T;
}
