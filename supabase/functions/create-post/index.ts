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
import type { BlogPostContent } from '../../../backend/src/core/BlogComposer.ts';

interface DenoEnv {
  readonly get?: (key: string) => string | undefined;
}

interface DenoGlobal {
  readonly Deno?: {
    readonly env?: DenoEnv;
  };
}

interface CreatePostRequest extends Request {
  readonly correlationId?: string;
  readonly userId?: string;
  readonly storeId?: string;
  readonly startTime?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface CreatePostResponse {
  readonly data?: unknown;
  readonly error?: string;
  readonly correlationId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly warnings?: ReadonlyArray<string>;
}

interface RequestContext {
  readonly req: CreatePostRequest;
  readonly supabase: ReturnType<typeof getSupabaseClient>;
  readonly correlationId: string;
  readonly userId?: string;
  storeId?: string;
  readonly startTime: number;
}

interface PostCreationParams {
  readonly storeId: string;
  readonly topic: string;
  readonly keywords?: ReadonlyArray<string>;
  readonly products?: ReadonlyArray<string>;
  readonly structure?: string;
  readonly language?: string;
  readonly experienceLevel?: string;
  readonly audiencePersona?: string;
  readonly includeCitations?: boolean;
  readonly validateQuality?: boolean;
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

interface DatabaseStore {
  readonly id: string;
  readonly plan_id?: string | null;
  readonly tone_matrix?: Readonly<Record<string, number>> | null;
  readonly brand_dna?: Readonly<Record<string, unknown>> | null;
  readonly is_active: boolean;
  readonly shop_domain: string;
  readonly access_token: string;
}

interface DatabasePost {
  readonly id: string;
  readonly [key: string]: unknown;
}


interface PostCreationBody {
  readonly storeId?: string;
  readonly topic?: string;
  readonly keywords?: ReadonlyArray<string>;
  readonly products?: ReadonlyArray<string>;
  readonly structure?: string;
  readonly language?: string;
  readonly experienceLevel?: string;
  readonly audiencePersona?: string;
  readonly includeCitations?: boolean;
  readonly validateQuality?: boolean;
  readonly regenerateFrom?: string; // Post ID to regenerate from
}

const ENV_SUPABASE_URL = 'SUPABASE_URL';
const ENV_SUPABASE_ANON_KEY = 'SUPABASE_ANON_KEY';
const ENV_OPENAI_API_KEY = 'OPENAI_API_KEY';
const ENV_FLUX_API_KEY = 'FLUX_API_KEY';
const ENV_CREATE_POST_TIMEOUT = 'CREATE_POST_TIMEOUT';
const ENV_CORS_ORIGINS = 'CORS_ORIGINS';
const ENV_MAX_REQUEST_SIZE = 'MAX_REQUEST_SIZE';
const ENV_ENABLE_RETRY = 'ENABLE_RETRY';
const ENV_MAX_RETRIES = 'MAX_RETRIES';
const ENV_RETRY_DELAY_MS = 'RETRY_DELAY_MS';
const ENV_ENABLE_IMAGE_GENERATION = 'ENABLE_IMAGE_GENERATION';
const ENV_ENABLE_LLM_SNIPPETS = 'ENABLE_LLM_SNIPPETS';
const ENV_ENABLE_SEO_OPTIMIZATION = 'ENABLE_SEO_OPTIMIZATION';
const ENV_ENABLE_PRODUCT_MENTIONS = 'ENABLE_PRODUCT_MENTIONS';
const ENV_ENABLE_INTERNAL_LINKS = 'ENABLE_INTERNAL_LINKS';
const DEFAULT_TIMEOUT = 300000;
const DEFAULT_MAX_REQUEST_SIZE = 10485760;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_LANGUAGE = 'en';
const MAX_KEYWORDS = 50;
const MAX_TOPIC_LENGTH = 500;
const MIN_TOKEN_LENGTH = 10;
const BEARER_PREFIX = 'Bearer ';
const BEARER_PREFIX_LENGTH = 7;
const ID_RADIX = 36;
const ID_LENGTH = 9;
const CORRELATION_PREFIX = 'create-post-';
const METHOD_POST = 'POST';
const METHOD_OPTIONS = 'OPTIONS';
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;
const STATUS_REQUEST_TIMEOUT = 408;
const STATUS_PAYLOAD_TOO_LARGE = 413;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_INTERNAL_ERROR = 500;
const STATUS_NOT_FOUND = 404;
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
const CORS_METHODS_VALUE = 'POST, OPTIONS';
const CORS_MAX_AGE_VALUE = '86400';
const ENCODING_NONE = 'none';
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
const ERROR_INVALID_JSON = 'Invalid JSON in request body';
const ERROR_INTERNAL_SERVER = 'Internal server error';
const ERROR_STORE_NOT_FOUND = 'Store not found';
const ERROR_STORE_NOT_ACTIVE = 'Store is not active';
const ERROR_QUOTA_EXCEEDED = 'Article quota exceeded';
const ERROR_OPENAI_NOT_CONFIGURED = 'OPENAI_API_KEY not configured';
const ERROR_STORE_ID_REQUIRED = 'storeId is required and must be a string';
const ERROR_TOPIC_REQUIRED = 'topic is required and must be a non-empty string';
const ERROR_TOPIC_TOO_LONG = 'topic must be less than 500 characters';
const ERROR_KEYWORDS_MUST_BE_ARRAY = 'keywords must be an array';
const ERROR_PRODUCTS_MUST_BE_ARRAY = 'products must be an array';
const ERROR_LANGUAGE_MUST_BE_STRING = 'language must be a string';
const ERROR_STRUCTURE_MUST_BE_STRING = 'structure must be a string';
const ERROR_EXPERIENCE_LEVEL_MUST_BE_STRING = 'experienceLevel must be a string';
const ERROR_AUDIENCE_PERSONA_MUST_BE_STRING = 'audiencePersona must be a string';
const ERROR_INCLUDE_CITATIONS_MUST_BE_BOOLEAN = 'includeCitations must be a boolean';
const ERROR_VALIDATE_QUALITY_MUST_BE_BOOLEAN = 'validateQuality must be a boolean';
const WARNING_TOO_MANY_KEYWORDS = 'Too many keywords provided, only first 50 will be used';
const WARNING_KEYWORD_MINING_FAILED = 'Keyword mining failed, proceeding without keywords';
const WARNING_IMAGE_CDN_UPLOAD_FAILED = 'Image CDN upload failed, using original URL';
const WARNING_IMAGE_GENERATION_FAILED = 'Image generation failed, continuing without image';
const WARNING_LLM_SNIPPET_ENQUEUE_FAILED = 'LLM snippet generation job enqueue failed';
const ERROR_CODE_UNAUTHORIZED = 'UNAUTHORIZED';
const ERROR_CODE_CONFIG_ERROR = 'CONFIG_ERROR';
const ERROR_CODE_STORE_NOT_FOUND = 'STORE_NOT_FOUND';
const ERROR_CODE_INTERNAL_ERROR = 'INTERNAL_ERROR';
const RETRY_BACKOFF_BASE = 2;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const DEFAULT_TONE_MATRIX: Readonly<Record<string, number>> = {
  expert: 0.3,
  conversational: 0.3,
  aspirational: 0.2,
  friendly: 0.2,
};
const IMAGE_WIDTH = 1280;
const IMAGE_HEIGHT = 720;
const IMAGE_FORMAT = 'webp';
const IMAGE_QUALITY = 85;
const JOB_PRIORITY_NORMAL = 'normal';
const JOB_MAX_ATTEMPTS = 3;
const TABLE_STORES = 'stores';
const TABLE_BLOG_POSTS = 'blog_posts';
const COLUMN_ID = 'id';
const COLUMN_PLAN_ID = 'plan_id';
const COLUMN_TONE_MATRIX = 'tone_matrix';
const COLUMN_BRAND_DNA = 'brand_dna';
const COLUMN_IS_ACTIVE = 'is_active';
const COLUMN_SHOP_DOMAIN = 'shop_domain';
const COLUMN_ACCESS_TOKEN = 'access_token';
const COLUMN_STORE_ID = 'store_id';
const COLUMN_TITLE = 'title';
const COLUMN_CONTENT = 'content';
const COLUMN_EXCERPT = 'excerpt';
const COLUMN_SEO_TITLE = 'seo_title';
const COLUMN_SEO_DESCRIPTION = 'seo_description';
const COLUMN_KEYWORDS = 'keywords';
const COLUMN_PRIMARY_KEYWORD = 'primary_keyword';
const COLUMN_STATUS = 'status';
const COLUMN_PRODUCT_MENTIONS = 'product_mentions';
const COLUMN_FEATURED_IMAGE_URL = 'featured_image_url';
const COLUMN_STRUCTURED_DATA = 'structured_data';
const STATUS_DRAFT = 'draft';
const JOB_TYPE_LLM_SNIPPET = 'llm_snippet';

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
  OPENAI_API_KEY: getEnv(ENV_OPENAI_API_KEY, ''),
  FLUX_API_KEY: getEnv(ENV_FLUX_API_KEY, ''),
  DEFAULT_TIMEOUT: parseInt(getEnv(ENV_CREATE_POST_TIMEOUT, String(DEFAULT_TIMEOUT))),
  ENABLE_AUDIT_LOGGING: true,
  ENABLE_METRICS: true,
  CORS_ORIGINS: getEnv(ENV_CORS_ORIGINS, '*').split(','),
  MAX_REQUEST_SIZE: parseInt(getEnv(ENV_MAX_REQUEST_SIZE, String(DEFAULT_MAX_REQUEST_SIZE))),
  ENABLE_RETRY: getEnv(ENV_ENABLE_RETRY, 'true') !== 'false',
  MAX_RETRIES: parseInt(getEnv(ENV_MAX_RETRIES, String(DEFAULT_MAX_RETRIES))),
  RETRY_DELAY_MS: parseInt(getEnv(ENV_RETRY_DELAY_MS, String(DEFAULT_RETRY_DELAY_MS))),
  ENABLE_IMAGE_GENERATION: getEnv(ENV_ENABLE_IMAGE_GENERATION, 'true') !== 'false',
  ENABLE_LLM_SNIPPETS: getEnv(ENV_ENABLE_LLM_SNIPPETS, 'true') !== 'false',
  ENABLE_SEO_OPTIMIZATION: getEnv(ENV_ENABLE_SEO_OPTIMIZATION, 'true') !== 'false',
  ENABLE_PRODUCT_MENTIONS: getEnv(ENV_ENABLE_PRODUCT_MENTIONS, 'true') !== 'false',
  ENABLE_INTERNAL_LINKS: getEnv(ENV_ENABLE_INTERNAL_LINKS, 'true') !== 'false',
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
      return { valid: true, userId: AUTHENTICATED_USER };
    }
  }

  return { valid: false, error: ERROR_INVALID_AUTHORIZATION };
}

function validatePostCreationParams(params: Readonly<Record<string, unknown>>): ValidationResult {
  const warnings: string[] = [];

  if (!params.storeId || typeof params.storeId !== 'string') {
    return { valid: false, error: ERROR_STORE_ID_REQUIRED };
  }

  if (!params.topic || typeof params.topic !== 'string' || params.topic.trim().length === 0) {
    return { valid: false, error: ERROR_TOPIC_REQUIRED };
  }

  if (params.topic.length > MAX_TOPIC_LENGTH) {
    return { valid: false, error: ERROR_TOPIC_TOO_LONG };
  }

  if (params.keywords !== undefined && !Array.isArray(params.keywords)) {
    return { valid: false, error: ERROR_KEYWORDS_MUST_BE_ARRAY };
  }

  if (params.keywords && Array.isArray(params.keywords) && params.keywords.length > MAX_KEYWORDS) {
    warnings.push(WARNING_TOO_MANY_KEYWORDS);
  }

  if (params.products !== undefined && !Array.isArray(params.products)) {
    return { valid: false, error: ERROR_PRODUCTS_MUST_BE_ARRAY };
  }

  if (params.language !== undefined && typeof params.language !== 'string') {
    return { valid: false, error: ERROR_LANGUAGE_MUST_BE_STRING };
  }

  if (params.structure !== undefined && typeof params.structure !== 'string') {
    return { valid: false, error: ERROR_STRUCTURE_MUST_BE_STRING };
  }

  if (params.experienceLevel !== undefined && typeof params.experienceLevel !== 'string') {
    return { valid: false, error: ERROR_EXPERIENCE_LEVEL_MUST_BE_STRING };
  }

  if (params.audiencePersona !== undefined && typeof params.audiencePersona !== 'string') {
    return { valid: false, error: ERROR_AUDIENCE_PERSONA_MUST_BE_STRING };
  }

  if (params.includeCitations !== undefined && typeof params.includeCitations !== 'boolean') {
    return { valid: false, error: ERROR_INCLUDE_CITATIONS_MUST_BE_BOOLEAN };
  }

  if (params.validateQuality !== undefined && typeof params.validateQuality !== 'boolean') {
    return { valid: false, error: ERROR_VALIDATE_QUALITY_MUST_BE_BOOLEAN };
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
    req: req as CreatePostRequest,
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
      const rateLimitKey = `create-post:${ctx.userId ?? ANONYMOUS_USER}:${ctx.storeId ?? NO_STORE}`;
      const rateLimit = checkRateLimit(rateLimitKey, config.rateLimit.maxRequests, config.rateLimit.windowMs);

      if (!rateLimit.allowed) {
        logger.warn('Rate limit exceeded', { correlationId, rateLimitKey, remaining: rateLimit.remaining });
        return createErrorResponse(ERROR_RATE_LIMIT_EXCEEDED, STATUS_TOO_MANY_REQUESTS, correlationId, {
          retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
        });
      }
    }

    if (config.validateInput && req.method === METHOD_POST) {
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
    );
  }
}

async function createSuccessResponse(
  data: unknown,
  correlationId: string,
  metadata?: Readonly<Record<string, unknown>>,
  options: { readonly compression?: boolean; readonly request?: Request; readonly warnings?: ReadonlyArray<string> } = {},
): Promise<Response> {
  const response: CreatePostResponse = {
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
  const response: CreatePostResponse = {
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

async function handleCreatePost(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  const warnings: string[] = [];

  try {
    const body = await req.json() as PostCreationBody;
    const validation = validatePostCreationParams(body);

    if (!validation.valid) {
      return createErrorResponse(validation.error ?? ERROR_INVALID_INPUT, STATUS_BAD_REQUEST, correlationId);
    }

    if (validation.warnings) {
      warnings.push(...validation.warnings);
    }

    const params: PostCreationParams = {
      storeId: body.storeId!,
      topic: body.topic!.trim(),
      keywords: body.keywords?.slice(0, MAX_KEYWORDS) ?? [],
      products: body.products ?? [],
      structure: body.structure,
      language: body.language ?? DEFAULT_LANGUAGE,
      experienceLevel: body.experienceLevel,
      audiencePersona: body.audiencePersona,
      includeCitations: body.includeCitations !== false,
      validateQuality: body.validateQuality !== false,
    };

    ctx.storeId = params.storeId;

    // Check regeneration limits if this is a regeneration
    if (body.regenerateFrom) {
      const { data: limitCheck, error: limitError } = await supabase
        .rpc('check_regeneration_limits', {
          store_uuid: params.storeId,
          post_uuid: body.regenerateFrom,
          regenerated_from_uuid: body.regenerateFrom,
        });

      if (limitError) {
        throw new UtilsError(
          `Failed to check regeneration limits: ${limitError.message}`,
          ERROR_CODE_INTERNAL_ERROR,
          STATUS_INTERNAL_ERROR,
        );
      }

      const limitResult = limitCheck as { allowed: boolean; reason?: string; limit_type?: string } | null;
      if (!limitResult || !limitResult.allowed) {
        return createErrorResponse(
          limitResult?.reason ?? 'Regeneration limit reached',
          STATUS_BAD_REQUEST,
          correlationId,
          { limitType: limitResult?.limit_type },
        );
      }
    }

    const { data: store, error: storeError } = await retryOperation(
      async () => {
        const result = await supabase
          .from(TABLE_STORES)
          .select(`${COLUMN_ID}, ${COLUMN_PLAN_ID}, ${COLUMN_TONE_MATRIX}, ${COLUMN_BRAND_DNA}, ${COLUMN_IS_ACTIVE}, ${COLUMN_SHOP_DOMAIN}, ${COLUMN_ACCESS_TOKEN}, content_preferences`)
          .eq(COLUMN_ID, params.storeId)
          .single();

        if (result.error) {
          throw new SupabaseClientError('Failed to fetch store', result.error);
        }
        if (!result.data) {
          throw new UtilsError(ERROR_STORE_NOT_FOUND, ERROR_CODE_STORE_NOT_FOUND, STATUS_NOT_FOUND);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'fetch_store',
    );

    if (storeError || !store) {
      throw new UtilsError(ERROR_STORE_NOT_FOUND, ERROR_CODE_STORE_NOT_FOUND, STATUS_NOT_FOUND);
    }

    const storeData = store as unknown as DatabaseStore & {
      content_preferences?: {
        topic_preferences?: string[];
        keyword_focus?: string[];
        content_angles?: string[];
      };
    };

    if (!storeData.is_active) {
      return createErrorResponse(ERROR_STORE_NOT_ACTIVE, STATUS_FORBIDDEN, correlationId);
    }

    // Extract content preferences from store settings
    const contentPreferences = storeData.content_preferences || {};

    // Check plan limits using enterprise-grade PlanTrialManager with distributed locking
    const { PlanTrialManager } = await import('../../../backend/src/core/PlanTrialManager.ts');
    const planTrialManager = new PlanTrialManager(supabase);

    const enforcementResult = await retryOperation(
      async () => {
        return await planTrialManager.enforceQuotaWithLock(params.storeId, 'create_article', correlationId);
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'enforce_plan_limits',
    );

    if (!enforcementResult.allowed) {
      return createErrorResponse(
        enforcementResult.reason || ERROR_QUOTA_EXCEEDED,
        STATUS_FORBIDDEN,
        correlationId,
        {
          quotaStatus: enforcementResult.quotaStatus,
          trialStatus: enforcementResult.trialStatus,
        },
      );
    }

    const { GDPRDataGuard } = await import('../../../backend/src/core/GDPRDataGuard.ts');
    const gdprGuard = new GDPRDataGuard(supabase);

    if (!CONFIG.OPENAI_API_KEY) {
      throw new UtilsError(ERROR_OPENAI_NOT_CONFIGURED, ERROR_CODE_CONFIG_ERROR, STATUS_INTERNAL_ERROR);
    }

    const toneMatrix = (storeData.tone_matrix as Readonly<Record<string, number>> | null) ?? DEFAULT_TONE_MATRIX;

    const { BlogComposer } = await import('../../../backend/src/core/BlogComposer.ts');
    const { KeywordMiner } = await import('../../../backend/src/core/KeywordMiner.ts');
    const blogComposer = new BlogComposer(CONFIG.OPENAI_API_KEY, toneMatrix, storeData.brand_dna ?? {});
    const keywordMiner = new KeywordMiner(CONFIG.OPENAI_API_KEY);


    // Merge user-provided keywords with keyword_focus from content preferences
    let finalKeywords = params.keywords.length > 0 ? [...params.keywords] : [];
    
    // Add keyword_focus from content preferences if available
    if (contentPreferences.keyword_focus && contentPreferences.keyword_focus.length > 0) {
      finalKeywords = [...finalKeywords, ...contentPreferences.keyword_focus];
      // Remove duplicates
      finalKeywords = Array.from(new Set(finalKeywords));
    }
    
    if (finalKeywords.length === 0) {
      try {
        const keywordCluster = await retryOperation(
          async () => await keywordMiner.mineKeywords(params.topic),
          CONFIG.MAX_RETRIES,
          CONFIG.RETRY_DELAY_MS,
          'mine_keywords',
        );
        finalKeywords = [
          keywordCluster.primaryKeyword.keyword,
          ...keywordCluster.longTailKeywords.map((k) => k.keyword),
        ];
      } catch (error) {
        logger.error('Keyword mining failed', {
          correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
        warnings.push(WARNING_KEYWORD_MINING_FAILED);
      }
    }

    const sanitizedTopic = await retryOperation(
      async () => await gdprGuard.sanitizeContent(params.topic, params.storeId, undefined, 'content_generation'),
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'sanitize_topic',
    );

    const sanitizedKeywords = await Promise.all(
      finalKeywords.map((kw) =>
        retryOperation(
          async () => {
            const result = await gdprGuard.sanitizeContent(kw, params.storeId, undefined, 'keyword_research');
            return result.sanitizedContent;
          },
          CONFIG.MAX_RETRIES,
          CONFIG.RETRY_DELAY_MS,
          'sanitize_keyword',
        ),
      ),
    );
    const cleanKeywords = sanitizedKeywords;

    const postContent = await retryOperation(
      async () =>
        await blogComposer.composePost(sanitizedTopic.sanitizedContent, cleanKeywords, {
          structure: params.structure as 'default' | 'how-to' | 'listicle' | 'comparison' | 'tutorial' | 'case-study' | undefined,
          language: params.language,
          experienceLevel: params.experienceLevel as 'beginner' | 'intermediate' | 'advanced' | undefined,
          audiencePersona: params.audiencePersona,
          includeCitations: params.includeCitations,
          validateQuality: params.validateQuality,
          contentPreferences: {
            topic_preferences: contentPreferences.topic_preferences,
            keyword_focus: contentPreferences.keyword_focus,
            content_angles: contentPreferences.content_angles,
          },
        }),
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'compose_post',
    );

    // Apply SEO optimization and analysis
    let seoOptimizedContent = postContent.content;
    let seoMetadata: Readonly<Record<string, unknown>> | undefined;
    if (CONFIG.ENABLE_SEO_OPTIMIZATION) {
      try {
        const { SEOOptimizer } = await import('../../../backend/src/core/SEOOptimizer.ts');
        const { ContentGraph } = await import('../../../backend/src/core/ContentGraph.ts');
        const contentGraph = new ContentGraph(supabase, CONFIG.OPENAI_API_KEY);
        const seoOptimizer = new SEOOptimizer(CONFIG.OPENAI_API_KEY, supabase, contentGraph, storeData.shop_domain);
        
        // Calculate SEO health score and get recommendations
        const [seoHealthScore, keywordAnalysis, structuredData] = await Promise.all([
          retryOperation(
            async () => await seoOptimizer.calculateSEOHealthScore({
              title: postContent.title,
              content: postContent.content,
              metaDescription: postContent.seoDescription,
              keywords: cleanKeywords,
              primaryKeyword: postContent.primaryKeyword,
            }),
            CONFIG.MAX_RETRIES,
            CONFIG.RETRY_DELAY_MS,
            'calculate_seo_health',
          ),
          retryOperation(
            async () => await seoOptimizer.analyzeKeywords(postContent.content, cleanKeywords),
            CONFIG.MAX_RETRIES,
            CONFIG.RETRY_DELAY_MS,
            'analyze_keywords',
          ),
          retryOperation(
            async () => await seoOptimizer.generateStructuredData({
              title: postContent.title,
              content: postContent.content,
              excerpt: postContent.excerpt,
              keywords: cleanKeywords,
            }),
            CONFIG.MAX_RETRIES,
            CONFIG.RETRY_DELAY_MS,
            'generate_structured_data',
          ),
        ]);

        seoMetadata = {
          seoHealthScore,
          keywordAnalysis,
          structuredData,
        };
      } catch (seoError) {
        logger.warn('SEO optimization failed, using original content', {
          correlationId,
          error: seoError instanceof Error ? seoError.message : String(seoError),
        });
        warnings.push('SEO optimization failed, using original content');
      }
    }

    // Inject product mentions if products are provided
    let finalContent = seoOptimizedContent;
    let productMentions: ReadonlyArray<unknown> | undefined;
    if (params.products && params.products.length > 0 && CONFIG.ENABLE_PRODUCT_MENTIONS) {
      try {
        const { ProductContextEngine } = await import('../../../backend/src/core/ProductContextEngine.ts');
        const { ShopifyClient } = await import('../../../backend/src/integrations/ShopifyClient.ts');
        const shopifyClient = new ShopifyClient(storeData.shop_domain, storeData.access_token);
        
        const productContextEngine = new ProductContextEngine(
          shopifyClient,
          CONFIG.OPENAI_API_KEY,
          storeData.brand_dna as Readonly<Record<string, unknown>> | null,
        );

        const productResult = await retryOperation(
          async () =>
            await productContextEngine.injectProductMentions(
              seoOptimizedContent,
              params.products!,
              {
                maxMentions: 5,
                naturalPlacement: true,
                contextualRelevance: true,
              },
            ),
          CONFIG.MAX_RETRIES,
          CONFIG.RETRY_DELAY_MS,
          'inject_products',
        );

        finalContent = productResult.content;
        productMentions = productResult.mentions;
      } catch (productError) {
        logger.warn('Product mention injection failed, using original content', {
          correlationId,
          error: productError instanceof Error ? productError.message : String(productError),
        });
        warnings.push('Product mention injection failed');
      }
    }

    const sanitizedContent = await retryOperation(
      async () =>
        await gdprGuard.sanitizeContent(finalContent, params.storeId, undefined, 'content_generation'),
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'sanitize_content',
    );

    let featuredImageUrl: string | null = null;
    if (CONFIG.ENABLE_IMAGE_GENERATION && CONFIG.FLUX_API_KEY && postContent.imagePrompt) {
      try {
        const { ImageGenerator } = await import('../../../backend/src/core/ImageGenerator.ts');
        const imageGenerator = new ImageGenerator(CONFIG.FLUX_API_KEY);

        const imageResult = await retryOperation(
          async () =>
            await imageGenerator.generateFeaturedImage(
              postContent.imagePrompt,
              postContent.title,
              cleanKeywords,
            ),
          CONFIG.MAX_RETRIES,
          CONFIG.RETRY_DELAY_MS,
          'generate_image',
        );

        try {
          const { ShopifyClient } = await import('../../../backend/src/integrations/ShopifyClient.ts');
          const shopifyClient = new ShopifyClient(storeData.shop_domain, storeData.access_token);

          const cdnResult = await retryOperation(
            async () =>
              await shopifyClient.imageCDN.uploadImage(imageResult.imageUrl, {
                width: IMAGE_WIDTH,
                height: IMAGE_HEIGHT,
                format: IMAGE_FORMAT,
                quality: IMAGE_QUALITY,
                altText: postContent.title,
              }),
            CONFIG.MAX_RETRIES,
            CONFIG.RETRY_DELAY_MS,
            'upload_image_cdn',
          );

          featuredImageUrl = cdnResult.cdnUrl;
        } catch (cdnError) {
          logger.warn('Shopify CDN upload failed, using original URL', {
            correlationId,
            error: cdnError instanceof Error ? cdnError.message : String(cdnError),
          });
          featuredImageUrl = imageResult.imageUrl;
          warnings.push(WARNING_IMAGE_CDN_UPLOAD_FAILED);
        }
      } catch (imageError) {
        logger.error('Image generation failed', {
          correlationId,
          error: imageError instanceof Error ? imageError.message : String(imageError),
        });
        warnings.push(WARNING_IMAGE_GENERATION_FAILED);
      }
    }

    // Get store settings for review window
    const { data: storeSettings } = await supabase
      .from(TABLE_STORES)
      .select('review_window_hours, require_approval')
      .eq(COLUMN_ID, params.storeId)
      .single();

    const reviewWindowHours = (storeSettings as { review_window_hours?: number } | null)?.review_window_hours ?? 24;
    const requireApproval = (storeSettings as { require_approval?: boolean } | null)?.require_approval ?? false;
    
    // Set review status based on require_approval setting
    // If require_approval is true, set to 'pending' (wait for approval)
    // If require_approval is false, set to 'auto_approved' (auto-approve immediately)
    const reviewStatus = requireApproval ? 'pending' : 'auto_approved';
    
    const autoPublishAt = new Date();
    autoPublishAt.setHours(autoPublishAt.getHours() + reviewWindowHours);

    const { data: post, error: postError } = await retryOperation(
      async () => {
        const insertData: Record<string, unknown> = {
          [COLUMN_STORE_ID]: params.storeId,
          [COLUMN_TITLE]: postContent.title,
          [COLUMN_CONTENT]: sanitizedContent.sanitizedContent,
          [COLUMN_EXCERPT]: postContent.excerpt,
          [COLUMN_SEO_TITLE]: postContent.seoTitle,
          [COLUMN_SEO_DESCRIPTION]: postContent.seoDescription,
          [COLUMN_KEYWORDS]: cleanKeywords,
          [COLUMN_PRIMARY_KEYWORD]: postContent.primaryKeyword,
          [COLUMN_STATUS]: STATUS_DRAFT,
          review_status: reviewStatus,
          auto_publish_at: requireApproval ? autoPublishAt.toISOString() : null,
          [COLUMN_PRODUCT_MENTIONS]: params.products && params.products.length > 0 ? { product_ids: params.products } : null,
          [COLUMN_FEATURED_IMAGE_URL]: featuredImageUrl,
          [COLUMN_STRUCTURED_DATA]: {
            ...(postContent.imagePrompt ? { image_prompt: postContent.imagePrompt } : {}),
            ...(postContent.citations && postContent.citations.length > 0 ? { citations: postContent.citations } : {}),
            ...(postContent.qualityScore !== undefined ? { quality_score: postContent.qualityScore } : {}),
            ...(postContent.qualityIssues && postContent.qualityIssues.length > 0 ? { quality_issues: postContent.qualityIssues } : {}),
          },
        };

        // If regenerating, set the regenerated_from field
        if (body.regenerateFrom) {
          insertData.regenerated_from = body.regenerateFrom;
          insertData.regeneration_count = 0; // New post starts at 0, we'll increment the original
        }

        const result = await supabase
          .from(TABLE_BLOG_POSTS)
          .insert(insertData)
          .select()
          .single();

        if (result.error) {
          throw new SupabaseClientError('Failed to create post', result.error);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'create_post',
    );

    if (postError) {
      throw postError;
    }

    // Track regeneration if this is a regenerated article
    if (body.regenerateFrom && post) {
      const postData = post as DatabasePost;
      
      // Increment regeneration count on original post using RPC or raw SQL
      await supabase.rpc('increment_regeneration_count', {
        post_uuid: body.regenerateFrom,
      }).catch(async () => {
        // Fallback: fetch, increment, update
        const { data: originalPost } = await supabase
          .from(TABLE_BLOG_POSTS)
          .select('regeneration_count')
          .eq(COLUMN_ID, body.regenerateFrom)
          .single();
        
        if (originalPost) {
          const currentCount = (originalPost as { regeneration_count?: number }).regeneration_count ?? 0;
          await supabase
            .from(TABLE_BLOG_POSTS)
            .update({ regeneration_count: currentCount + 1 })
            .eq(COLUMN_ID, body.regenerateFrom);
        }
      });

      // Record in regeneration_usage table
      await supabase
        .from('regeneration_usage')
        .insert({
          store_id: params.storeId,
          post_id: postData[COLUMN_ID] as string,
          regenerated_from_post_id: body.regenerateFrom,
          usage_date: new Date().toISOString().split('T')[0], // Current date
        });
    }

    await retryOperation(
      async () => {
        // Record usage using PlanQuotaManager
        const { PlanQuotaManager } = await import('../../../backend/src/core/PlanQuotaManager.ts');
        const quotaManager = new PlanQuotaManager(supabase);
        await quotaManager.recordUsage(params.storeId, (post as DatabasePost)[COLUMN_ID] as string, 'generated');
        return { data: true };
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'record_usage',
    );

    // Generate internal links after post creation
    if (CONFIG.ENABLE_INTERNAL_LINKS) {
      try {
        const { ContentGraph } = await import('../../../backend/src/core/ContentGraph.ts');
        const contentGraph = new ContentGraph(supabase, CONFIG.OPENAI_API_KEY);
        
        await retryOperation(
          async () => {
            const internalLinks = await contentGraph.rebuildInternalLinks(
              params.storeId,
              (post as DatabasePost)[COLUMN_ID] as string,
            );
            
            // Update post with internal links
            await supabase
              .from(TABLE_BLOG_POSTS)
              .update({ internal_links: internalLinks })
              .eq(COLUMN_ID, (post as DatabasePost)[COLUMN_ID]);
            
            return internalLinks;
          },
          CONFIG.MAX_RETRIES,
          CONFIG.RETRY_DELAY_MS,
          'build_internal_links',
        );
        
        logger.info('Internal links generated', { correlationId, postId: (post as DatabasePost)[COLUMN_ID] });
      } catch (linkError) {
        logger.warn('Internal link generation failed', {
          correlationId,
          error: linkError instanceof Error ? linkError.message : String(linkError),
        });
        warnings.push('Internal link generation failed');
      }
    }

    if (CONFIG.ENABLE_LLM_SNIPPETS) {
      try {
        const { JobQueue } = await import('../../../backend/src/core/JobQueue.ts');
        const jobQueue = new JobQueue(supabase);
        await retryOperation(
          async () =>
            await jobQueue.enqueue(
              JOB_TYPE_LLM_SNIPPET,
              {
                postId: (post as DatabasePost)[COLUMN_ID] as string,
                storeId: params.storeId,
                title: postContent.title,
                content: sanitizedContent.sanitizedContent,
                keywords: cleanKeywords,
                seoMetadata: seoMetadata ?? {},
              },
              {
                priority: JOB_PRIORITY_NORMAL,
                maxAttempts: JOB_MAX_ATTEMPTS,
              },
            ),
          CONFIG.MAX_RETRIES,
          CONFIG.RETRY_DELAY_MS,
          'enqueue_llm_snippet',
        );
        logger.info('Enqueued LLM snippet generation job', { correlationId, postId: (post as DatabasePost)[COLUMN_ID] });
      } catch (error) {
        logger.error('Failed to enqueue LLM snippet job', {
          correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
        warnings.push(WARNING_LLM_SNIPPET_ENQUEUE_FAILED);
      }
    }

    if (CONFIG.ENABLE_AUDIT_LOGGING) {
      logger.info('Post created successfully', {
        correlationId,
        postId: (post as DatabasePost)[COLUMN_ID],
        storeId: params.storeId,
        warnings: warnings.length,
      });
    }

    return createSuccessResponse(
      post,
      correlationId,
      {},
      { compression: true, request: req, warnings: warnings.length > 0 ? warnings : undefined },
    );
  } catch (error) {
    logger.error('Post creation failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      storeId: ctx.storeId,
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
    rateLimit: { maxRequests: RATE_LIMIT_MAX_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS },
    timeout: CONFIG.DEFAULT_TIMEOUT,
    validateInput: validatePostCreationParams,
    maxRequestSize: CONFIG.MAX_REQUEST_SIZE,
  };

  try {
    return await handleRequest(req, handleCreatePost, config);
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
