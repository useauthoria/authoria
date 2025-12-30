import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import {
  getSupabaseClient,
  createCompressedResponse,
  acceptsCompression,
  logger,
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

interface ProcessScheduledPostsRequest extends Request {
  readonly correlationId?: string;
  readonly startTime?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface ProcessScheduledPostsResponse {
  readonly data?: unknown;
  readonly error?: string;
  readonly correlationId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface RequestContext {
  readonly req: ProcessScheduledPostsRequest;
  readonly supabase: ReturnType<typeof getSupabaseClient>;
  readonly correlationId: string;
  readonly startTime: number;
}

interface EndpointConfig {
  readonly requiresAuth?: boolean;
  readonly compression?: boolean;
  readonly timeout?: number;
}

const ENV_SUPABASE_URL = 'SUPABASE_URL';
const ENV_SUPABASE_SERVICE_ROLE_KEY = 'SUPABASE_SERVICE_ROLE_KEY';
const ENV_OPENAI_API_KEY = 'OPENAI_API_KEY';
const ENV_ADMIN_API_KEY = 'ADMIN_API_KEY';
const DEFAULT_TIMEOUT = 300000;
const MIN_TOKEN_LENGTH = 20;
const BEARER_PREFIX = 'Bearer ';
const BEARER_PREFIX_LENGTH = 7;
const ID_RADIX = 36;
const ID_LENGTH = 9;
const CORRELATION_PREFIX = 'process-scheduled-';
const METHOD_POST = 'POST';
const METHOD_OPTIONS = 'OPTIONS';
const STATUS_OK = 200;
const STATUS_UNAUTHORIZED = 401;
const STATUS_REQUEST_TIMEOUT = 408;
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
const CORS_METHODS_VALUE = 'POST, OPTIONS';
const CORS_MAX_AGE_VALUE = '86400';
const ENCODING_NONE = 'none';
const ERROR_UNAUTHORIZED = 'Unauthorized';
const ERROR_MISSING_ENV = 'Missing environment variables';
const ERROR_MISSING_AUTHORIZATION = 'Missing authorization header';
const ERROR_INVALID_AUTHORIZATION = 'Invalid authorization';
const ERROR_REQUEST_TIMEOUT = 'Request timeout';
const ERROR_INTERNAL_SERVER = 'Internal server error';
const ERROR_CODE_UNAUTHORIZED = 'UNAUTHORIZED';
const ERROR_CODE_CONFIG_ERROR = 'CONFIG_ERROR';
const ERROR_CODE_INTERNAL_ERROR = 'INTERNAL_ERROR';
const TABLE_POSTS_SCHEDULE = 'posts_schedule';
const COLUMN_ID = 'id';
const COLUMN_STATUS = 'status';
const COLUMN_SCHEDULED_AT = 'scheduled_at';
const STATUS_PENDING = 'pending';
const STATUS_PROCESSING = 'processing';
const STATUS_FAILED = 'failed';
const PROCESSING_BATCH_SIZE = 50;
const PROCESSING_CONCURRENCY = 3;

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
  SUPABASE_SERVICE_ROLE_KEY: getEnv(ENV_SUPABASE_SERVICE_ROLE_KEY, ''),
  OPENAI_API_KEY: getEnv(ENV_OPENAI_API_KEY, ''),
  ADMIN_API_KEY: getEnv(ENV_ADMIN_API_KEY, ''),
  DEFAULT_TIMEOUT: parseInt(getEnv('PROCESS_SCHEDULED_POSTS_TIMEOUT', String(DEFAULT_TIMEOUT))),
};

const corsHeaders: Readonly<Record<string, string>> = {
  [HEADER_ACCESS_CONTROL_ALLOW_ORIGIN]: '*',
  [HEADER_ACCESS_CONTROL_ALLOW_HEADERS]: CORS_HEADERS_VALUE,
  [HEADER_ACCESS_CONTROL_ALLOW_METHODS]: CORS_METHODS_VALUE,
  [HEADER_ACCESS_CONTROL_MAX_AGE]: CORS_MAX_AGE_VALUE,
};

async function validateAuth(authHeader: string | null): Promise<{ readonly valid: boolean; readonly error?: string }> {
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

async function createRequestContext(req: Request): Promise<RequestContext> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  const authHeader = req.headers.get(HEADER_AUTHORIZATION);
  const authResult = await validateAuth(authHeader);

  if (!authResult.valid) {
    throw new UtilsError(authResult.error ?? ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED, STATUS_UNAUTHORIZED);
  }

  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_SERVICE_ROLE_KEY) {
    throw new UtilsError(ERROR_MISSING_ENV, ERROR_CODE_CONFIG_ERROR, STATUS_INTERNAL_ERROR);
  }

  const supabase = await getSupabaseClient({ clientType: 'service' });

  return {
    req: req as ProcessScheduledPostsRequest,
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
    const ctx = await createRequestContext(req);
    correlationId = ctx.correlationId;

    const timeout = config.timeout ?? CONFIG.DEFAULT_TIMEOUT;
    const timeoutPromise = new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(createErrorResponse(ERROR_REQUEST_TIMEOUT, STATUS_REQUEST_TIMEOUT, correlationId));
      }, timeout);
    });

    const handlerPromise = handler(ctx);
    const response = await Promise.race([handlerPromise, timeoutPromise]);

    const headers = new Headers(response.headers);
    headers.set(HEADER_X_CORRELATION_ID, correlationId);
    headers.set(HEADER_X_RESPONSE_TIME, `${(performance.now() - startTime).toFixed(2)}ms`);

    logger.info('Request completed', {
      correlationId,
      method: req.method,
      path: new URL(req.url).pathname,
      status: response.status,
      duration: performance.now() - startTime,
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
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
  const response: ProcessScheduledPostsResponse = {
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
  const response: ProcessScheduledPostsResponse = {
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

async function handleProcessScheduledPosts(ctx: RequestContext): Promise<Response> {
  const { supabase, correlationId } = ctx;

  try {
    const now = new Date();
    
    // Fetch due posts
    const { data: duePosts, error: fetchError } = await supabase
      .from(TABLE_POSTS_SCHEDULE)
      .select('*, blog_posts(*), stores(*)')
      .eq(COLUMN_STATUS, STATUS_PENDING)
      .lte(COLUMN_SCHEDULED_AT, now.toISOString())
      .order('priority', { ascending: false })
      .order(COLUMN_SCHEDULED_AT, { ascending: true })
      .limit(PROCESSING_BATCH_SIZE);

    if (fetchError) {
      throw new SupabaseClientError('Failed to fetch scheduled posts', fetchError);
    }

    if (!duePosts || duePosts.length === 0) {
      return createSuccessResponse(
        { processed: 0, successful: 0, failed: 0 },
        correlationId,
        {},
        { compression: true, request: ctx.req },
      );
    }

    // Import Scheduler
    const { Scheduler } = await import('../backend/src/core/Scheduler.ts');
    const scheduler = new Scheduler(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_SERVICE_ROLE_KEY,
      CONFIG.OPENAI_API_KEY,
    );

    // Process posts in batches
    let processed = 0;
    let successful = 0;
    let failed = 0;

    for (let i = 0; i < duePosts.length; i += PROCESSING_CONCURRENCY) {
      const batch = duePosts.slice(i, i + PROCESSING_CONCURRENCY);
      
      const results = await Promise.allSettled(
        batch.map(async (scheduleRow) => {
          try {
            // Mark as processing
            await supabase
              .from(TABLE_POSTS_SCHEDULE)
              .update({ [COLUMN_STATUS]: STATUS_PROCESSING })
              .eq(COLUMN_ID, scheduleRow.id);

            // Process the post
            await scheduler.processScheduledPosts();

            processed++;
            successful++;
          } catch (error) {
            // Mark as failed
            await supabase
              .from(TABLE_POSTS_SCHEDULE)
              .update({
                [COLUMN_STATUS]: STATUS_FAILED,
                error_message: error instanceof Error ? error.message : String(error),
              })
              .eq(COLUMN_ID, scheduleRow.id);

            processed++;
            failed++;
            throw error;
          }
        }),
      );

      // Count results
      results.forEach((result) => {
        if (result.status === 'rejected') {
          failed++;
        }
      });
    }

    logger.info('Scheduled posts processed', {
      correlationId,
      total: duePosts.length,
      processed,
      successful,
      failed,
    });

    return createSuccessResponse(
      { processed, successful, failed, total: duePosts.length },
      correlationId,
      {},
      { compression: true, request: ctx.req },
    );
  } catch (error) {
    logger.error('Failed to process scheduled posts', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

serve(async (req: Request) => {
  if (req.method === METHOD_OPTIONS) {
    return new Response('ok', { headers: corsHeaders });
  }

  const config: EndpointConfig = {
    requiresAuth: true,
    compression: true,
    timeout: CONFIG.DEFAULT_TIMEOUT,
  };

  try {
    return await handleRequest(req, handleProcessScheduledPosts, config);
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

