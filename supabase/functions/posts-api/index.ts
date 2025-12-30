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
} from '../_shared/utils.ts';

interface DenoEnv {
  readonly get?: (key: string) => string | undefined;
}

interface DenoGlobal {
  readonly Deno?: {
    readonly env?: DenoEnv;
  };
}

interface PostRequest extends Request {
  readonly correlationId?: string;
  readonly userId?: string;
  readonly storeId?: string;
  readonly startTime?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface PostResponse {
  readonly data?: unknown;
  readonly error?: string;
  readonly correlationId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly warnings?: ReadonlyArray<string>;
}

interface RequestContext {
  readonly req: PostRequest;
  readonly supabase: ReturnType<typeof getSupabaseClient>;
  readonly correlationId: string;
  readonly userId?: string;
  storeId?: string;
  readonly startTime: number;
}

interface PostUpdateBody {
  readonly title?: string;
  readonly content?: string;
  readonly excerpt?: string;
  readonly seoTitle?: string;
  readonly seoDescription?: string;
  readonly keywords?: ReadonlyArray<string>;
  readonly status?: string;
  readonly scheduled_publish_at?: string;
  readonly review_status?: 'pending' | 'approved' | 'rejected' | 'auto_approved';
  readonly reviewed_at?: string;
  readonly review_feedback?: Readonly<Record<string, unknown>>;
}

interface EndpointConfig {
  readonly requiresAuth?: boolean;
  readonly rateLimit?: { readonly maxRequests: number; readonly windowMs: number };
  readonly compression?: boolean;
  readonly timeout?: number;
  readonly validateInput?: (body: Readonly<Record<string, unknown>>) => { readonly valid: boolean; readonly error?: string; readonly warnings?: ReadonlyArray<string> };
  readonly maxRequestSize?: number;
}

interface AuthResult {
  readonly valid: boolean;
  readonly userId?: string;
  readonly error?: string;
}

interface ValidationResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly warnings?: ReadonlyArray<string>;
}

interface DatabasePost {
  readonly id: string;
  readonly store_id: string;
  readonly [key: string]: unknown;
}

const ENV_SUPABASE_URL = 'SUPABASE_URL';
const ENV_SUPABASE_ANON_KEY = 'SUPABASE_ANON_KEY';
const DEFAULT_TIMEOUT = 60000;
const DEFAULT_MAX_REQUEST_SIZE = 10485760;
const MIN_TOKEN_LENGTH = 10;
const BEARER_PREFIX = 'Bearer ';
const BEARER_PREFIX_LENGTH = 7;
const ID_RADIX = 36;
const ID_LENGTH = 9;
const CORRELATION_PREFIX = 'posts-api-';
const METHOD_PATCH = 'PATCH';
const METHOD_DELETE = 'DELETE';
const METHOD_OPTIONS = 'OPTIONS';
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_REQUEST_TIMEOUT = 408;
const STATUS_PAYLOAD_TOO_LARGE = 413;
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
const CORS_METHODS_VALUE = 'PATCH, DELETE, OPTIONS';
const CORS_MAX_AGE_VALUE = '86400';
const ENCODING_NONE = 'none';
const ERROR_UNAUTHORIZED = 'Unauthorized';
const ERROR_MISSING_ENV = 'Missing environment variables';
const ERROR_MISSING_AUTHORIZATION = 'Missing authorization header';
const ERROR_INVALID_AUTHORIZATION = 'Invalid authorization';
const ERROR_REQUEST_TOO_LARGE = 'Request too large';
const ERROR_RATE_LIMIT_EXCEEDED = 'Rate limit exceeded';
const ERROR_REQUEST_TIMEOUT = 'Request timeout';
const ERROR_INVALID_INPUT = 'Invalid input';
const ERROR_INVALID_JSON = 'Invalid JSON in request body';
const ERROR_INTERNAL_SERVER = 'Internal server error';
const ERROR_POST_NOT_FOUND = 'Post not found';
const ERROR_POST_ID_REQUIRED = 'postId is required';
const ERROR_CODE_UNAUTHORIZED = 'UNAUTHORIZED';
const ERROR_CODE_CONFIG_ERROR = 'CONFIG_ERROR';
const ERROR_CODE_POST_NOT_FOUND = 'POST_NOT_FOUND';
const ERROR_CODE_INTERNAL_ERROR = 'INTERNAL_ERROR';
const RETRY_BACKOFF_BASE = 2;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 100;
const TABLE_BLOG_POSTS = 'blog_posts';
const COLUMN_ID = 'id';
const COLUMN_STORE_ID = 'store_id';
const COLUMN_TITLE = 'title';
const COLUMN_CONTENT = 'content';
const COLUMN_EXCERPT = 'excerpt';
const COLUMN_SEO_TITLE = 'seo_title';
const COLUMN_SEO_DESCRIPTION = 'seo_description';
const COLUMN_KEYWORDS = 'keywords';
const COLUMN_STATUS = 'status';
const COLUMN_SCHEDULED_PUBLISH_AT = 'scheduled_publish_at';
const COLUMN_UPDATED_AT = 'updated_at';
const VALID_STATUSES = ['draft', 'scheduled', 'published', 'archived'];

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
  DEFAULT_TIMEOUT: parseInt(getEnv('POSTS_API_TIMEOUT', String(DEFAULT_TIMEOUT))),
  CORS_ORIGINS: getEnv('CORS_ORIGINS', '*').split(','),
  MAX_REQUEST_SIZE: parseInt(getEnv('MAX_REQUEST_SIZE', String(DEFAULT_MAX_REQUEST_SIZE))),
  MAX_RETRIES: parseInt(getEnv('MAX_RETRIES', '3')),
  RETRY_DELAY_MS: parseInt(getEnv('RETRY_DELAY_MS', '1000')),
};

const corsHeaders: Readonly<Record<string, string>> = {
  [HEADER_ACCESS_CONTROL_ALLOW_ORIGIN]: CONFIG.CORS_ORIGINS[0] === '*' ? '*' : CONFIG.CORS_ORIGINS.join(','),
  [HEADER_ACCESS_CONTROL_ALLOW_HEADERS]: CORS_HEADERS_VALUE,
  [HEADER_ACCESS_CONTROL_ALLOW_METHODS]: CORS_METHODS_VALUE,
  [HEADER_ACCESS_CONTROL_MAX_AGE]: CORS_MAX_AGE_VALUE,
};

async function validateAuth(authHeader: string | null): Promise<AuthResult> {
  if (!authHeader) {
    return { valid: false, error: ERROR_MISSING_AUTHORIZATION };
  }

  if (authHeader.startsWith(BEARER_PREFIX)) {
    const token = authHeader.substring(BEARER_PREFIX_LENGTH);
    if (token.length > MIN_TOKEN_LENGTH) {
      return { valid: true, userId: 'authenticated' };
    }
  }

  return { valid: false, error: ERROR_INVALID_AUTHORIZATION };
}

function validatePostUpdateParams(params: Readonly<Record<string, unknown>>): ValidationResult {
  const warnings: string[] = [];

  if (params.status && !VALID_STATUSES.includes(params.status as string)) {
    return { valid: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` };
  }

  if (params.title !== undefined && (typeof params.title !== 'string' || params.title.trim().length === 0)) {
    return { valid: false, error: 'title must be a non-empty string' };
  }

  if (params.content !== undefined && typeof params.content !== 'string') {
    return { valid: false, error: 'content must be a string' };
  }

  return { valid: true, warnings: warnings.length > 0 ? warnings : undefined };
}

function generateCorrelationId(): string {
  return `${CORRELATION_PREFIX}${Date.now()}-${Math.random().toString(ID_RADIX).substring(2, 2 + ID_LENGTH)}`;
}

async function createRequestContext(req: Request): Promise<RequestContext> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  const authHeader = req.headers.get(HEADER_AUTHORIZATION);
  const authResult = await validateAuth(authHeader);

  if (!authResult.valid) {
    throw new UtilsError(authResult.error ?? ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED, STATUS_UNAUTHORIZED);
  }

  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
    throw new UtilsError(ERROR_MISSING_ENV, ERROR_CODE_CONFIG_ERROR, STATUS_INTERNAL_ERROR);
  }

  const supabase = authHeader ? await createAuthenticatedClient(authHeader) : await getSupabaseClient({ clientType: 'anon' });

  return {
    req: req as PostRequest,
    supabase,
    correlationId,
    userId: authResult.userId,
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
      return createErrorResponse(ERROR_REQUEST_TOO_LARGE, STATUS_PAYLOAD_TOO_LARGE, correlationId);
    }

    const processedReq = await executeRequestInterceptors(req);

    const ctx = await createRequestContext(processedReq);
    correlationId = ctx.correlationId;

    if (config.rateLimit) {
      const rateLimitKey = `posts-api:${ctx.userId ?? 'anonymous'}`;
      const rateLimit = checkRateLimit(rateLimitKey, config.rateLimit.maxRequests, config.rateLimit.windowMs);

      if (!rateLimit.allowed) {
        logger.warn('Rate limit exceeded', { correlationId, rateLimitKey, remaining: rateLimit.remaining });
        return createErrorResponse(ERROR_RATE_LIMIT_EXCEEDED, STATUS_TOO_MANY_REQUESTS, correlationId, {
          retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
        });
      }
    }

    if (config.validateInput && req.method === METHOD_PATCH) {
      try {
        const body = await req.clone().json() as Readonly<Record<string, unknown>>;
        const validation = config.validateInput(body);
        if (!validation.valid) {
          return createErrorResponse(validation.error ?? ERROR_INVALID_INPUT, STATUS_BAD_REQUEST, correlationId);
        }
      } catch {
        return createErrorResponse(ERROR_INVALID_JSON, STATUS_BAD_REQUEST, correlationId);
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

    logger.info('Request completed', {
      correlationId,
      method: req.method,
      path: new URL(req.url).pathname,
      status: processedResponse.status,
      duration: performance.now() - startTime,
    });

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
  options: { readonly compression?: boolean; readonly request?: Request; readonly warnings?: ReadonlyArray<string> } = {},
): Promise<Response> {
  const response: PostResponse = {
    data,
    correlationId,
    ...(metadata && { metadata }),
    ...(options.warnings && options.warnings.length > 0 && { warnings: options.warnings }),
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
  const response: PostResponse = {
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

async function fetchPost(
  supabase: ReturnType<typeof getSupabaseClient>,
  postId: string,
): Promise<{ data: DatabasePost; error: null } | { data: null; error: Error }> {
  return await retryOperation(
    async () => {
      const result = await supabase
        .from(TABLE_BLOG_POSTS)
        .select(`${COLUMN_ID}, ${COLUMN_STORE_ID}`)
        .eq(COLUMN_ID, postId)
        .single();

      if (result.error) {
        throw new SupabaseClientError('Failed to fetch post', result.error);
      }
      if (!result.data) {
        throw new UtilsError(ERROR_POST_NOT_FOUND, ERROR_CODE_POST_NOT_FOUND, STATUS_NOT_FOUND);
      }
      return { data: result.data as DatabasePost, error: null };
    },
    CONFIG.MAX_RETRIES,
    CONFIG.RETRY_DELAY_MS,
    'fetch_post',
  );
}

async function handleUpdatePost(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  const warnings: string[] = [];

  try {
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter((p) => p);
    const postId = pathParts[pathParts.length - 1];

    if (!postId) {
      return createErrorResponse(ERROR_POST_ID_REQUIRED, STATUS_BAD_REQUEST, correlationId);
    }

    const body = await req.json() as PostUpdateBody;
    const validation = validatePostUpdateParams(body);

    if (!validation.valid) {
      return createErrorResponse(validation.error ?? ERROR_INVALID_INPUT, STATUS_BAD_REQUEST, correlationId);
    }

    if (validation.warnings) {
      warnings.push(...validation.warnings);
    }

    // Fetch existing post to verify ownership
    const fetchResult = await fetchPost(supabase, postId);
    if (fetchResult.error || !fetchResult.data) {
      throw new UtilsError(ERROR_POST_NOT_FOUND, ERROR_CODE_POST_NOT_FOUND, STATUS_NOT_FOUND);
    }

    ctx.storeId = fetchResult.data[COLUMN_STORE_ID] as string;

    // Build update object
    const updates: Record<string, unknown> = {
      [COLUMN_UPDATED_AT]: new Date().toISOString(),
    };

    if (body.title !== undefined) updates[COLUMN_TITLE] = body.title.trim();
    if (body.content !== undefined) updates[COLUMN_CONTENT] = body.content;
    if (body.excerpt !== undefined) updates[COLUMN_EXCERPT] = body.excerpt;
    if (body.seoTitle !== undefined) updates[COLUMN_SEO_TITLE] = body.seoTitle;
    if (body.seoDescription !== undefined) updates[COLUMN_SEO_DESCRIPTION] = body.seoDescription;
    if (body.keywords !== undefined) updates[COLUMN_KEYWORDS] = body.keywords;
    if (body.status !== undefined) updates[COLUMN_STATUS] = body.status;
    if (body.scheduled_publish_at !== undefined) {
      updates[COLUMN_SCHEDULED_PUBLISH_AT] = body.scheduled_publish_at || null;
    }
    if (body.review_status !== undefined) updates.review_status = body.review_status;
    if (body.reviewed_at !== undefined) updates.reviewed_at = body.reviewed_at || new Date().toISOString();
    if (body.review_feedback !== undefined) updates.review_feedback = body.review_feedback;

    // Update post
    const { data: updatedPost, error: updateError } = await retryOperation(
      async () => {
        const result = await supabase
          .from(TABLE_BLOG_POSTS)
          .update(updates)
          .eq(COLUMN_ID, postId)
          .select()
          .single();

        if (result.error) {
          throw new SupabaseClientError('Failed to update post', result.error);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'update_post',
    );

    if (updateError || !updatedPost) {
      throw new UtilsError('Failed to update post', ERROR_CODE_INTERNAL_ERROR, STATUS_INTERNAL_ERROR);
    }

    logger.info('Post updated successfully', {
      correlationId,
      postId,
      storeId: ctx.storeId,
      updates: Object.keys(updates),
      warnings: warnings.length,
    });

    return createSuccessResponse(
      updatedPost,
      correlationId,
      {},
      { compression: true, request: req, warnings: warnings.length > 0 ? warnings : undefined },
    );
  } catch (error) {
    logger.error('Post update failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      storeId: ctx.storeId,
    });
    throw error;
  }
}

async function handleDeletePost(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;

  try {
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter((p) => p);
    const postId = pathParts[pathParts.length - 1];

    if (!postId) {
      return createErrorResponse(ERROR_POST_ID_REQUIRED, STATUS_BAD_REQUEST, correlationId);
    }

    // Fetch existing post to verify ownership
    const fetchResult = await fetchPost(supabase, postId);
    if (fetchResult.error || !fetchResult.data) {
      throw new UtilsError(ERROR_POST_NOT_FOUND, ERROR_CODE_POST_NOT_FOUND, STATUS_NOT_FOUND);
    }

    ctx.storeId = fetchResult.data[COLUMN_STORE_ID] as string;

    // Delete post
    const { error: deleteError } = await retryOperation(
      async () => {
        const result = await supabase
          .from(TABLE_BLOG_POSTS)
          .delete()
          .eq(COLUMN_ID, postId);

        if (result.error) {
          throw new SupabaseClientError('Failed to delete post', result.error);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'delete_post',
    );

    if (deleteError) {
      throw new UtilsError('Failed to delete post', ERROR_CODE_INTERNAL_ERROR, STATUS_INTERNAL_ERROR);
    }

    logger.info('Post deleted successfully', {
      correlationId,
      postId,
      storeId: ctx.storeId,
    });

    return createSuccessResponse(
      { success: true, postId },
      correlationId,
      {},
      { compression: true, request: req },
    );
  } catch (error) {
    logger.error('Post deletion failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      storeId: ctx.storeId,
    });
    throw error;
  }
}

async function handleSchedulePost(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;

  try {
    const url = new URL(req.url);
    const pathParts = url.pathname.split('/').filter((p) => p);
    const postId = pathParts[pathParts.length - 2]; // postId is before 'schedule' in path

    if (!postId) {
      return createErrorResponse(ERROR_POST_ID_REQUIRED, STATUS_BAD_REQUEST, correlationId);
    }

    const body = await req.json() as { scheduled_at: string };
    
    if (!body.scheduled_at) {
      return createErrorResponse('scheduled_at is required', STATUS_BAD_REQUEST, correlationId);
    }

    // Validate scheduled_at is a valid date in the future
    const scheduledDate = new Date(body.scheduled_at);
    if (isNaN(scheduledDate.getTime())) {
      return createErrorResponse('Invalid scheduled_at date format', STATUS_BAD_REQUEST, correlationId);
    }

    if (scheduledDate < new Date()) {
      return createErrorResponse('scheduled_at must be in the future', STATUS_BAD_REQUEST, correlationId);
    }

    // Fetch existing post to verify ownership
    const fetchResult = await fetchPost(supabase, postId);
    if (fetchResult.error || !fetchResult.data) {
      throw new UtilsError(ERROR_POST_NOT_FOUND, ERROR_CODE_POST_NOT_FOUND, STATUS_NOT_FOUND);
    }

    ctx.storeId = fetchResult.data[COLUMN_STORE_ID] as string;

    // Update post with scheduled date and status
    const updates: Record<string, unknown> = {
      [COLUMN_SCHEDULED_PUBLISH_AT]: scheduledDate.toISOString(),
      [COLUMN_STATUS]: 'scheduled',
      [COLUMN_UPDATED_AT]: new Date().toISOString(),
    };

    const { data: updatedPost, error: updateError } = await retryOperation(
      async () => {
        const result = await supabase
          .from(TABLE_BLOG_POSTS)
          .update(updates)
          .eq(COLUMN_ID, postId)
          .select()
          .single();

        if (result.error) {
          throw new SupabaseClientError('Failed to schedule post', result.error);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'schedule_post',
    );

    if (updateError || !updatedPost) {
      throw new UtilsError('Failed to schedule post', ERROR_CODE_INTERNAL_ERROR, STATUS_INTERNAL_ERROR);
    }

    logger.info('Post scheduled successfully', {
      correlationId,
      postId,
      storeId: ctx.storeId,
      scheduledAt: body.scheduled_at,
    });

    return createSuccessResponse(
      updatedPost,
      correlationId,
      {},
      { compression: true, request: req },
    );
  } catch (error) {
    logger.error('Post scheduling failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      storeId: ctx.storeId,
    });
    throw error;
  }
}

async function routeRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathParts = url.pathname.split('/').filter((p) => p);
  const lastPart = pathParts[pathParts.length - 1];
  const method = req.method;

  // Check if this is a schedule request: /posts-api/{postId}/schedule
  if (lastPart === 'schedule' && method === METHOD_POST) {
    const config: EndpointConfig = {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_MAX_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS },
      timeout: CONFIG.DEFAULT_TIMEOUT,
      maxRequestSize: CONFIG.MAX_REQUEST_SIZE,
    };
    return await handleRequest(req, handleSchedulePost, config);
  }

  if (method === METHOD_PATCH) {
    const config: EndpointConfig = {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_MAX_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS },
      timeout: CONFIG.DEFAULT_TIMEOUT,
      validateInput: validatePostUpdateParams,
      maxRequestSize: CONFIG.MAX_REQUEST_SIZE,
    };

    return await handleRequest(req, handleUpdatePost, config);
  } else if (method === METHOD_DELETE) {
    const config: EndpointConfig = {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_MAX_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS },
      timeout: CONFIG.DEFAULT_TIMEOUT,
    };

    return await handleRequest(req, handleDeletePost, config);
  } else {
    const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
    return createErrorResponse('Method not allowed', STATUS_BAD_REQUEST, correlationId);
  }
}

serve(async (req: Request) => {
  if (req.method === METHOD_OPTIONS) {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    return await routeRequest(req);
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
