import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import {
  getSupabaseClient,
  createAuthenticatedClient,
  createCompressedResponse,
  acceptsCompression,
  logger,
  checkRateLimit,
  executeRequestInterceptors,
  executeResponseInterceptors,
  executeErrorInterceptors,
  UtilsError,
  SupabaseClientError,
  validateAuthHeader,
  createCORSHeaders,
} from '../_shared/utils.ts';
// AnalyticsCollector removed - using inline implementation for Deno compatibility

interface DenoEnv {
  readonly get?: (key: string) => string | undefined;
}

interface DenoGlobal {
  readonly Deno?: {
    readonly env?: DenoEnv;
  };
}

interface APIRequest extends Request {
  readonly correlationId?: string;
  readonly userId?: string;
  readonly storeId?: string;
  readonly startTime?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface APIResponse {
  readonly data?: unknown;
  readonly error?: string;
  readonly correlationId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly pagination?: {
    readonly page: number;
    readonly limit: number;
    readonly total: number;
    readonly totalPages: number;
  };
}

interface RequestContext {
  readonly req: APIRequest;
  readonly supabase: ReturnType<typeof getSupabaseClient>;
  readonly correlationId: string;
  readonly userId?: string;
  readonly storeId?: string;
  readonly startTime: number;
}

interface EndpointConfig {
  readonly requiresAuth?: boolean;
  readonly rateLimit?: { readonly maxRequests: number; readonly windowMs: number };
  readonly cache?: { readonly ttl: number; readonly key?: string };
  readonly compression?: boolean;
  readonly timeout?: number;
  readonly validateInput?: (params: Readonly<Record<string, unknown>>) => { readonly valid: boolean; readonly error?: string };
  readonly maxRequestSize?: number;
}

interface PaginationParams {
  readonly page?: number;
  readonly limit?: number;
  readonly offset?: number;
}

interface CacheEntry {
  readonly data: unknown;
  readonly timestamp: number;
  readonly ttl: number;
}

interface AuthResult {
  readonly valid: boolean;
  readonly userId?: string;
  readonly error?: string;
}

interface PaginationResult {
  readonly valid: boolean;
  readonly page: number;
  readonly limit: number;
  readonly offset: number;
  readonly error?: string;
}

interface StoreValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

interface DateRangeResult {
  readonly valid: boolean;
  readonly start?: Date;
  readonly end?: Date;
  readonly error?: string;
}

interface StatusValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

interface RouteHandler {
  readonly handler: (ctx: RequestContext) => Promise<Response>;
  readonly config: EndpointConfig;
}

interface QuotaBody {
  readonly storeId?: string;
}

interface PostParams {
  readonly storeId?: string;
  readonly status?: string;
  readonly page?: string;
  readonly limit?: string;
}

interface AnalyticsParams {
  readonly storeId?: string;
  readonly start?: string;
  readonly end?: string;
}

interface ValidationParams {
  readonly storeId?: string;
  readonly status?: string;
  readonly start?: string;
  readonly end?: string;
  readonly body?: QuotaBody;
}

interface TrackingEventData {
  readonly scrollDepth?: number;
  readonly timeOnPage?: number;
  readonly element?: string;
  readonly conversionType?: string;
  readonly conversionValue?: number;
  readonly [key: string]: unknown;
}

interface TrackingEvent {
  readonly type: 'pageview' | 'scroll' | 'click' | 'time' | 'exit' | 'conversion';
  readonly postId?: string;
  readonly storeId: string;
  readonly timestamp?: number;
  readonly data?: TrackingEventData;
}

interface TrackRequestBody {
  readonly events: ReadonlyArray<TrackingEvent>;
}

interface EventToRecord {
  readonly storeId: string;
  readonly postId: string | null;
  readonly eventType: 'pageview' | 'scroll' | 'click' | 'time' | 'exit' | 'conversion';
  readonly eventData: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface EventValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

const ENV_SUPABASE_URL = 'SUPABASE_URL';
const ENV_SUPABASE_ANON_KEY = 'SUPABASE_ANON_KEY';
const ENV_SUPABASE_SERVICE_ROLE_KEY = 'SUPABASE_SERVICE_ROLE_KEY';
const ENV_OPENAI_API_KEY = 'OPENAI_API_KEY';
const ENV_ENABLE_CACHING = 'ENABLE_CACHING';
const ENV_CORS_ORIGINS = 'CORS_ORIGINS';
const ENV_MAX_REQUEST_SIZE = 'MAX_REQUEST_SIZE';
const ENV_MAX_BATCH_SIZE = 'MAX_BATCH_SIZE';
const ENV_ENABLE_RETRY = 'ENABLE_RETRY';
const ENV_MAX_RETRIES = 'MAX_RETRIES';
const ENV_RETRY_DELAY_MS = 'RETRY_DELAY_MS';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MAX_REQUEST_SIZE = 1048576;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_CACHE_SIZE = 500;
const CACHE_CLEANUP_BUFFER = 50;
const ID_RADIX = 36;
const ID_LENGTH = 9;
const CORRELATION_PREFIX = 'api-';
const BEARER_PREFIX = 'Bearer ';
const BEARER_PREFIX_LENGTH = 7;
const MIN_TOKEN_LENGTH = 10;
const METHOD_GET = 'GET';
const METHOD_POST = 'POST';
const METHOD_OPTIONS = 'OPTIONS';
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_REQUEST_TIMEOUT = 408;
const STATUS_PAYLOAD_TOO_LARGE = 413;
const STATUS_NOT_FOUND = 404;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_INTERNAL_ERROR = 500;
const HEADER_AUTHORIZATION = 'Authorization';
const HEADER_X_CORRELATION_ID = 'x-correlation-id';
const HEADER_X_RESPONSE_TIME = 'x-response-time';
const HEADER_CONTENT_LENGTH = 'content-length';
const HEADER_CONTENT_TYPE = 'Content-Type';
const HEADER_CONTENT_TYPE_JSON = 'application/json';
const HEADER_ACCESS_CONTROL_ALLOW_ORIGIN = 'Access-Control-Allow-Origin';
const HEADER_ACCESS_CONTROL_ALLOW_HEADERS = 'Access-Control-Allow-Headers';
const HEADER_ACCESS_CONTROL_ALLOW_METHODS = 'Access-Control-Allow-Methods';
const HEADER_ACCESS_CONTROL_MAX_AGE = 'Access-Control-Max-Age';
const CORS_HEADERS_VALUE = 'authorization, x-client-info, apikey, content-type, x-correlation-id, x-request-id';
const CORS_METHODS_VALUE = 'GET, POST, OPTIONS';
const CORS_MAX_AGE_VALUE = '86400';
const ENCODING_NONE = 'none';
const PATH_SEPARATOR = '/';
const QUERY_SEPARATOR = '?';
const PARAM_SEPARATOR = '&';
const PARAM_EQUALS = '=';
const STORE_ID_SEPARATOR = ':';
const ANONYMOUS_USER = 'anonymous';
const NO_STORE = 'no-store';
const AUTHENTICATED_USER = 'authenticated';
const ERROR_UNAUTHORIZED = 'Unauthorized';
const ERROR_MISSING_ENV = 'Missing environment variables';
const ERROR_MISSING_AUTHORIZATION = 'Missing authorization header';
const ERROR_INVALID_AUTHORIZATION = 'Invalid authorization';
const ERROR_REQUEST_TOO_LARGE = 'Request too large';
const ERROR_RATE_LIMIT_EXCEEDED = 'Rate limit exceeded';
const ERROR_REQUEST_TIMEOUT = 'Request timeout';
const ERROR_INVALID_INPUT = 'Invalid input';
const ERROR_NOT_FOUND = 'Not Found';
const ERROR_INTERNAL_SERVER = 'Internal server error';
const ERROR_STORE_ID_REQUIRED = 'storeId is required';
const ERROR_INVALID_STORE_ID = 'Invalid storeId format';
const ERROR_INVALID_START_DATE = 'Invalid start date format';
const ERROR_INVALID_END_DATE = 'Invalid end date format';
const ERROR_DATE_RANGE = 'Start date must be before end date';
const ERROR_INVALID_STATUS = 'Invalid status';
const ERROR_CODE_UNAUTHORIZED = 'UNAUTHORIZED';
const ERROR_CODE_CONFIG_ERROR = 'CONFIG_ERROR';
const ERROR_CODE_INTERNAL_ERROR = 'INTERNAL_ERROR';
const RPC_GET_STORE_QUOTA_STATUS = 'get_store_quota_status';
const PARAM_STORE_UUID = 'store_uuid';
const PARAM_STORE_ID = 'storeId';
const PARAM_STATUS = 'status';
const PARAM_PAGE = 'page';
const PARAM_LIMIT = 'limit';
const PARAM_START = 'start';
const PARAM_END = 'end';
const TABLE_STORES = 'stores';
const TABLE_BLOG_POSTS = 'blog_posts';
const TABLE_PERFORMANCE_METRICS = 'performance_metrics';
const COLUMN_ID = 'id';
const COLUMN_STORE_ID = 'store_id';
const COLUMN_SHOP_DOMAIN = 'shop_domain';
const COLUMN_ACCESS_TOKEN = 'access_token';
const COLUMN_PLAN_ID = 'plan_id';
const COLUMN_IS_ACTIVE = 'is_active';
const COLUMN_IS_PAUSED = 'is_paused';
const COLUMN_TRIAL_STARTED_AT = 'trial_started_at';
const COLUMN_TRIAL_ENDS_AT = 'trial_ends_at';
const COLUMN_CREATED_AT = 'created_at';
const COLUMN_METRIC_DATE = 'metric_date';
const COLUMN_POST_ID = 'post_id';
const COLUMN_IMPRESSIONS = 'impressions';
const COLUMN_CLICKS = 'clicks';
const COLUMN_CTR = 'ctr';
const COLUMN_POSITION = 'position';
const COLUMN_CONVERSIONS = 'conversions';
const COLUMN_REVENUE = 'revenue';
const COLUMN_TITLE = 'title';
const STATUS_PUBLISHED = 'published';
const STATUS_DRAFT = 'draft';
const STATUS_SCHEDULED = 'scheduled';
const STATUS_ARCHIVED = 'archived';
const VALID_STATUSES: ReadonlyArray<string> = [STATUS_PUBLISHED, STATUS_DRAFT, STATUS_SCHEDULED, STATUS_ARCHIVED, 'queued'];
const RATE_LIMIT_WINDOW_MS = 60000;
const CACHE_TTL_QUOTA = 30000;
const CACHE_TTL_POSTS = 60000;
const CACHE_TTL_ANALYTICS = 300000;
const RATE_LIMIT_QUOTA = 100;
const RATE_LIMIT_POSTS = 200;
const RATE_LIMIT_ANALYTICS = 100;
const RATE_LIMIT_TRACK = 1000;
const TOP_POSTS_LIMIT = 10;
const RETRY_BACKOFF_BASE = 2;
const DATE_SPLIT_INDEX = 0;
const VALID_EVENT_TYPES: ReadonlyArray<string> = ['pageview', 'scroll', 'click', 'time', 'exit', 'conversion'];
const MIN_TIMESTAMP = 0;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_REQUEST_SIZE_TRACK = 1048576;
const ERROR_EVENT_MUST_BE_OBJECT = 'Event must be an object';
const ERROR_INVALID_EVENT_TYPE = 'Invalid event type';
const ERROR_STORE_ID_REQUIRED_STRING = 'storeId is required and must be a string';
const ERROR_POST_ID_REQUIRED_STRING = 'postId is required and must be a string';
const ERROR_TIMESTAMP_POSITIVE = 'timestamp must be a positive number';
const ERROR_EVENTS_ARRAY_REQUIRED = 'Events array is required and must not be empty';
const ERROR_BATCH_SIZE_EXCEEDS = 'Batch size exceeds maximum of';
const ERROR_INVALID_EVENTS = 'Invalid events';
const ERROR_FAILED_RECORD_EVENTS = 'Failed to record events';
const ERROR_EVENTS_ARRAY_NOT_EMPTY = 'events array must not be empty';
const ERROR_EVENTS_ARRAY_EXCEEDS = 'events array exceeds maximum size of';
const ERROR_CODE_RECORDING_ERROR = 'RECORDING_ERROR';
const HEADER_USER_AGENT = 'user-agent';
const HEADER_REFERER = 'referer';
const HEADER_X_FORWARDED_FOR = 'x-forwarded-for';
const HEADER_X_REAL_IP = 'x-real-ip';

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
  OPENAI_API_KEY: getEnv(ENV_OPENAI_API_KEY, ''),
  GOOGLE_CLIENT_ID: getEnv('GOOGLE_CLIENT_ID', ''),
  GOOGLE_CLIENT_SECRET: getEnv('GOOGLE_CLIENT_SECRET', ''),
  ENABLE_CACHING: getEnv(ENV_ENABLE_CACHING, 'true') !== 'false',
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_TIMEOUT,
  ENABLE_AUDIT_LOGGING: true,
  ENABLE_METRICS: true,
  CORS_ORIGINS: getEnv(ENV_CORS_ORIGINS, '*').split(','),
  MAX_REQUEST_SIZE: parseInt(getEnv(ENV_MAX_REQUEST_SIZE, String(DEFAULT_MAX_REQUEST_SIZE))),
  MAX_BATCH_SIZE: parseInt(getEnv(ENV_MAX_BATCH_SIZE, String(DEFAULT_MAX_BATCH_SIZE))),
  MAX_REQUEST_SIZE_TRACK: parseInt(getEnv(ENV_MAX_REQUEST_SIZE, String(DEFAULT_MAX_REQUEST_SIZE_TRACK))),
  ENABLE_RETRY: getEnv(ENV_ENABLE_RETRY, 'true') !== 'false',
  MAX_RETRIES: parseInt(getEnv(ENV_MAX_RETRIES, String(DEFAULT_MAX_RETRIES))),
  RETRY_DELAY_MS: parseInt(getEnv(ENV_RETRY_DELAY_MS, String(DEFAULT_RETRY_DELAY_MS))),
};

function getCORSHeaders(req: Request): Readonly<Record<string, string>> {
  return createCORSHeaders(req, CONFIG.CORS_ORIGINS);
}

const responseCache = new Map<string, CacheEntry>();

function getCacheKey(path: string, queryParams: URLSearchParams, storeId?: string): string {
  const sortedParams = Array.from(queryParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}${PARAM_EQUALS}${v}`)
    .join(PARAM_SEPARATOR);
  return `${path}${storeId ? `${STORE_ID_SEPARATOR}${storeId}` : ''}${QUERY_SEPARATOR}${sortedParams}`;
}

function getCachedResponse(cacheKey: string): unknown | null {
  if (!CONFIG.ENABLE_CACHING) return null;

  const entry = responseCache.get(cacheKey);
  if (!entry) return null;

  const now = Date.now();
  if (now - entry.timestamp > entry.ttl) {
    responseCache.delete(cacheKey);
    return null;
  }

  return entry.data;
}

function setCachedResponse(cacheKey: string, data: unknown, ttl: number): void {
  if (!CONFIG.ENABLE_CACHING) return;

  if (responseCache.size >= MAX_CACHE_SIZE) {
    const now = Date.now();
    for (const [key, entry] of responseCache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        responseCache.delete(key);
      }
    }

    if (responseCache.size >= MAX_CACHE_SIZE) {
      const entries = Array.from(responseCache.entries())
        .sort(([, a], [, b]) => a.timestamp - b.timestamp);
      const toRemove = responseCache.size - MAX_CACHE_SIZE + CACHE_CLEANUP_BUFFER;
      for (let i = 0; i < toRemove; i++) {
        responseCache.delete(entries[i]![0]!);
      }
    }
  }

  responseCache.set(cacheKey, { data, timestamp: Date.now(), ttl });
}

async function validateAuth(authHeader: string | null): Promise<AuthResult> {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
    return { valid: false, error: 'Missing Supabase configuration' };
  }

  const result = await validateAuthHeader(authHeader, CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  
  if (!result.valid) {
    return { valid: false, error: result.error ?? ERROR_INVALID_AUTHORIZATION };
  }

  return {
    valid: true,
    userId: result.userId ?? AUTHENTICATED_USER,
  };
}


function validatePagination(params: PaginationParams): PaginationResult {
  const page = Math.max(1, parseInt(String(params.page ?? 1)));
  const limit = Math.min(CONFIG.MAX_PAGE_SIZE, Math.max(1, parseInt(String(params.limit ?? CONFIG.DEFAULT_PAGE_SIZE))));
  const offset = params.offset !== undefined ? Math.max(0, parseInt(String(params.offset))) : (page - 1) * limit;

  return { valid: true, page, limit, offset };
}

function validateStoreId(storeId: string | null): StoreValidationResult {
  if (!storeId) {
    return { valid: false, error: ERROR_STORE_ID_REQUIRED };
  }
  if (typeof storeId !== 'string' || storeId.length < 1) {
    return { valid: false, error: ERROR_INVALID_STORE_ID };
  }
  return { valid: true };
}

function validateDateRange(startDate: string | null, endDate: string | null): DateRangeResult {
  let start: Date | null = null;
  let end: Date | null = null;

  if (startDate) {
    start = new Date(startDate);
    if (isNaN(start.getTime())) {
      return { valid: false, error: ERROR_INVALID_START_DATE };
    }
  }

  if (endDate) {
    end = new Date(endDate);
    if (isNaN(end.getTime())) {
      return { valid: false, error: ERROR_INVALID_END_DATE };
    }
  }

  if (start && end && start > end) {
    return { valid: false, error: ERROR_DATE_RANGE };
  }

  return { valid: true, start: start ?? undefined, end: end ?? undefined };
}

function validateStatus(status: string | null): StatusValidationResult {
  if (!status) {
    return { valid: true };
  }
  if (!VALID_STATUSES.includes(status)) {
    return { valid: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` };
  }
  return { valid: true };
}

function generateCorrelationId(): string {
  return `${CORRELATION_PREFIX}${Date.now()}-${Math.random().toString(ID_RADIX).substring(2, 2 + ID_LENGTH)}`;
}

async function createRequestContext(req: Request, requiresAuth: boolean = true): Promise<RequestContext> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  const authHeader = req.headers.get(HEADER_AUTHORIZATION);
  const authResult = await validateAuth(authHeader);

  if (requiresAuth && !authResult.valid) {
    throw new UtilsError(authResult.error ?? ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED, STATUS_UNAUTHORIZED);
  }

  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
    const missingVars = [];
    if (!CONFIG.SUPABASE_URL) missingVars.push('SUPABASE_URL');
    if (!CONFIG.SUPABASE_ANON_KEY) missingVars.push('SUPABASE_ANON_KEY');
    throw new UtilsError(
      `Missing required environment variables: ${missingVars.join(', ')}`,
      ERROR_CODE_CONFIG_ERROR,
      STATUS_INTERNAL_ERROR,
    );
  }

  const supabase = authHeader ? await createAuthenticatedClient(authHeader) : await getSupabaseClient({ clientType: 'anon' });
  
  // Extract storeId from URL path for /store/{shopDomain} requests
  let storeId: string | undefined;

  return {
    req: req as APIRequest,
    supabase,
    correlationId,
    userId: authResult.userId,
    storeId,
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
    const contentLength = req.headers.get(HEADER_CONTENT_LENGTH);
    if (contentLength && parseInt(contentLength) > (config.maxRequestSize ?? CONFIG.MAX_REQUEST_SIZE)) {
      return createErrorResponse(ERROR_REQUEST_TOO_LARGE, STATUS_PAYLOAD_TOO_LARGE, correlationId, undefined, req);
    }

    const processedReq = await executeRequestInterceptors(req);

    const ctx = await createRequestContext(processedReq, config.requiresAuth !== false);
    correlationId = ctx.correlationId;

    if (config.rateLimit) {
      const rateLimitKey = `api:${ctx.userId ?? ANONYMOUS_USER}:${ctx.storeId ?? NO_STORE}:${new URL(req.url).pathname}`;
      const rateLimit = checkRateLimit(rateLimitKey, config.rateLimit.maxRequests, config.rateLimit.windowMs);

      if (!rateLimit.allowed) {
        logger.warn('Rate limit exceeded', { correlationId, rateLimitKey, remaining: rateLimit.remaining });
        return createErrorResponse(ERROR_RATE_LIMIT_EXCEEDED, STATUS_TOO_MANY_REQUESTS, correlationId, {
          retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
        }, req);
      }
    }

    if (config.cache && req.method === METHOD_GET) {
      const url = new URL(req.url);
      const cacheKey = config.cache.key ?? getCacheKey(url.pathname, url.searchParams, ctx.storeId);
      const cached = getCachedResponse(cacheKey);
      if (cached !== null) {
        logger.debug('Cache hit', { correlationId, cacheKey });
        return createSuccessResponse(cached, correlationId, { cached: true }, { compression: true, request: req });
      }
    }

    if (config.validateInput) {
      const url = new URL(req.url);
      const params: Record<string, unknown> = {};
      url.searchParams.forEach((value, key) => {
        params[key] = value;
      });

      if (req.method === METHOD_POST) {
        try {
          const body = await req.clone().json() as Readonly<Record<string, unknown>>;
          Object.assign(params, body);
        } catch {
        }
      }

      const validation = config.validateInput(params);
      if (!validation.valid) {
        return createErrorResponse(validation.error ?? ERROR_INVALID_INPUT, STATUS_BAD_REQUEST, correlationId, undefined, req);
      }
    }

    const timeout = config.timeout ?? CONFIG.DEFAULT_TIMEOUT;
    const timeoutPromise = new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(createErrorResponse(ERROR_REQUEST_TIMEOUT, STATUS_REQUEST_TIMEOUT, correlationId, undefined, req));
      }, timeout);
    });

    const handlerPromise = handler(ctx);
    const response = await Promise.race([handlerPromise, timeoutPromise]);

    if (config.cache && response.status === STATUS_OK && req.method === METHOD_GET) {
      const responseData = await response.clone().json().catch(() => null);
      if (responseData) {
        const url = new URL(req.url);
        const cacheKey = config.cache.key ?? getCacheKey(url.pathname, url.searchParams, ctx.storeId);
        setCachedResponse(cacheKey, responseData, config.cache.ttl);
      }
    }

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
        storeId: ctx.storeId,
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
      req,
    );
  }
}

async function createSuccessResponse(
  data: unknown,
  correlationId: string,
  metadata?: Readonly<Record<string, unknown>>,
  options: { readonly compression?: boolean; readonly request?: Request } = {},
): Promise<Response> {
  const response: APIResponse = {
    data,
    correlationId,
    ...(metadata && { metadata }),
  };

  const corsHeaders = options.request ? getCORSHeaders(options.request) : createCORSHeaders({ headers: new Headers() } as Request, CONFIG.CORS_ORIGINS);

  // Enable compression by default if request is provided (for performance optimization)
  const shouldCompress = options.compression !== false && options.request;
  if (shouldCompress) {
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
  request?: Request,
): Response {
  const response: APIResponse = {
    error,
    correlationId,
    ...(metadata && { metadata }),
  };

  const corsHeaders = request ? getCORSHeaders(request) : createCORSHeaders({ headers: new Headers() } as Request, CONFIG.CORS_ORIGINS);

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
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        const backoffDelay = delayMs * Math.pow(RETRY_BACKOFF_BASE, attempt);
        logger.debug('Retrying operation', { attempt: attempt + 1, maxRetries, backoffDelay });
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
      }
    }
  }

  throw lastError ?? new Error('Operation failed after retries');
}

async function handleQuota(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  const url = new URL(req.url);
  let storeId = url.searchParams.get(PARAM_STORE_ID);

  if (!storeId && req.method === METHOD_POST) {
    try {
      // Clone request to avoid consuming the body stream if it was already read during validation
      const clonedReq = req.clone();
      const body = await clonedReq.json() as QuotaBody;
      storeId = body.storeId ?? null;
    } catch (error) {
      logger.debug('Failed to parse quota request body', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Use ctx.storeId if available (from URL path or other source)
  if (!storeId && ctx.storeId) {
    storeId = ctx.storeId;
  }

  // If still no storeId, return error
  if (!storeId) {
    return createErrorResponse(ERROR_STORE_ID_REQUIRED, STATUS_BAD_REQUEST, correlationId, undefined, ctx.req);
  }

  const storeValidation = validateStoreId(storeId);
  if (!storeValidation.valid) {
    return createErrorResponse(storeValidation.error ?? ERROR_STORE_ID_REQUIRED, STATUS_BAD_REQUEST, correlationId, undefined, ctx.req);
  }

  try {
    // First, ensure store has a plan - assign free_trial if missing
    const { data: store, error: storeCheckError } = await retryOperation(
      async () => {
        const result = await supabase
          .from(TABLE_STORES)
          .select(`${COLUMN_ID}, ${COLUMN_PLAN_ID}, ${COLUMN_TRIAL_STARTED_AT}, ${COLUMN_TRIAL_ENDS_AT}`)
          .eq(COLUMN_ID, storeId)
          .single();
        if (result.error) {
          throw new SupabaseClientError('Failed to fetch store', result.error);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
    );

    if (storeCheckError || !store) {
      throw new SupabaseClientError('Store not found', storeCheckError || new Error('Store not found'));
    }

    const storeData = store as { id: string; plan_id: string | null; trial_started_at?: string | null; trial_ends_at?: string | null };
    
    // If store has no plan, initialize trial using enterprise-grade manager
    if (!storeData.plan_id) {
      const { PlanTrialManager } = await import('../backend/src/core/PlanTrialManager.ts');
      const planTrialManager = new PlanTrialManager(supabase);

      const initResult = await retryOperation(
        async () => {
          return await planTrialManager.initializeTrial(storeId, 14, correlationId, false);
        },
        CONFIG.MAX_RETRIES,
        CONFIG.RETRY_DELAY_MS,
      );

      if (!initResult.success) {
        logger.error('Failed to initialize trial', {
          correlationId,
          error: initResult.error,
          storeId,
        });
        throw new SupabaseClientError('Failed to initialize trial', new Error(initResult.error || 'Unknown error'));
      }

      logger.info('Initialized trial for store without plan', {
        correlationId,
        storeId,
        trialStatus: initResult.trialStatus,
      });
    }

    const { data: quotaStatus, error } = await retryOperation(
      async () => {
        const result = await supabase.rpc(RPC_GET_STORE_QUOTA_STATUS, {
          [PARAM_STORE_UUID]: storeId,
        });
        if (result.error) {
          throw new SupabaseClientError('Failed to fetch quota', result.error);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
    );

    if (error) {
      throw new SupabaseClientError('Failed to fetch quota', error);
    }

    return createSuccessResponse(quotaStatus ?? {}, correlationId, {}, { compression: true, request: req });
  } catch (error) {
    logger.error('Quota fetch error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      storeId,
    });
    throw error;
  }
}

async function handlePosts(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  const url = new URL(req.url);
  let storeId = url.searchParams.get(PARAM_STORE_ID);
  const status = url.searchParams.get(PARAM_STATUS);

  // Use ctx.storeId if available (from URL path or other source)
  if (!storeId && ctx.storeId) {
    storeId = ctx.storeId;
  }

  // If still no storeId, return error
  if (!storeId) {
    return createErrorResponse(ERROR_STORE_ID_REQUIRED, STATUS_BAD_REQUEST, correlationId, undefined, ctx.req);
  }

  const storeValidation = validateStoreId(storeId);
  if (!storeValidation.valid) {
    return createErrorResponse(storeValidation.error ?? ERROR_STORE_ID_REQUIRED, STATUS_BAD_REQUEST, correlationId, undefined, ctx.req);
  }

  const statusValidation = validateStatus(status);
  if (!statusValidation.valid) {
    return createErrorResponse(statusValidation.error ?? ERROR_INVALID_STATUS, STATUS_BAD_REQUEST, correlationId, undefined, ctx.req);
  }

  const pagination = validatePagination({
    page: parseInt(url.searchParams.get(PARAM_PAGE) ?? '1'),
    limit: parseInt(url.searchParams.get(PARAM_LIMIT) ?? String(CONFIG.DEFAULT_PAGE_SIZE)),
  });

  try {
    let query = supabase
      .from(TABLE_BLOG_POSTS)
      .select('*', { count: 'exact' })
      .eq(COLUMN_STORE_ID, storeId!)
      .order(COLUMN_CREATED_AT, { ascending: false });

    if (status) {
      query = query.eq(PARAM_STATUS, status);
    }

    const { data: posts, error, count } = await retryOperation(
      async () => {
        const result = await query.range(pagination.offset, pagination.offset + pagination.limit - 1);
        if (result.error) {
          throw new SupabaseClientError('Failed to fetch posts', result.error);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
    );

    if (error) {
      throw new SupabaseClientError('Failed to fetch posts', error);
    }

    return createSuccessResponse(
      posts ?? [],
      correlationId,
      {
        pagination: {
          page: pagination.page,
          limit: pagination.limit,
          total: count ?? 0,
          totalPages: Math.ceil((count ?? 0) / pagination.limit),
        },
      },
      { compression: true, request: req },
    );
  } catch (error) {
    logger.error('Posts fetch error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      storeId,
    });
    throw error;
  }
}

async function handleAnalytics(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  const url = new URL(req.url);
  let storeId = url.searchParams.get(PARAM_STORE_ID);
  const startDate = url.searchParams.get(PARAM_START);
  const endDate = url.searchParams.get(PARAM_END);

  if (!storeId && ctx.storeId) {
    storeId = ctx.storeId;
  }

  const storeValidation = validateStoreId(storeId);
  if (!storeValidation.valid) {
    return createErrorResponse(storeValidation.error ?? ERROR_STORE_ID_REQUIRED, STATUS_BAD_REQUEST, correlationId, undefined, ctx.req);
  }

  const dateValidation = validateDateRange(startDate, endDate);
  if (!dateValidation.valid) {
    return createErrorResponse(dateValidation.error ?? 'Invalid date range', STATUS_BAD_REQUEST, correlationId, undefined, ctx.req);
  }

  try {
    const [metricsResult, topPostsResult] = await Promise.all([
      retryOperation(
        async () => {
          let metricsQuery = supabase
            .from(TABLE_PERFORMANCE_METRICS)
            .select(`${COLUMN_IMPRESSIONS}, ${COLUMN_CLICKS}, ${COLUMN_CONVERSIONS}, ${COLUMN_REVENUE}, ${COLUMN_POSITION}`)
            .eq(COLUMN_STORE_ID, storeId!);

          if (dateValidation.start) {
            metricsQuery = metricsQuery.gte(COLUMN_METRIC_DATE, dateValidation.start.toISOString().split('T')[DATE_SPLIT_INDEX]!);
          }
          if (dateValidation.end) {
            metricsQuery = metricsQuery.lte(COLUMN_METRIC_DATE, dateValidation.end.toISOString().split('T')[DATE_SPLIT_INDEX]!);
          }

          const result = await metricsQuery;
          if (result.error) {
            throw new SupabaseClientError('Failed to fetch metrics', result.error);
          }
          return result;
        },
        CONFIG.MAX_RETRIES,
        CONFIG.RETRY_DELAY_MS,
      ),
      retryOperation(
        async () => {
          let topPostsQuery = supabase
            .from(TABLE_PERFORMANCE_METRICS)
            .select(`${COLUMN_POST_ID}, ${COLUMN_IMPRESSIONS}, ${COLUMN_CLICKS}, ${COLUMN_CTR}, ${COLUMN_POSITION}, ${TABLE_BLOG_POSTS}(${COLUMN_TITLE})`)
            .eq(COLUMN_STORE_ID, storeId!)
            .order(COLUMN_CLICKS, { ascending: false })
            .limit(TOP_POSTS_LIMIT);

          if (dateValidation.start) {
            topPostsQuery = topPostsQuery.gte(COLUMN_METRIC_DATE, dateValidation.start.toISOString().split('T')[DATE_SPLIT_INDEX]!);
          }
          if (dateValidation.end) {
            topPostsQuery = topPostsQuery.lte(COLUMN_METRIC_DATE, dateValidation.end.toISOString().split('T')[DATE_SPLIT_INDEX]!);
          }

          const result = await topPostsQuery;
          if (result.error) {
            throw new SupabaseClientError('Failed to fetch top posts', result.error);
          }
          return result;
        },
        CONFIG.MAX_RETRIES,
        CONFIG.RETRY_DELAY_MS,
      ),
    ]);

    const metrics = metricsResult.data ?? [];
    const topPosts = topPostsResult.data ?? [];

    const totalImpressions = metrics.reduce((sum, m) => sum + Number((m as Readonly<Record<string, unknown>>)[COLUMN_IMPRESSIONS] ?? 0), 0);
    const totalClicks = metrics.reduce((sum, m) => sum + Number((m as Readonly<Record<string, unknown>>)[COLUMN_CLICKS] ?? 0), 0);
    const totalConversions = metrics.reduce((sum, m) => sum + Number((m as Readonly<Record<string, unknown>>)[COLUMN_CONVERSIONS] ?? 0), 0);
    const avgCTR = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
    const avgPosition = metrics.length > 0
      ? metrics.reduce((sum, m) => {
          const position = Number((m as Readonly<Record<string, unknown>>)[COLUMN_POSITION] ?? 100);
          return sum + (position > 0 ? position : 100);
        }, 0) / metrics.length
      : 100;

    return createSuccessResponse(
      {
        totalImpressions,
        totalClicks,
        totalConversions,
        avgCTR,
        avgPosition,
        topPosts,
      },
      correlationId,
      {},
      { compression: true, request: req },
    );
  } catch (error) {
    logger.error('Analytics fetch error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      storeId,
    });
    throw error;
  }
}

async function handleCheckScheduleConflicts(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  
  try {
    const body = await req.json() as {
      storeId?: string;
      postId?: string;
      scheduledAt?: string;
    };

    if (!body.storeId || !body.postId || !body.scheduledAt) {
      return createErrorResponse('storeId, postId, and scheduledAt are required', STATUS_BAD_REQUEST, correlationId);
    }

    // Scheduler import disabled for Deno compatibility
    // Return empty conflicts for now - can be re-enabled with Deno-compatible Scheduler
    logger.warn('Schedule conflict check not available in Edge Function', { correlationId });
    
    return createSuccessResponse(
      { conflicts: [] },
      correlationId,
      {},
      { compression: true, request: req },
    );
  } catch (error) {
    logger.error('Schedule conflict check error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function handleStore(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  const url = new URL(req.url);
  const pathParts = url.pathname.split(PATH_SEPARATOR).filter((p) => p);
  
  // Extract shop domain from path
  // Path could be: /store/{shopDomain} or /api-router/store/{shopDomain}
  // Supabase functions receive pathname relative to /functions/v1/{function-name}
  // So if function is 'api-router' and request is /functions/v1/api-router/store/{shopDomain}
  // The pathname would be /store/{shopDomain} (relative to function)
  // But if called as /api-router/store/{shopDomain}, pathname might be /api-router/store/{shopDomain}
  const storeIndex = pathParts.indexOf('store');
  if (storeIndex === -1 || storeIndex >= pathParts.length - 1) {
    return createErrorResponse('Shop domain is required', STATUS_BAD_REQUEST, correlationId, undefined, ctx.req);
  }
  
  const shopDomain = pathParts[storeIndex + 1];
  if (!shopDomain) {
    return createErrorResponse('Shop domain is required', STATUS_BAD_REQUEST, correlationId, undefined, ctx.req);
  }

  try {
    const { data: store, error } = await retryOperation(
      async () => {
        const result = await supabase
          .from(TABLE_STORES)
          .select('*')
          .eq(COLUMN_SHOP_DOMAIN, shopDomain)
          .single();
        if (result.error) {
          // Check if it's a "not found" error before throwing
          const errorCode = (result.error as { code?: string })?.code;
          if (errorCode === 'PGRST116') {
            // Return a result that indicates not found
            return { data: null, error: result.error };
          }
          // Log the actual error for debugging
          logger.error('Supabase query error when fetching store', {
            shopDomain,
            errorCode,
            errorMessage: (result.error as { message?: string })?.message || String(result.error),
            errorDetails: result.error,
          });
          throw new SupabaseClientError('Failed to fetch store', result.error);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
    );

    // Check if it's a "not found" error - if so, proceed to auto-create
    const isNotFoundError = error && (() => {
      const errorObj = error as { code?: string; message?: string };
      const errorCode = errorObj.code;
      return errorCode === 'PGRST116' || 
        (errorObj.message && (errorObj.message.includes('PGRST116') || errorObj.message.includes('No rows returned')));
    })();

    if (error && !isNotFoundError) {
      // Real error (not just "not found") - log and return
      const errorObj = error as { code?: string; message?: string; details?: string; hint?: string };
      logger.error('Store fetch error', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        shopDomain,
        errorCode: errorObj.code,
        errorMessage: errorObj.message,
        errorDetails: errorObj.details,
        errorHint: errorObj.hint,
        fullError: errorObj,
      });
      return createErrorResponse(
        error instanceof Error ? error.message : 'Failed to fetch store',
        STATUS_INTERNAL_ERROR,
        correlationId,
        undefined,
        ctx.req,
      );
    }

    // If store not found (either error is "not found" or store is null), check with service role client first
    // The regular client might not see the store due to RLS, but the store might actually exist
    if (!store || isNotFoundError) {
      // Use service role client to bypass RLS and check if store actually exists
      try {
        const serviceSupabase = await getSupabaseClient({ clientType: 'service' });
        
        // First, check if the store exists using service role client (bypasses RLS)
        const { data: existingStore, error: checkError } = await serviceSupabase
          .from(TABLE_STORES)
          .select('*')
          .eq(COLUMN_SHOP_DOMAIN, shopDomain)
          .single();
        
        // If store exists, return it
        if (existingStore && !checkError) {
          logger.info('Store found with service role client', { correlationId, shopDomain, storeId: existingStore.id });
          return createSuccessResponse(existingStore, correlationId, {}, { compression: true, request: req });
        }
        
        // Store truly doesn't exist - proceed with auto-creation
        // Get the free_trial plan
        const { data: plan, error: planError } = await serviceSupabase
          .from('plan_limits')
          .select('id')
          .eq('plan_name', 'free_trial')
          .single();
        
        if (planError || !plan) {
          logger.error('Failed to fetch free_trial plan for auto-create', { 
            correlationId, 
            planError: planError ? (planError as { message?: string; code?: string })?.message || String(planError) : 'No plan found',
            planErrorCode: planError ? (planError as { code?: string })?.code : undefined,
          });
          return createErrorResponse(
            'Store not found. Please ensure the free_trial plan exists in plan_limits table. Run the database migrations to populate plan_limits.',
            STATUS_NOT_FOUND,
            correlationId,
          );
        }
        
        // Create the store using service role client to bypass RLS
        // Don't set trial dates here - they will be set when setup is completed (complete-setup endpoint)
        // This prevents resetting trial dates when user uninstalls and reinstalls the app
        const { data: newStore, error: createError } = await serviceSupabase
          .from(TABLE_STORES)
          .insert({
            [COLUMN_SHOP_DOMAIN]: shopDomain,
            [COLUMN_ACCESS_TOKEN]: 'auto-created-placeholder-token', // Placeholder - should be updated via OAuth
            [COLUMN_PLAN_ID]: plan.id,
            [COLUMN_IS_ACTIVE]: true,
            [COLUMN_IS_PAUSED]: false,
            // Don't set trial_started_at and trial_ends_at here - will be set on setup completion if needed
            language_settings: { primary: 'en', enabled: ['en'] },
            frequency_settings: { interval: 'weekly', count: 3 },
          })
          .select()
          .single();
        
        if (createError || !newStore) {
          // Check if it's a duplicate key error (store already exists)
          const errorCode = createError ? (createError as { code?: string })?.code : undefined;
          const errorMessage = createError ? (createError as { message?: string; details?: string })?.message || String(createError) : 'Unknown error';
          const errorDetails = createError ? (createError as { details?: string })?.details : undefined;
          
          if (errorCode === '23505' || errorMessage.includes('duplicate key') || errorMessage.includes('unique constraint')) {
            // Store already exists - fetch it instead
            logger.warn('Store creation failed due to duplicate key, fetching existing store', { correlationId, shopDomain });
            const { data: fetchedStore, error: fetchError } = await serviceSupabase
              .from(TABLE_STORES)
              .select('*')
              .eq(COLUMN_SHOP_DOMAIN, shopDomain)
              .single();
            
            if (fetchedStore && !fetchError) {
              logger.info('Fetched existing store after duplicate key error', { correlationId, shopDomain, storeId: fetchedStore.id });
              return createSuccessResponse(fetchedStore, correlationId, {}, { compression: true, request: req });
            }
          }
          
          logger.error('Failed to auto-create store', { 
            correlationId, 
            createError: errorMessage,
            createErrorCode: errorCode,
            createErrorDetails: errorDetails,
            shopDomain,
          });
          return createErrorResponse(
            `Failed to create store: ${errorMessage}. Please check database permissions and ensure RLS policies allow service role inserts.`,
            STATUS_INTERNAL_ERROR,
            correlationId,
          );
        }
        
        logger.info('Store auto-created successfully', { correlationId, shopDomain, storeId: newStore.id });
        return createSuccessResponse(newStore, correlationId, {}, { compression: true, request: req });
      } catch (createError) {
        logger.error('Error during store auto-create', {
          correlationId,
          error: createError instanceof Error ? createError.message : String(createError),
          shopDomain,
          stack: createError instanceof Error ? createError.stack : undefined,
          errorName: createError instanceof Error ? createError.name : typeof createError,
        });
        const errorMessage = createError instanceof Error 
          ? createError.message 
          : String(createError);
        return createErrorResponse(
          `Failed to create store: ${errorMessage}. Please ensure the Supabase service role key is configured and the database is properly set up.`,
          STATUS_INTERNAL_ERROR,
          correlationId,
        );
      }
    }

    return createSuccessResponse(store, correlationId, {}, { compression: true, request: req });
  } catch (error) {
    // Check if it's a "not found" error
    // If it's a SupabaseClientError, check the details
    let errorCode: string | undefined;
    if (error instanceof SupabaseClientError) {
      const details = (error as { response?: { code?: string } }).response;
      errorCode = details?.code;
    } else if (error && typeof error === 'object' && 'code' in error) {
      errorCode = (error as { code: string }).code;
    }
    
    const isNotFound = errorCode === 'PGRST116' || 
      (error instanceof Error && (error.message.includes('PGRST116') || error.message.includes('No rows returned')));
    
    if (isNotFound) {
      return createErrorResponse('Store not found', STATUS_NOT_FOUND, correlationId);
    }
    
    logger.error('Store fetch error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      shopDomain,
      stack: error instanceof Error ? error.stack : undefined,
      errorCode,
    });
    // Return error response instead of throwing
    return createErrorResponse(
      error instanceof Error ? error.message : 'Internal server error',
      STATUS_INTERNAL_ERROR,
      correlationId,
    );
  }
}

async function handleRegenerationLimits(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;

  try {
    const body = await req.json() as { storeId: string; postId: string };
    
    if (!body.storeId || !body.postId) {
      return createErrorResponse('storeId and postId are required', STATUS_BAD_REQUEST, correlationId);
    }

    const { data: limitCheck, error: limitError } = await supabase
      .rpc('check_regeneration_limits', {
        store_uuid: body.storeId,
        post_uuid: body.postId,
        regenerated_from_uuid: body.postId,
      });

    if (limitError) {
      logger.error('Failed to check regeneration limits', {
        correlationId,
        error: limitError.message,
        storeId: body.storeId,
        postId: body.postId,
      });
      return createErrorResponse(
        `Failed to check regeneration limits: ${limitError.message}`,
        STATUS_INTERNAL_ERROR,
        correlationId,
      );
    }

    return createSuccessResponse(
      limitCheck,
      correlationId,
      {},
      { compression: true, request: req },
    );
  } catch (error) {
    logger.error('Regeneration limits check error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return createErrorResponse(
      error instanceof Error ? error.message : 'Internal server error',
      STATUS_INTERNAL_ERROR,
      correlationId,
    );
  }
}

async function handleQueue(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId, storeId } = ctx;
  const url = new URL(req.url);
  const pathParts = url.pathname.split('/').filter((p) => p);
  
  // Get storeId from body, query params, or context
  let targetStoreId = storeId;
  if (!targetStoreId && req.method === METHOD_POST) {
    try {
      const body = await req.clone().json() as { storeId?: string };
      targetStoreId = body.storeId;
    } catch {
      // Body might not be JSON or might not have storeId
    }
  }
  if (!targetStoreId) {
    targetStoreId = url.searchParams.get('storeId') || undefined;
  }
  
  // Handle nested routes: /queue/metrics, /queue/reorder, /queue/regenerate-title, /queue/refill
  const lastPart = pathParts[pathParts.length - 1];
  const isQueueAction = pathParts.length >= 3 && pathParts[pathParts.length - 2] === 'queue';
  
  if (isQueueAction) {
    const action = lastPart;
    
    if (action === 'metrics' && req.method === METHOD_GET) {
      if (!targetStoreId) {
        return createErrorResponse('storeId is required', STATUS_BAD_REQUEST, correlationId);
      }
      
      const { ArticlesQueue } = await import('../backend/src/core/ArticlesQueue.ts');
      const serviceSupabase = await getSupabaseClient({ clientType: 'service' });
      const queue = new ArticlesQueue(serviceSupabase);
      const metrics = await queue.getQueueMetrics(targetStoreId);
      
      if (!metrics) {
        return createErrorResponse('Failed to get queue metrics', STATUS_INTERNAL_ERROR, correlationId);
      }
      
      return createSuccessResponse(metrics, correlationId, {}, { compression: true, request: req });
    }
    
    if (action === 'refill' && req.method === METHOD_POST) {
      if (!targetStoreId) {
        return createErrorResponse('storeId is required', STATUS_BAD_REQUEST, correlationId);
      }
      
      const { ArticlesQueue } = await import('../backend/src/core/ArticlesQueue.ts');
      const serviceSupabase = await getSupabaseClient({ clientType: 'service' });
      
      // Get store data for AI generation
      const { data: store } = await serviceSupabase
        .from('stores')
        .select('brand_dna, tone_matrix, content_preferences')
        .eq('id', targetStoreId)
        .single();
      
      const brandDNA = (store?.brand_dna || {}) as { [key: string]: unknown };
      const toneMatrix = (store?.tone_matrix || {}) as { [key: string]: unknown };
      
      const queue = new ArticlesQueue(
        serviceSupabase,
        CONFIG.OPENAI_API_KEY,
        toneMatrix,
        brandDNA as { [key: string]: unknown },
      );
      
      const created = await queue.refillQueue(targetStoreId);
      
      return createSuccessResponse({ created }, correlationId, {}, { compression: true, request: req });
    }
    
    if (action === 'reorder' && req.method === METHOD_POST) {
      if (!targetStoreId) {
        return createErrorResponse('storeId is required', STATUS_BAD_REQUEST, correlationId);
      }
      
      const body = await req.json() as { articleIds: string[] };
      
      if (!Array.isArray(body.articleIds)) {
        return createErrorResponse('articleIds array is required', STATUS_BAD_REQUEST, correlationId);
      }
      
      const { ArticlesQueue } = await import('../backend/src/core/ArticlesQueue.ts');
      const serviceSupabase = await getSupabaseClient({ clientType: 'service' });
      const queue = new ArticlesQueue(serviceSupabase);
      
      const success = await queue.reorderQueue(targetStoreId, body.articleIds);
      
      if (!success) {
        return createErrorResponse('Failed to reorder queue', STATUS_INTERNAL_ERROR, correlationId);
      }
      
      return createSuccessResponse({ success: true }, correlationId, {}, { compression: true, request: req });
    }
    
    if (action === 'regenerate-title' && req.method === METHOD_POST) {
      if (!targetStoreId) {
        return createErrorResponse('storeId is required', STATUS_BAD_REQUEST, correlationId);
      }
      
      const body = await req.json() as { articleId: string };
      
      if (!body.articleId) {
        return createErrorResponse('articleId is required', STATUS_BAD_REQUEST, correlationId);
      }
      
      const { ArticlesQueue } = await import('../backend/src/core/ArticlesQueue.ts');
      const serviceSupabase = await getSupabaseClient({ clientType: 'service' });
      
      // Get store data for AI generation
      const { data: store } = await serviceSupabase
        .from('stores')
        .select('brand_dna, tone_matrix, content_preferences')
        .eq('id', targetStoreId)
        .single();
      
      const brandDNA = (store?.brand_dna || {}) as { [key: string]: unknown };
      const toneMatrix = (store?.tone_matrix || {}) as { [key: string]: unknown };
      
      const queue = new ArticlesQueue(
        serviceSupabase,
        CONFIG.OPENAI_API_KEY,
        toneMatrix,
        brandDNA as { [key: string]: unknown },
      );
      
      const newTitle = await queue.regenerateTitle(targetStoreId, body.articleId);
      
      if (!newTitle) {
        return createErrorResponse('Failed to regenerate title', STATUS_INTERNAL_ERROR, correlationId);
      }
      
      return createSuccessResponse({ title: newTitle }, correlationId, {}, { compression: true, request: req });
    }
  }
  
  // Default: return queue list (GET /queue)
  if (req.method === METHOD_GET) {
    if (!targetStoreId) {
      return createErrorResponse('storeId is required', STATUS_BAD_REQUEST, correlationId);
    }
    
    const { ArticlesQueue } = await import('../backend/src/core/ArticlesQueue.ts');
    const serviceSupabase = await getSupabaseClient({ clientType: 'service' });
    const queue = new ArticlesQueue(serviceSupabase);
    const queueList = await queue.getQueue(targetStoreId);
    
    return createSuccessResponse(queueList, correlationId, {}, { compression: true, request: req });
  }
  
  return createErrorResponse('Method not allowed', 405, correlationId);
}

async function handleCompleteSetup(ctx: RequestContext): Promise<Response> {
  const { req, correlationId } = ctx;

  if (req.method !== METHOD_POST) {
    return createErrorResponse('Method not allowed', 405, correlationId);
  }

  type CompleteSetupBody = {
    readonly storeId?: string;
    readonly shopDomain?: string;
    readonly frequencySettings?: unknown;
    readonly contentPreferences?: unknown;
  };

  const body = (await req.json()) as CompleteSetupBody;
  const storeId = body.storeId ?? null;
  const shopDomain = body.shopDomain ?? null;

  const storeIdValidation = validateStoreId(storeId);
  if (!storeIdValidation.valid) {
    return createErrorResponse(storeIdValidation.error ?? ERROR_INVALID_STORE_ID, STATUS_BAD_REQUEST, correlationId);
  }
  if (!shopDomain || typeof shopDomain !== 'string') {
    return createErrorResponse('shopDomain is required', STATUS_BAD_REQUEST, correlationId);
  }

  // Minimal validation of frequency settings shape (must include preferredDays + preferredTimes arrays)
  const fs = body.frequencySettings as { preferredDays?: unknown; preferredTimes?: unknown } | null | undefined;
  if (
    !fs ||
    !Array.isArray(fs.preferredDays) ||
    fs.preferredDays.length === 0 ||
    !Array.isArray(fs.preferredTimes) ||
    fs.preferredTimes.length === 0
  ) {
    return createErrorResponse(
      'frequencySettings.preferredDays and frequencySettings.preferredTimes are required',
      STATUS_BAD_REQUEST,
      correlationId,
    );
  }

  // Use service role for updates (browser clients won't have shop_domain JWT claims for RLS)
  const serviceSupabase = await getSupabaseClient({ clientType: 'service' });

  // Verify storeId belongs to the shopDomain we were called with (basic tenant safety)
  const { data: existingStore, error: existingErr } = await serviceSupabase
    .from(TABLE_STORES)
    .select('id, shop_domain')
    .eq('id', storeId)
    .single();

  if (existingErr || !existingStore) {
    return createErrorResponse('Store not found', STATUS_NOT_FOUND, correlationId);
  }
  if (existingStore.shop_domain !== shopDomain) {
    return createErrorResponse('Store/shop mismatch', STATUS_UNAUTHORIZED, correlationId);
  }

  // Check if store has a plan and trial status
  const { data: storeBeforeUpdate, error: storeFetchError } = await serviceSupabase
    .from(TABLE_STORES)
    .select('plan_id, trial_ends_at, plan_limits(plan_name)')
    .eq('id', storeId)
    .single();

  const updates: Record<string, unknown> = {
    frequency_settings: body.frequencySettings,
  };

  if (body.contentPreferences !== undefined) {
    updates.content_preferences = body.contentPreferences;
  }

    // Use enterprise-grade trial manager for setup completion
    // Only reset trial dates if:
    // 1. Store has no plan_id (brand new store), OR
    // 2. Trial has expired (trial_ends_at is in the past or null)
    // This prevents resetting an active trial when re-running setup from settings
    if (storeBeforeUpdate && !storeFetchError) {
      const planId = (storeBeforeUpdate as { plan_id?: string | null }).plan_id;
      const trialEndsAt = (storeBeforeUpdate as { trial_ends_at?: string | null }).trial_ends_at;
      
      // Check if trial has expired (null or in the past)
      const trialExpired = !trialEndsAt || new Date(trialEndsAt) < new Date();
      
      // Only reset if no plan OR trial has expired
      if (!planId || trialExpired) {
        const { PlanTrialManager } = await import('../backend/src/core/PlanTrialManager.ts');
        const planTrialManager = new PlanTrialManager(serviceSupabase);

        const initResult = await planTrialManager.initializeTrial(
          storeId,
          14,
          correlationId,
          trialExpired, // Force reset if trial expired
        );

        if (initResult.success && !planId) {
          // Update plan_id in updates if it was set by initializeTrial
          const { data: freeTrialPlan } = await serviceSupabase
            .from('plan_limits')
            .select('id')
            .eq('plan_name', 'free_trial')
            .single();
          
          if (freeTrialPlan) {
            updates[COLUMN_PLAN_ID] = freeTrialPlan.id;
          }
        }
        
        logger.info('Initialized/reset trial on setup completion', {
          correlationId,
          storeId,
          reason: !planId ? 'no_plan' : 'trial_expired',
          success: initResult.success,
        });
      }
    }

  const { data: updatedStore, error: updateErr } = await serviceSupabase
    .from(TABLE_STORES)
    .update(updates)
    .eq('id', storeId)
    .select('*')
    .single();

  if (updateErr || !updatedStore) {
    return createErrorResponse(
      updateErr ? (updateErr as { message?: string }).message ?? 'Failed to update store' : 'Failed to update store',
      STATUS_INTERNAL_ERROR,
      correlationId,
    );
  }

  logger.info('Setup completed', { correlationId, storeId, shopDomain });

  // After setup is complete, ensure queue is filled
  try {
    const { ArticlesQueue } = await import('../backend/src/core/ArticlesQueue.ts');
    
    // Get store data for AI generation
    const { data: store } = await serviceSupabase
      .from('stores')
      .select('brand_dna, tone_matrix, content_preferences, plan_id, plan_limits(plan_name)')
      .eq('id', storeId)
      .single();
    
    if (store) {
      const brandDNA = (store.brand_dna || {}) as { [key: string]: unknown };
      const toneMatrix = (store.tone_matrix || {}) as { [key: string]: unknown };
      
      const queue = new ArticlesQueue(
        serviceSupabase,
        CONFIG.OPENAI_API_KEY,
        toneMatrix,
        brandDNA as { [key: string]: unknown },
      );
      
      // Refill queue to ensure it's at target size
      await queue.refillQueue(storeId);
      
      logger.info('Queue refilled after setup', { correlationId, storeId });
    }
  } catch (queueError) {
    // Log but don't fail the setup if queue refill fails
    logger.warn('Failed to refill queue after setup', {
      correlationId,
      storeId,
      error: queueError instanceof Error ? queueError.message : String(queueError),
    });
  }

  return createSuccessResponse(updatedStore, correlationId, { cached: false }, { compression: true, request: req });
}

function validateTrackingEvent(event: unknown): EventValidationResult {
  if (!event || typeof event !== 'object') {
    return { valid: false, error: ERROR_EVENT_MUST_BE_OBJECT };
  }

  const eventObj = event as Readonly<Record<string, unknown>>;

  if (!eventObj.type || !VALID_EVENT_TYPES.includes(String(eventObj.type))) {
    return { valid: false, error: ERROR_INVALID_EVENT_TYPE };
  }

  if (!eventObj.storeId || typeof eventObj.storeId !== 'string') {
    return { valid: false, error: ERROR_STORE_ID_REQUIRED_STRING };
  }

  if (eventObj.postId !== undefined && typeof eventObj.postId !== 'string') {
    return { valid: false, error: ERROR_POST_ID_REQUIRED_STRING };
  }

  if (eventObj.timestamp !== undefined && (typeof eventObj.timestamp !== 'number' || eventObj.timestamp <= MIN_TIMESTAMP)) {
    return { valid: false, error: ERROR_TIMESTAMP_POSITIVE };
  }

  return { valid: true };
}

async function handleTrack(req: Request, correlationId: string): Promise<Response> {
  try {
    if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_SERVICE_ROLE_KEY) {
      throw new UtilsError(ERROR_MISSING_ENV, ERROR_CODE_CONFIG_ERROR, STATUS_INTERNAL_ERROR);
    }

    const supabase = await getSupabaseClient({ clientType: 'service' });

    const body = await req.json() as TrackRequestBody | TrackingEvent;
    const isBatch = 'events' in body && Array.isArray(body.events);
    const events: readonly TrackingEvent[] = isBatch ? (body as TrackRequestBody).events : [body as TrackingEvent];

    if (!events || events.length === 0) {
      return createErrorResponse(ERROR_EVENTS_ARRAY_REQUIRED, STATUS_BAD_REQUEST, correlationId);
    }

    if (events.length > CONFIG.MAX_BATCH_SIZE) {
      return createErrorResponse(
        `${ERROR_BATCH_SIZE_EXCEEDS} ${CONFIG.MAX_BATCH_SIZE} events`,
        STATUS_BAD_REQUEST,
        correlationId,
      );
    }

    const validationErrors: string[] = [];
    for (let i = 0; i < events.length; i++) {
      const validation = validateTrackingEvent(events[i]);
      if (!validation.valid) {
        validationErrors.push(`Event ${i}: ${validation.error}`);
      }
    }

    if (validationErrors.length > 0) {
      return createErrorResponse(ERROR_INVALID_EVENTS, STATUS_BAD_REQUEST, correlationId, {
        validationErrors,
      });
    }

    const userAgent = req.headers.get(HEADER_USER_AGENT) ?? undefined;
    const referrer = req.headers.get(HEADER_REFERER) ?? undefined;
    const ip = req.headers.get(HEADER_X_FORWARDED_FOR) ?? req.headers.get(HEADER_X_REAL_IP) ?? undefined;

    const eventsToRecord: EventToRecord[] = Array.from(events).map((event) => ({
      storeId: event.storeId,
      postId: event.postId || null,
      eventType: event.type as 'pageview' | 'scroll' | 'click' | 'time' | 'exit' | 'conversion',
      eventData: event.data ?? {},
      metadata: {
        userAgent,
        referrer,
        ip,
        correlationId,
        timestamp: event.timestamp || Date.now(),
      },
    }));

    let eventsRecorded = 0;
    try {
      // Direct insert into analytics_events table (Deno-compatible)
      const insertData = eventsToRecord.map((event) => ({
        store_id: event.storeId,
        post_id: event.postId,
        event_type: event.eventType,
        event_data: event.eventData,
        metadata: event.metadata,
        created_at: new Date(event.metadata.timestamp).toISOString(),
      }));

      if (CONFIG.ENABLE_RETRY) {
        await retryOperation(async () => {
          const { error: insertError } = await supabase
            .from('analytics_events')
            .insert(insertData);
          if (insertError) throw insertError;
          eventsRecorded = events.length;
        }, CONFIG.MAX_RETRIES, CONFIG.RETRY_DELAY_MS);
      } else {
        const { error: insertError } = await supabase
          .from('analytics_events')
          .insert(insertData);
        if (insertError) throw insertError;
        eventsRecorded = events.length;
      }
    } catch (error) {
      logger.error('Failed to record events', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        eventCount: events.length,
      });
      throw new UtilsError(ERROR_FAILED_RECORD_EVENTS, ERROR_CODE_RECORDING_ERROR, STATUS_INTERNAL_ERROR);
    }

    logger.info('Events tracked', {
      correlationId,
      eventCount: eventsRecorded,
      storeIds: [...new Set(events.map((e) => e.storeId))],
    });

    return createSuccessResponse(
      {
        success: true,
        eventsRecorded,
        timestamp: new Date().toISOString(),
      },
      correlationId,
      { cached: false },
      { compression: true, request: req },
    );
  } catch (error) {
    logger.error('Track error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function routeRequest(ctx: RequestContext): Promise<Response> {
  const url = new URL(ctx.req.url);
  const pathParts = url.pathname.split(PATH_SEPARATOR).filter((p) => p);
  const path = pathParts[pathParts.length - 1] ?? '';

  // Check if this is analytics track endpoint (POST /analytics/track)
  // Path structure: /api-router/analytics/track -> pathParts = ['api-router', 'analytics', 'track']
  if (pathParts.length >= 3 && pathParts[pathParts.length - 2] === 'analytics' && path === 'track' && ctx.req.method === METHOD_POST) {
    const correlationId = ctx.correlationId;
    return await handleTrack(ctx.req, correlationId);
  }

  // Check if this is a nested route (e.g., /schedule/check-conflicts)
  if (pathParts.length >= 2 && pathParts[0] === 'schedule' && pathParts[1] === 'check-conflicts') {
    return handleRequest(ctx.req, handleCheckScheduleConflicts, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
    });
  }

  // Check if this is regeneration limits check
  if (pathParts.length >= 2 && pathParts[0] === 'regeneration' && pathParts[1] === 'check-limits') {
    return handleRequest(ctx.req, handleRegenerationLimits, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
    });
  }

  // Check if this is a queue route
  if (pathParts.length >= 2 && pathParts[pathParts.length - 2] === 'queue') {
    return handleRequest(ctx.req, handleQueue, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
    });
  }
  
  // Check if this is a queue route (direct /queue)
  if (pathParts[pathParts.length - 1] === 'queue') {
    return handleRequest(ctx.req, handleQueue, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
    });
  }

  // Check if this is a billing check endpoint
  if (pathParts.length >= 2 && pathParts[0] === 'billing' && pathParts[1] === 'check') {
    return handleRequest(ctx.req, handleBillingCheck, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_QUOTA, windowMs: RATE_LIMIT_WINDOW_MS },
      cache: { ttl: 60000 }, // Cache for 1 minute
    });
  }

  // Check if this is a billing check endpoint
  if (pathParts.length >= 2 && pathParts[pathParts.length - 2] === 'billing' && pathParts[pathParts.length - 1] === 'check') {
    return handleRequest(ctx.req, handleBillingCheck, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_QUOTA, windowMs: RATE_LIMIT_WINDOW_MS },
      cache: { ttl: 60000 }, // Cache for 1 minute
    });
  }

  const routes: Readonly<Record<string, RouteHandler>> = {
    'complete-setup': {
      handler: handleCompleteSetup,
      config: {
        requiresAuth: false,
        compression: true,
        rateLimit: { maxRequests: 50, windowMs: RATE_LIMIT_WINDOW_MS },
      },
    },
    quota: {
      handler: handleQuota,
      config: {
        requiresAuth: true,
        compression: true,
        rateLimit: { maxRequests: RATE_LIMIT_QUOTA, windowMs: RATE_LIMIT_WINDOW_MS },
        cache: { ttl: CACHE_TTL_QUOTA },
        validateInput: (params) => {
          // storeId can come from params, body, or ctx.storeId (set from URL path)
          // We'll check for it in the handler, so validation is lenient here
          return { valid: true };
        },
      },
    },
    posts: {
      handler: handlePosts,
      config: {
        requiresAuth: true,
        compression: true,
        rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
        cache: { ttl: CACHE_TTL_POSTS },
        validateInput: (params) => {
          // storeId can come from params or ctx.storeId (set from URL path)
          // We'll check for it in the handler, so validation is lenient here
          const validationParams = params as ValidationParams;
          if (validationParams.status) {
            if (!VALID_STATUSES.includes(validationParams.status)) {
              return { valid: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` };
            }
          }
          return { valid: true };
        },
      },
    },
    analytics: {
      handler: handleAnalytics,
      config: {
        requiresAuth: true,
        compression: true,
        rateLimit: { maxRequests: RATE_LIMIT_ANALYTICS, windowMs: RATE_LIMIT_WINDOW_MS },
        cache: { ttl: CACHE_TTL_ANALYTICS },
        validateInput: (params) => {
          const validationParams = params as ValidationParams;
          if (!validationParams.storeId) {
            return { valid: false, error: ERROR_STORE_ID_REQUIRED };
          }
          if (validationParams.start && isNaN(new Date(validationParams.start).getTime())) {
            return { valid: false, error: ERROR_INVALID_START_DATE };
          }
          if (validationParams.end && isNaN(new Date(validationParams.end).getTime())) {
            return { valid: false, error: ERROR_INVALID_END_DATE };
          }
          return { valid: true };
        },
      },
    },
    queue: {
      handler: handleQueue,
      config: {
        requiresAuth: true,
        compression: true,
        rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
        cache: { ttl: 30000 }, // 30 seconds
      },
    },
  };

  const matchedRoute = routes[path];

  if (!matchedRoute) {
    return createErrorResponse(ERROR_NOT_FOUND, STATUS_NOT_FOUND, ctx.correlationId);
  }

  return handleRequest(ctx.req, matchedRoute.handler, matchedRoute.config);
}

// Wrap the entire serve handler to catch any errors that might occur during initialization
try {
  serve(async (req: Request) => {
    if (req.method === METHOD_OPTIONS) {
      return new Response('ok', { headers: getCORSHeaders(req) });
    }

    try {
      const url = new URL(req.url);
      const pathParts = url.pathname.split(PATH_SEPARATOR).filter((p) => p);
      
      // Handle /store/{shopDomain} route - check if 'store' is in path and has a value after it
      // Path could be: /functions/v1/api-router/store/{shopDomain} or /functions/v1/store/{shopDomain}
      // Let handleRequest create the context to ensure proper error handling
      const storeIndex = pathParts.indexOf('store');
      if (storeIndex !== -1 && storeIndex < pathParts.length - 1) {
        return await handleRequest(req, handleStore, {
          requiresAuth: false, // Store lookup by shop domain doesn't require auth
          compression: true,
          rateLimit: { maxRequests: 100, windowMs: 60000 },
          cache: { ttl: 300000 }, // 5 minutes
        });
      }
      
      // For other routes, create context and route
      const ctx = await createRequestContext(req);
      return await routeRequest(ctx);
    } catch (error) {
      const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
      logger.error('Request failed', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Ensure we always return our error format, not Supabase's generic format
      try {
        return createErrorResponse(
          error instanceof Error ? error.message : ERROR_INTERNAL_SERVER,
          error instanceof UtilsError ? error.statusCode : STATUS_INTERNAL_ERROR,
          correlationId,
          { 
            errorCode: error instanceof UtilsError ? error.code : ERROR_CODE_INTERNAL_ERROR,
            debugInfo: {
              errorName: error instanceof Error ? error.name : typeof error,
              stack: error instanceof Error ? error.stack : undefined,
            },
          },
        );
      } catch (responseError) {
        // Fallback if even createErrorResponse fails
        logger.error('Failed to create error response', { error: responseError });
        return new Response(
          JSON.stringify({
            error: error instanceof Error ? error.message : ERROR_INTERNAL_SERVER,
            correlationId,
            metadata: {
              errorCode: ERROR_CODE_INTERNAL_ERROR,
              debugInfo: {
                errorName: error instanceof Error ? error.name : typeof error,
              },
            },
          }),
          {
            status: STATUS_INTERNAL_ERROR,
            headers: {
              ...getCORSHeaders(req),
              [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON,
              [HEADER_X_CORRELATION_ID]: correlationId,
            },
          },
        );
      }
    }
  });
} catch (initError) {
  // Catch any errors during module initialization
  console.error('FATAL: Function initialization failed:', initError);
  // This won't help if the error happens before serve() is called, but it's a safety net
  serve(async (req: Request) => {
    const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? `${Date.now()}-${Math.random()}`;
    return new Response(
      JSON.stringify({
        error: initError instanceof Error ? initError.message : 'Function initialization failed',
        correlationId,
        metadata: {
          errorCode: 'INIT_ERROR',
          debugInfo: {
            errorName: initError instanceof Error ? initError.name : typeof initError,
            stack: initError instanceof Error ? initError.stack : undefined,
          },
        },
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Correlation-Id': correlationId,
        },
      },
    );
  });
}
