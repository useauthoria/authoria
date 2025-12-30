import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import {
  getSupabaseClient,
  createCompressedResponse,
  acceptsCompression,
  logger,
  checkRateLimit,
  executeRequestInterceptors,
  executeResponseInterceptors,
  executeErrorInterceptors,
  getPerformanceMetrics,
  getClientMetrics,
  getMemoryStats,
  UtilsError,
  SupabaseClientError,
} from '../_shared/utils.ts';

interface DenoEnv {
  readonly get?: (key: string) => string | undefined;
}

interface DenoGlobal {
  readonly Deno?: {
    readonly env?: DenoEnv;
  };
}

interface MaintenanceRequest extends Request {
  readonly correlationId?: string;
  readonly startTime?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface MaintenanceResponse {
  readonly data?: unknown;
  readonly error?: string;
  readonly correlationId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface RequestContext {
  readonly req: MaintenanceRequest;
  readonly supabase: ReturnType<typeof getSupabaseClient>;
  readonly correlationId: string;
  readonly startTime: number;
}

interface WarmUpResult {
  readonly endpoint: string;
  readonly status: number;
  readonly success: boolean;
  readonly duration: number;
  readonly error?: string;
  readonly timestamp: string;
}

interface CacheRefreshResult {
  readonly viewName?: string;
  readonly success: boolean;
  readonly duration: number;
  readonly error?: string;
  readonly timestamp: string;
}

interface EndpointConfig {
  readonly requiresAuth?: boolean;
  readonly rateLimit?: { readonly maxRequests: number; readonly windowMs: number };
  readonly compression?: boolean;
  readonly timeout?: number;
}

interface AuthResult {
  readonly valid: boolean;
  readonly error?: string;
}

interface WarmUpSummary {
  readonly success: boolean;
  readonly warmed: number;
  readonly total: number;
  readonly failed: number;
  readonly results: ReadonlyArray<WarmUpResult>;
  readonly summary: {
    readonly totalDuration: number;
    readonly avgDuration: number;
    readonly successRate: number;
  };
  readonly timestamp: string;
}

interface CacheRefreshSummary {
  readonly success: boolean;
  readonly message: string;
  readonly results: ReadonlyArray<CacheRefreshResult>;
  readonly summary: {
    readonly total: number;
    readonly successful: number;
    readonly failed: number;
    readonly totalDuration: number;
  };
  readonly timestamp: string;
}

interface EndpointCheck {
  readonly endpoint: string;
  readonly available: boolean;
  readonly status: number;
}

interface HealthStatus {
  readonly status: string;
  readonly database: string;
  readonly timestamp: string;
  readonly performance: {
    readonly metricsCount: number;
    readonly recentMetrics: ReadonlyArray<unknown>;
  };
  readonly memory: unknown;
  readonly client: unknown;
  readonly endpoints: {
    readonly configured: number;
    readonly checks: ReadonlyArray<EndpointCheck>;
  };
}

interface RouteConfig {
  readonly handler: (ctx: RequestContext) => Promise<Response>;
  readonly config: EndpointConfig;
}

const ENV_SUPABASE_URL = 'SUPABASE_URL';
const ENV_SUPABASE_ANON_KEY = 'SUPABASE_ANON_KEY';
const ENV_SUPABASE_SERVICE_ROLE_KEY = 'SUPABASE_SERVICE_ROLE_KEY';
const ENV_ADMIN_API_KEY = 'ADMIN_API_KEY';
const ENV_MAINTENANCE_TIMEOUT = 'MAINTENANCE_TIMEOUT';
const ENV_CORS_ORIGINS = 'CORS_ORIGINS';
const ENV_WARM_UP_TIMEOUT = 'WARM_UP_TIMEOUT';
const ENV_WARM_UP_ENDPOINTS = 'WARM_UP_ENDPOINTS';
const ENV_ENABLE_PARALLEL_WARM_UP = 'ENABLE_PARALLEL_WARM_UP';
const ENV_MAX_RETRIES = 'MAX_RETRIES';
const ENV_RETRY_DELAY_MS = 'RETRY_DELAY_MS';
const ENV_CACHE_REFRESH_TIMEOUT = 'CACHE_REFRESH_TIMEOUT';
const DEFAULT_TIMEOUT = 60000;
const DEFAULT_WARM_UP_TIMEOUT = 30000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_CACHE_REFRESH_TIMEOUT = 300000;
const DEFAULT_WARM_UP_ENDPOINTS = '/functions/v1/create-post,/functions/v1/admin-api,/functions/v1/api-router';
const MIN_TOKEN_LENGTH = 20;
const BEARER_PREFIX = 'Bearer ';
const BEARER_PREFIX_LENGTH = 7;
const ID_RADIX = 36;
const ID_LENGTH = 9;
const CORRELATION_PREFIX = 'maintenance-';
const METHOD_GET = 'GET';
const METHOD_POST = 'POST';
const METHOD_OPTIONS = 'OPTIONS';
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_REQUEST_TIMEOUT = 408;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_INTERNAL_ERROR = 500;
const HEADER_AUTHORIZATION = 'Authorization';
const HEADER_X_CORRELATION_ID = 'x-correlation-id';
const HEADER_X_RESPONSE_TIME = 'x-response-time';
const HEADER_CONTENT_TYPE = 'Content-Type';
const HEADER_CONTENT_TYPE_JSON = 'application/json';
const HEADER_ACCESS_CONTROL_ALLOW_ORIGIN = 'Access-Control-Allow-Origin';
const HEADER_ACCESS_CONTROL_ALLOW_HEADERS = 'Access-Control-Allow-Headers';
const HEADER_ACCESS_CONTROL_ALLOW_METHODS = 'Access-Control-Allow-Methods';
const HEADER_ACCESS_CONTROL_MAX_AGE = 'Access-Control-Max-Age';
const CORS_HEADERS_VALUE = 'authorization, x-client-info, apikey, content-type, x-correlation-id, x-request-id';
const CORS_METHODS_VALUE = 'POST, GET, OPTIONS';
const CORS_MAX_AGE_VALUE = '86400';
const ENCODING_NONE = 'none';
const ERROR_UNAUTHORIZED = 'Unauthorized';
const ERROR_MISSING_ENV = 'Missing environment variables';
const ERROR_MISSING_AUTHORIZATION = 'Missing authorization header';
const ERROR_INVALID_AUTHORIZATION = 'Invalid authorization';
const ERROR_RATE_LIMIT_EXCEEDED = 'Rate limit exceeded';
const ERROR_REQUEST_TIMEOUT = 'Request timeout';
const ERROR_INTERNAL_SERVER = 'Internal server error';
const ERROR_NOT_FOUND = 'Not Found';
const ERROR_SUPABASE_URL_NOT_CONFIGURED = 'SUPABASE_URL not configured';
const ERROR_WARM_UP_TIMEOUT = 'Warm-up timeout';
const ERROR_CODE_UNAUTHORIZED = 'UNAUTHORIZED';
const ERROR_CODE_CONFIG_ERROR = 'CONFIG_ERROR';
const ERROR_CODE_TIMEOUT = 'TIMEOUT';
const ERROR_CODE_INTERNAL_ERROR = 'INTERNAL_ERROR';
const RETRY_BACKOFF_BASE = 2;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_WARM_UP_MAX = 10;
const RATE_LIMIT_CACHE_REFRESH_MAX = 5;
const RATE_LIMIT_HEALTH_MAX = 100;
const HEALTH_CHECK_TIMEOUT_MS = 5000;
const TABLE_STORES = 'stores';
const COLUMN_ID = 'id';
const RPC_REFRESH_MATERIALIZED_VIEW = 'refresh_materialized_view';
const RPC_REFRESH_MATERIALIZED_VIEWS = 'refresh_materialized_views';
const PARAM_VIEW_NAME = 'view_name';
const QUERY_PARAM_ENDPOINTS = 'endpoints';
const QUERY_PARAM_PARALLEL = 'parallel';
const QUERY_PARAM_VIEW = 'view';
const PATH_WARM_UP = 'warm-up';
const PATH_REFRESH_CACHE = 'refresh-cache';
const PATH_HEALTH = 'health';
const PATH_ROOT = '/';
const HEALTH_STATUS_HEALTHY = 'healthy';
const HEALTH_STATUS_ERROR = 'error';
const UNKNOWN_ENDPOINT = 'unknown';
const UNKNOWN_ERROR = 'Unknown error';

function getEnv(key: string, defaultValue = ''): string {
  try {
    const deno = (globalThis as DenoGlobal).Deno;
    return deno?.env?.get?.(key) ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

const CONFIG = {
  SUPABASE_URL: getEnv(ENV_SUPABASE_URL, ''),
  SUPABASE_ANON_KEY: getEnv(ENV_SUPABASE_ANON_KEY, ''),
  SUPABASE_SERVICE_ROLE_KEY: getEnv(ENV_SUPABASE_SERVICE_ROLE_KEY, ''),
  ADMIN_API_KEY: getEnv(ENV_ADMIN_API_KEY, ''),
  DEFAULT_TIMEOUT: parseInt(getEnv(ENV_MAINTENANCE_TIMEOUT, String(DEFAULT_TIMEOUT))),
  ENABLE_AUDIT_LOGGING: true,
  ENABLE_METRICS: true,
  CORS_ORIGINS: getEnv(ENV_CORS_ORIGINS, '*').split(','),
  WARM_UP_TIMEOUT: parseInt(getEnv(ENV_WARM_UP_TIMEOUT, String(DEFAULT_WARM_UP_TIMEOUT))),
  WARM_UP_ENDPOINTS: getEnv(ENV_WARM_UP_ENDPOINTS, DEFAULT_WARM_UP_ENDPOINTS).split(','),
  ENABLE_PARALLEL_WARM_UP: getEnv(ENV_ENABLE_PARALLEL_WARM_UP, 'true') !== 'false',
  MAX_RETRIES: parseInt(getEnv(ENV_MAX_RETRIES, String(DEFAULT_MAX_RETRIES))),
  RETRY_DELAY_MS: parseInt(getEnv(ENV_RETRY_DELAY_MS, String(DEFAULT_RETRY_DELAY_MS))),
  CACHE_REFRESH_TIMEOUT: parseInt(getEnv(ENV_CACHE_REFRESH_TIMEOUT, String(DEFAULT_CACHE_REFRESH_TIMEOUT))),
};

const corsHeaders: Readonly<Record<string, string>> = {
  [HEADER_ACCESS_CONTROL_ALLOW_ORIGIN]: CONFIG.CORS_ORIGINS[0] === '*' ? '*' : CONFIG.CORS_ORIGINS.join(','),
  [HEADER_ACCESS_CONTROL_ALLOW_HEADERS]: CORS_HEADERS_VALUE,
  [HEADER_ACCESS_CONTROL_ALLOW_METHODS]: CORS_METHODS_VALUE,
  [HEADER_ACCESS_CONTROL_MAX_AGE]: CORS_MAX_AGE_VALUE,
};

async function validateAuth(authHeader: string | null, requiresAuth = false): Promise<AuthResult> {
  if (!requiresAuth) {
    return { valid: true };
  }

  if (!authHeader) {
    return { valid: false, error: ERROR_MISSING_AUTHORIZATION };
  }

  if (CONFIG.ADMIN_API_KEY && authHeader.includes(CONFIG.ADMIN_API_KEY)) {
    return { valid: true };
  }

  if (authHeader.startsWith(BEARER_PREFIX)) {
    const token = authHeader.substring(BEARER_PREFIX_LENGTH);
    if (token === CONFIG.SUPABASE_SERVICE_ROLE_KEY || token.length > MIN_TOKEN_LENGTH) {
      return { valid: true };
    }
  }

  return { valid: false, error: ERROR_INVALID_AUTHORIZATION };
}

function generateCorrelationId(): string {
  return `${CORRELATION_PREFIX}${Date.now()}-${Math.random().toString(ID_RADIX).substring(2, 2 + ID_LENGTH)}`;
}

async function createRequestContext(req: Request, requiresAuth = false): Promise<RequestContext> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  const authHeader = req.headers.get(HEADER_AUTHORIZATION);
  const authResult = await validateAuth(authHeader, requiresAuth);

  if (!authResult.valid) {
    throw new UtilsError(authResult.error ?? ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED, STATUS_UNAUTHORIZED);
  }

  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_SERVICE_ROLE_KEY) {
    throw new UtilsError(ERROR_MISSING_ENV, ERROR_CODE_CONFIG_ERROR, STATUS_INTERNAL_ERROR);
  }

  const supabase = await getSupabaseClient({ clientType: 'service' });

  return {
    req: req as MaintenanceRequest,
    supabase,
    correlationId,
    startTime: performance.now(),
  };
}

async function handleRequest(
  req: Request,
  handler: (ctx: RequestContext) => Promise<Response>,
  config: EndpointConfig = {},
): Promise<Response> {
  const startTime = performance.now();
  let correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();

  try {
    const processedReq = await executeRequestInterceptors(req);

    const ctx = await createRequestContext(processedReq, config.requiresAuth);
    correlationId = ctx.correlationId;

    if (config.rateLimit) {
      const rateLimitKey = `maintenance:${new URL(req.url).pathname}`;
      const rateLimit = checkRateLimit(rateLimitKey, config.rateLimit.maxRequests, config.rateLimit.windowMs);

      if (!rateLimit.allowed) {
        logger.warn('Rate limit exceeded', { correlationId, rateLimitKey, remaining: rateLimit.remaining });
        return createErrorResponse(ERROR_RATE_LIMIT_EXCEEDED, STATUS_TOO_MANY_REQUESTS, correlationId, {
          retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
        });
      }
    }


    const timeout = config.timeout ?? CONFIG.DEFAULT_TIMEOUT;
    const timeoutPromise = new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(createErrorResponse(ERROR_REQUEST_TIMEOUT, STATUS_REQUEST_TIMEOUT, correlationId));
      }, timeout);
    });

    const handlerPromise = handler(ctx);
    const response = await Promise.race([handlerPromise, timeoutPromise]);

    const processedResponse = await executeResponseInterceptors(response);

    const headers = new Headers(processedResponse.headers);
    headers.set(HEADER_X_CORRELATION_ID, correlationId);
    headers.set(HEADER_X_RESPONSE_TIME, `${(performance.now() - startTime).toFixed(2)}ms`);

    if (CONFIG.ENABLE_METRICS) {
      logger.info('Request completed', {
        correlationId,
        method: req.method,
        path: new URL(req.url).pathname,
        status: processedResponse.status,
        duration: performance.now() - startTime,
      });
    }

    return new Response(processedResponse.body, {
      status: processedResponse.status,
      statusText: processedResponse.statusText,
      headers,
    });
  } catch (error) {
    const errorResponse = await executeErrorInterceptors(error as Error, req);
    if (errorResponse) {
      return errorResponse;
    }

    logger.error('Request failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_INTERNAL_SERVER,
      error instanceof UtilsError ? error.statusCode : STATUS_INTERNAL_ERROR,
      correlationId,
      { errorCode: error instanceof UtilsError ? error.code : ERROR_CODE_INTERNAL_ERROR },
    );
  }
}

async function createSuccessResponse(
  data: unknown,
  correlationId: string,
  metadata?: Readonly<Record<string, unknown>>,
  options: { readonly compression?: boolean; readonly request?: Request } = {},
): Promise<Response> {
  const response: MaintenanceResponse = {
    data,
    correlationId,
    ...(metadata && { metadata }),
  };

  if (options.compression !== false && options.request) {
    const compression = acceptsCompression(options.request);
    if (compression !== ENCODING_NONE) {
      return createCompressedResponse(response, {
        encoding: compression,
        headers: corsHeaders,
      });
    }
  }

  return new Response(JSON.stringify(response), {
    status: STATUS_OK,
    headers: {
      ...corsHeaders,
      [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON,
      [HEADER_X_CORRELATION_ID]: correlationId,
    },
  });
}

function createErrorResponse(
  error: string,
  status: number,
  correlationId: string,
  metadata?: Readonly<Record<string, unknown>>,
): Response {
  const response: MaintenanceResponse = {
    error,
    correlationId,
    ...(metadata && { metadata }),
  };

  return new Response(JSON.stringify(response), {
    status,
    headers: {
      ...corsHeaders,
      [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON,
      [HEADER_X_CORRELATION_ID]: correlationId,
    },
  });
}

async function retryOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number = CONFIG.MAX_RETRIES,
  delayMs: number = CONFIG.RETRY_DELAY_MS,
  operationName?: string,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        const backoffDelay = delayMs * Math.pow(RETRY_BACKOFF_BASE, attempt);
        logger.debug('Retrying operation', {
          operationName,
          attempt: attempt + 1,
          maxRetries,
          backoffDelay,
          error: lastError.message,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
      }
    }
  }

  throw lastError ?? new Error(`Operation ${operationName ?? 'unknown'} failed after retries`);
}

async function handleWarmUp(ctx: RequestContext): Promise<Response> {
  const { correlationId } = ctx;
  const url = new URL(ctx.req.url);
  const endpointsParam = url.searchParams.get(QUERY_PARAM_ENDPOINTS);
  const enableParallel = url.searchParams.get(QUERY_PARAM_PARALLEL) !== 'false' && CONFIG.ENABLE_PARALLEL_WARM_UP;

  const endpoints = endpointsParam ? endpointsParam.split(',') : CONFIG.WARM_UP_ENDPOINTS;

  if (!CONFIG.SUPABASE_URL) {
    throw new UtilsError(ERROR_SUPABASE_URL_NOT_CONFIGURED, ERROR_CODE_CONFIG_ERROR, STATUS_INTERNAL_ERROR);
  }

  const results: WarmUpResult[] = [];

  if (enableParallel && endpoints.length > 1) {
    const warmUpPromises = endpoints.map(async (endpoint): Promise<WarmUpResult> => {
      const startTime = performance.now();
      try {
        const endpointUrl = `${CONFIG.SUPABASE_URL}${endpoint}`;
        const timeoutPromise = new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new UtilsError(ERROR_WARM_UP_TIMEOUT, ERROR_CODE_TIMEOUT, STATUS_REQUEST_TIMEOUT)), CONFIG.WARM_UP_TIMEOUT);
        });

        const response = await Promise.race([
          fetch(endpointUrl, {
            method: METHOD_GET,
            headers: {
              [HEADER_AUTHORIZATION]: `${BEARER_PREFIX}${CONFIG.SUPABASE_ANON_KEY ?? ''}`,
            },
          }),
          timeoutPromise,
        ]);

        const duration = performance.now() - startTime;
        return {
          endpoint,
          status: response.status,
          success: response.ok,
          duration,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        const duration = performance.now() - startTime;
        return {
          endpoint,
          status: 0,
          success: false,
          duration,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        };
      }
    });

    const parallelResults = await Promise.allSettled(warmUpPromises);
    results.push(
      ...parallelResults.map((result) =>
        result.status === 'fulfilled' ? result.value : {
          endpoint: UNKNOWN_ENDPOINT,
          status: 0,
          success: false,
          duration: 0,
          error: result.reason?.message ?? UNKNOWN_ERROR,
          timestamp: new Date().toISOString(),
        },
      ),
    );
  } else {
    for (const endpoint of endpoints) {
      const startTime = performance.now();
      try {
        const endpointUrl = `${CONFIG.SUPABASE_URL}${endpoint}`;
        const timeoutPromise = new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new UtilsError(ERROR_WARM_UP_TIMEOUT, ERROR_CODE_TIMEOUT, STATUS_REQUEST_TIMEOUT)), CONFIG.WARM_UP_TIMEOUT);
        });

        const response = await Promise.race([
          fetch(endpointUrl, {
            method: METHOD_GET,
            headers: {
              [HEADER_AUTHORIZATION]: `${BEARER_PREFIX}${CONFIG.SUPABASE_ANON_KEY ?? ''}`,
            },
          }),
          timeoutPromise,
        ]);

        const duration = performance.now() - startTime;
        results.push({
          endpoint,
          status: response.status,
          success: response.ok,
          duration,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        const duration = performance.now() - startTime;
        results.push({
          endpoint,
          status: 0,
          success: false,
          duration,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  const avgDuration = results.length > 0 ? totalDuration / results.length : 0;

  if (CONFIG.ENABLE_AUDIT_LOGGING) {
    logger.info('Warm-up completed', {
      correlationId,
      total: results.length,
      successful,
      failed,
      totalDuration,
      avgDuration,
      parallel: enableParallel,
    });
  }

  const summary: WarmUpSummary = {
    success: true,
    warmed: successful,
    total: results.length,
    failed,
    results,
    summary: {
      totalDuration,
      avgDuration,
      successRate: results.length > 0 ? (successful / results.length) * 100 : 0,
    },
    timestamp: new Date().toISOString(),
  };

  return createSuccessResponse(
    summary,
    correlationId,
    { parallel: enableParallel },
    { compression: true, request: ctx.req },
  );
}

async function handleRefreshCache(ctx: RequestContext): Promise<Response> {
  const { supabase, correlationId } = ctx;
  const url = new URL(ctx.req.url);
  const viewName = url.searchParams.get(QUERY_PARAM_VIEW);

  const startTime = performance.now();
  const results: CacheRefreshResult[] = [];

  try {
    if (viewName) {
      const viewStartTime = performance.now();
      try {
        const { error } = await retryOperation(
          async () => {
            const result = await supabase.rpc(RPC_REFRESH_MATERIALIZED_VIEW, { [PARAM_VIEW_NAME]: viewName });
            if (result.error) {
              throw new SupabaseClientError('Failed to refresh view', result.error);
            }
            return result;
          },
          CONFIG.MAX_RETRIES,
          CONFIG.RETRY_DELAY_MS,
          `refresh_view_${viewName}`,
        );

        const duration = performance.now() - viewStartTime;
        results.push({
          viewName,
          success: !error,
          duration,
          timestamp: new Date().toISOString(),
          ...(error && { error: error.message }),
        });
      } catch (error) {
        const duration = performance.now() - viewStartTime;
        results.push({
          viewName,
          success: false,
          duration,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      }
    } else {
      const { error } = await retryOperation(
        async () => {
          const result = await supabase.rpc(RPC_REFRESH_MATERIALIZED_VIEWS);
          if (result.error) {
            throw new SupabaseClientError('Failed to refresh materialized views', result.error);
          }
          return result;
        },
        CONFIG.MAX_RETRIES,
        CONFIG.RETRY_DELAY_MS,
        'refresh_all_views',
      );

      const duration = performance.now() - startTime;
      results.push({
        success: !error,
        duration,
        timestamp: new Date().toISOString(),
        ...(error && { error: error.message }),
      });
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

    if (CONFIG.ENABLE_AUDIT_LOGGING) {
      logger.info('Cache refresh completed', {
        correlationId,
        viewName: viewName ?? 'all',
        total: results.length,
        successful,
        failed,
        totalDuration,
      });
    }

    const summary: CacheRefreshSummary = {
      success: true,
      message: viewName ? `Materialized view ${viewName} refreshed` : 'All materialized views refreshed',
      results,
      summary: {
        total: results.length,
        successful,
        failed,
        totalDuration,
      },
      timestamp: new Date().toISOString(),
    };

    return createSuccessResponse(
      summary,
      correlationId,
      {},
      { compression: true, request: ctx.req },
    );
  } catch (error) {
    const duration = performance.now() - startTime;
    logger.error('Cache refresh failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      duration,
    });

    results.push({
      success: false,
      duration,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    const summary: CacheRefreshSummary = {
      success: false,
      message: 'Cache refresh failed',
      results,
      summary: {
        total: results.length,
        successful: 0,
        failed: results.length,
        totalDuration: duration,
      },
      timestamp: new Date().toISOString(),
    };

    return createSuccessResponse(
      summary,
      correlationId,
      {},
      { compression: true, request: ctx.req },
    );
  }
}

async function handleHealth(ctx: RequestContext): Promise<Response> {
  const { supabase, correlationId } = ctx;

  const [dbCheck, metricsResult, memoryStats, clientMetrics] = await Promise.all([
    supabase.from(TABLE_STORES).select(COLUMN_ID).limit(1),
    Promise.resolve(getPerformanceMetrics()),
    Promise.resolve(getMemoryStats()),
    Promise.resolve(getClientMetrics()),
  ]);

  const endpointChecks = await Promise.allSettled(
    CONFIG.WARM_UP_ENDPOINTS.map(async (endpoint): Promise<EndpointCheck> => {
      try {
        const endpointUrl = `${CONFIG.SUPABASE_URL}${endpoint}`;
        const response = await fetch(endpointUrl, {
          method: METHOD_GET,
          headers: {
            [HEADER_AUTHORIZATION]: `${BEARER_PREFIX}${CONFIG.SUPABASE_ANON_KEY ?? ''}`,
          },
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        });
        return {
          endpoint,
          available: response.ok,
          status: response.status,
        };
      } catch {
        return {
          endpoint,
          available: false,
          status: 0,
        };
      }
    }),
  );

  const health: HealthStatus = {
    status: HEALTH_STATUS_HEALTHY,
    database: dbCheck.error ? HEALTH_STATUS_ERROR : HEALTH_STATUS_HEALTHY,
    timestamp: new Date().toISOString(),
    performance: {
      metricsCount: metricsResult.length,
      recentMetrics: metricsResult.slice(-10),
    },
    memory: memoryStats,
    client: clientMetrics,
    endpoints: {
      configured: CONFIG.WARM_UP_ENDPOINTS.length,
      checks: endpointChecks.map((check) =>
        check.status === 'fulfilled' ? check.value : { endpoint: UNKNOWN_ENDPOINT, available: false, status: 0 },
      ),
    },
  };

  return createSuccessResponse(health, correlationId, {}, { compression: true, request: ctx.req });
}

async function routeRequest(ctx: RequestContext): Promise<Response> {
  const url = new URL(ctx.req.url);
  const path = url.pathname.replace('/maintenance-api', '').replace(/^\/+/, '') || PATH_ROOT;
  const method = ctx.req.method;

  const routes: Readonly<Record<string, RouteConfig>> = {
    [`${METHOD_POST} /${PATH_WARM_UP}`]: {
      handler: handleWarmUp,
      config: {
        requiresAuth: true,
        compression: true,
        rateLimit: { maxRequests: RATE_LIMIT_WARM_UP_MAX, windowMs: RATE_LIMIT_WINDOW_MS },
        timeout: CONFIG.DEFAULT_TIMEOUT,
      },
    },
    [`${METHOD_POST} /${PATH_REFRESH_CACHE}`]: {
      handler: handleRefreshCache,
      config: {
        requiresAuth: true,
        compression: true,
        rateLimit: { maxRequests: RATE_LIMIT_CACHE_REFRESH_MAX, windowMs: RATE_LIMIT_WINDOW_MS },
        timeout: CONFIG.CACHE_REFRESH_TIMEOUT,
      },
    },
    [`${METHOD_GET} /${PATH_HEALTH}`]: {
      handler: handleHealth,
      config: {
        requiresAuth: false,
        compression: true,
        rateLimit: { maxRequests: RATE_LIMIT_HEALTH_MAX, windowMs: RATE_LIMIT_WINDOW_MS },
      },
    },
  };

  const routeKey = `${method} /${path}`;
  const matchedRoute = routes[routeKey];

  if (!matchedRoute) {
    return createErrorResponse(ERROR_NOT_FOUND, STATUS_NOT_FOUND, ctx.correlationId);
  }

  return handleRequest(ctx.req, matchedRoute.handler, matchedRoute.config);
}

serve(async (req: Request) => {
  if (req.method === METHOD_OPTIONS) {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace('/maintenance-api', '').replace(/^\/+/, '') || PATH_ROOT;
    const method = req.method;

    const requiresAuth = (path === PATH_WARM_UP || path === PATH_REFRESH_CACHE) && method === METHOD_POST;
    const ctx = await createRequestContext(req, requiresAuth);

    return await routeRequest(ctx);
  } catch (error) {
    const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
    logger.error('Request failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_INTERNAL_SERVER,
      error instanceof UtilsError ? error.statusCode : STATUS_INTERNAL_ERROR,
      correlationId,
      { errorCode: error instanceof UtilsError ? error.code : ERROR_CODE_INTERNAL_ERROR },
    );
  }
});
