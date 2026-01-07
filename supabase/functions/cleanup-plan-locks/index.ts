import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import {
  getSupabaseClient,
  logger,
  createCORSHeaders,
  UtilsError,
  SupabaseClientError,
} from '../_shared/utils.ts';

interface CleanupResponse {
  readonly success: boolean;
  readonly deletedCount: number;
  readonly correlationId: string;
}

interface ErrorResponse {
  readonly error: string;
  readonly correlationId: string;
  readonly details?: string;
}

const METHOD_POST = 'POST' as const;
const METHOD_OPTIONS = 'OPTIONS' as const;
const STATUS_OK = 200;
const STATUS_METHOD_NOT_ALLOWED = 405;
const STATUS_INTERNAL_ERROR = 500;
const HEADER_CONTENT_TYPE = 'Content-Type';
const HEADER_CONTENT_TYPE_JSON = 'application/json';
const HEADER_X_CORRELATION_ID = 'x-correlation-id';
const RPC_CLEANUP_EXPIRED_LOCKS = 'cleanup_expired_locks' as const;
const CORRELATION_PREFIX = 'cleanup-';
const ID_RADIX = 36;
const ID_LENGTH = 9;

function generateCorrelationId(): string {
  return `${CORRELATION_PREFIX}${Date.now()}-${Math.random().toString(ID_RADIX).substring(2, 2 + ID_LENGTH)}`;
}

function createSuccessResponse(
  deletedCount: number,
  correlationId: string,
  request: Request,
): Response {
  const response: CleanupResponse = {
    success: true,
    deletedCount,
    correlationId,
  };

  const corsHeaders = createCORSHeaders(request, '*');

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
  details?: string,
  request?: Request,
): Response {
  const response: ErrorResponse = {
    error,
    correlationId,
    ...(details && { details }),
  };

  const corsHeaders = request ? createCORSHeaders(request, '*') : createCORSHeaders({ headers: new Headers() } as Request, '*');

  return new Response(JSON.stringify(response), {
    status,
    headers: {
      ...corsHeaders,
      [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON,
      [HEADER_X_CORRELATION_ID]: correlationId,
    },
  });
}

async function handleCleanup(correlationId: string): Promise<Response> {
  const startTime = performance.now();

  try {
    const supabase = await getSupabaseClient({ clientType: 'service' });

    const { data, error } = await supabase.rpc(RPC_CLEANUP_EXPIRED_LOCKS);

    if (error) {
      logger.error('Failed to cleanup expired locks', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        errorCode: (error as { code?: string })?.code,
        errorDetails: (error as { details?: string })?.details,
      });
      throw new SupabaseClientError('Failed to cleanup expired locks', {
        error: error instanceof Error ? error.message : String(error),
        errorCode: (error as { code?: string })?.code,
      });
    }

    const deletedCount = (typeof data === 'number' ? data : 0) as number;

    const duration = performance.now() - startTime;
    logger.info('Cleaned up expired locks', {
      correlationId,
      deletedCount,
      duration,
    });

    return createSuccessResponse(deletedCount, correlationId, { headers: new Headers() } as Request);
  } catch (error) {
    const duration = performance.now() - startTime;
    logger.error('Cleanup job failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      duration,
    });

    if (error instanceof UtilsError) {
      return createErrorResponse(
        error.message,
        error.statusCode,
        correlationId,
        error.details ? JSON.stringify(error.details) : undefined,
        { headers: new Headers() } as Request,
      );
    }

    return createErrorResponse(
      'Internal server error',
      STATUS_INTERNAL_ERROR,
      correlationId,
      error instanceof Error ? error.message : String(error),
      { headers: new Headers() } as Request,
    );
  }
}

serve(async (req: Request) => {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();

  if (req.method === METHOD_OPTIONS) {
    return new Response('ok', { headers: createCORSHeaders(req, '*') });
  }

  if (req.method !== METHOD_POST) {
    return createErrorResponse(
      'Method not allowed',
      STATUS_METHOD_NOT_ALLOWED,
      correlationId,
      undefined,
      req,
    );
  }

  return await handleCleanup(correlationId);
});
