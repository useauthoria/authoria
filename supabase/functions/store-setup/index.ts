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
  createCORSHeaders,
} from '../_shared/utils.ts';

interface DenoEnv {
  readonly get?: (key: string) => string | undefined;
}

interface DenoGlobal {
  readonly Deno?: {
    readonly env?: DenoEnv;
  };
}

interface StoreSetupRequest extends Request {
  readonly correlationId?: string;
  readonly userId?: string;
  readonly storeId?: string;
  readonly startTime?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface StoreSetupResponse {
  readonly data?: unknown;
  readonly error?: string;
  readonly correlationId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly progress?: {
    readonly stage: string;
    readonly percentage: number;
  };
}

interface RequestContext {
  readonly req: StoreSetupRequest;
  readonly supabase: Awaited<ReturnType<typeof getSupabaseClient>>;
  readonly correlationId: string;
  readonly userId?: string;
  storeId?: string;
  readonly startTime: number;
}

interface EndpointConfig {
  readonly requiresAuth?: boolean;
  readonly rateLimit?: { readonly maxRequests: number; readonly windowMs: number };
  readonly compression?: boolean;
  readonly timeout?: number;
  readonly validateInput?: (body: Readonly<Record<string, unknown>>) => { readonly valid: boolean; readonly error?: string };
  readonly maxRequestSize?: number;
}

interface AuthResult {
  readonly valid: boolean;
  readonly userId?: string;
  readonly error?: string;
}

interface OwnershipValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

interface ValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

interface DatabaseStore {
  readonly id: string;
  readonly shop_domain: string | null;
  readonly access_token: string | null;
  readonly [key: string]: unknown;
}

interface SetupRequestBody {
  readonly storeId?: string;
}

interface SetupResult {
  readonly success: boolean;
  readonly brand_dna: Readonly<Record<string, unknown>>;
  readonly tone_matrix: Readonly<Record<string, number>>;
  readonly audience_personas: ReadonlyArray<unknown>;
  readonly consistency_score: number | Readonly<Record<string, unknown>> | undefined;
  readonly textSamplesAnalyzed: number;
  readonly warnings?: ReadonlyArray<string>;
}

interface StoreAssets {
  readonly shop?: { readonly name?: string; readonly description?: string } | null;
  readonly products?: ReadonlyArray<{ readonly title?: string; readonly body_html?: string; readonly product_type?: string; readonly tags?: string }> | null;
  readonly collections?: ReadonlyArray<{ readonly body_html?: string; readonly title?: string; readonly handle?: string }> | null;
  readonly pages?: ReadonlyArray<{ readonly body_html?: string; readonly title?: string; readonly handle?: string }> | null;
  readonly blogArticles?: ReadonlyArray<{ readonly title?: string; readonly body_html?: string }> | null;
}

interface ExtractedContent {
  readonly shopDescription: string;
  readonly productText: readonly string[];
  readonly collectionText: readonly string[];
  readonly pageText: readonly string[];
  readonly aboutPageText: string;
  readonly articleText: readonly string[];
}

interface BrandDNAResponse {
  readonly brandName?: string;
  readonly brandValues?: readonly string[];
  readonly productCategories?: readonly string[];
  readonly priceRange?: string;
  readonly toneKeywords?: readonly string[];
  readonly messagingThemes?: readonly string[];
  readonly uniqueSellingPoints?: readonly string[];
  readonly brandMission?: string;
  readonly brandVision?: string;
  readonly brandPersonality?: readonly string[];
  readonly brandArchetype?: string;
}

interface ToneAnalysisResponse {
  readonly [key: string]: number;
}

interface PersonaResponse {
  readonly personas?: ReadonlyArray<{
    readonly name: string;
    readonly type: 'primary' | 'secondary' | 'tertiary';
    readonly demographics?: {
      readonly ageRange?: string;
      readonly gender?: string;
      readonly location?: string;
      readonly income?: string;
      readonly education?: string;
    };
    readonly psychographics?: {
      readonly interests?: readonly string[];
      readonly values?: readonly string[];
      readonly lifestyle?: readonly string[];
      readonly motivations?: readonly string[];
    };
    readonly painPoints?: readonly string[];
    readonly buyingBehavior?: {
      readonly preferredChannels?: readonly string[];
      readonly decisionFactors?: readonly string[];
      readonly priceSensitivity?: 'low' | 'medium' | 'high';
      readonly frequency?: string;
    };
    readonly contentPreferences?: readonly string[];
  }>;
}

const ENV_SUPABASE_URL = 'SUPABASE_URL' as const;
const ENV_SUPABASE_ANON_KEY = 'SUPABASE_ANON_KEY' as const;
const ENV_OPENAI_API_KEY = 'OPENAI_API_KEY' as const;
const ENV_STORE_SETUP_TIMEOUT = 'STORE_SETUP_TIMEOUT' as const;
const ENV_CORS_ORIGINS = 'CORS_ORIGINS' as const;
const ENV_MAX_REQUEST_SIZE = 'MAX_REQUEST_SIZE' as const;
const ENV_MAX_RETRIES = 'MAX_RETRIES' as const;
const ENV_RETRY_DELAY_MS = 'RETRY_DELAY_MS' as const;
const ENV_MAX_PRODUCTS_TO_ANALYZE = 'MAX_PRODUCTS_TO_ANALYZE' as const;
const DEFAULT_TIMEOUT = 900000;
const DEFAULT_MAX_REQUEST_SIZE = 1048576;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 2000;
const DEFAULT_MAX_PRODUCTS = 50;
const MIN_TOKEN_LENGTH = 10;
const BEARER_PREFIX = 'Bearer ' as const;
const BEARER_PREFIX_LENGTH = 7;
const ID_RADIX = 36;
const ID_LENGTH = 9;
const CORRELATION_PREFIX = 'store-setup-' as const;
const METHOD_POST = 'POST' as const;
const METHOD_OPTIONS = 'OPTIONS' as const;
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_REQUEST_TIMEOUT = 408;
const STATUS_PAYLOAD_TOO_LARGE = 413;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_INTERNAL_ERROR = 500;
const STATUS_NO_CONTENT = 204;
const HEADER_AUTHORIZATION = 'Authorization' as const;
const HEADER_X_CORRELATION_ID = 'x-correlation-id' as const;
const HEADER_X_RESPONSE_TIME = 'x-response-time' as const;
const HEADER_CONTENT_LENGTH = 'content-length' as const;
const HEADER_CONTENT_TYPE = 'Content-Type' as const;
const HEADER_CONTENT_TYPE_JSON = 'application/json' as const;
const ENCODING_NONE = 'none' as const;
const ERROR_UNAUTHORIZED = 'Unauthorized' as const;
const ERROR_MISSING_ENV = 'Missing environment variables' as const;
const ERROR_MISSING_AUTHORIZATION = 'Missing authorization header' as const;
const ERROR_INVALID_AUTHORIZATION = 'Invalid authorization' as const;
const ERROR_REQUEST_TOO_LARGE = 'Request too large' as const;
const ERROR_RATE_LIMIT_EXCEEDED = 'Rate limit exceeded' as const;
const ERROR_REQUEST_TIMEOUT = 'Request timeout' as const;
const ERROR_INVALID_INPUT = 'Invalid input' as const;
const ERROR_INVALID_JSON = 'Invalid JSON in request body' as const;
const ERROR_INTERNAL_SERVER = 'Internal server error' as const;
const ERROR_NOT_FOUND = 'Not Found' as const;
const ERROR_STORE_NOT_FOUND = 'Store not found' as const;
const ERROR_STORE_NOT_FOUND_OR_ACCESS_DENIED = 'Store not found or access denied' as const;
const ERROR_OPENAI_NOT_CONFIGURED = 'OPENAI_API_KEY not configured' as const;
const ERROR_STORE_MISSING_CREDENTIALS = 'Store missing Shopify credentials' as const;
const ERROR_BRAND_ANALYSIS_FAILED = 'Brand analysis failed to produce results' as const;
const ERROR_STORE_ID_REQUIRED = 'storeId is required and must be a string' as const;
const ERROR_STORE_ID_EMPTY = 'storeId must be a non-empty string' as const;
const ERROR_CODE_UNAUTHORIZED = 'UNAUTHORIZED' as const;
const ERROR_CODE_CONFIG_ERROR = 'CONFIG_ERROR' as const;
const ERROR_CODE_STORE_NOT_FOUND = 'STORE_NOT_FOUND' as const;
const ERROR_CODE_STORE_CONFIG_ERROR = 'STORE_CONFIG_ERROR' as const;
const ERROR_CODE_ANALYSIS_ERROR = 'ANALYSIS_ERROR' as const;
const ERROR_CODE_INTERNAL_ERROR = 'INTERNAL_ERROR' as const;
const RETRY_BACKOFF_BASE = 2;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const STAGE_FETCHING_STORE = 'fetching_store' as const;
const STAGE_FETCHING_STORE_CONTENT = 'fetching_store_content' as const;
const STAGE_ANALYZING_BRAND = 'analyzing_brand' as const;
const STAGE_SAVING_RESULTS = 'saving_results' as const;
const STAGE_COMPLETED = 'completed' as const;
const PERCENTAGE_FETCHING_STORE = 10;
const PERCENTAGE_FETCHING_STORE_CONTENT = 15;
const PERCENTAGE_ANALYZING_BRAND = 50;
const PERCENTAGE_SAVING_RESULTS = 95;
const PERCENTAGE_COMPLETED = 100;
const TABLE_STORES = 'stores' as const;
const TABLE_BRAND_DNA_CACHE = 'brand_dna_cache' as const;
const COLUMN_ID = 'id' as const;
const COLUMN_SHOP_DOMAIN = 'shop_domain' as const;
const COLUMN_ACCESS_TOKEN = 'access_token' as const;
const COLUMN_BRAND_DNA = 'brand_dna' as const;
const COLUMN_TONE_MATRIX = 'tone_matrix' as const;
const COLUMN_AUDIENCE_PERSONAS = 'audience_personas' as const;
const COLUMN_BRAND_CONSISTENCY_SCORE = 'brand_consistency_score' as const;
const COLUMN_BRAND_SETUP_COMPLETED_AT = 'brand_setup_completed_at' as const;
const COLUMN_UPDATED_AT = 'updated_at' as const;
const COLUMN_STORE_ID = 'store_id' as const;
const COLUMN_EXTRACTED_DNA = 'extracted_dna' as const;
const COLUMN_TONE_ANALYSIS = 'tone_analysis' as const;
const COLUMN_AUDIENCE_MODEL = 'audience_model' as const;
const COLUMN_CONSISTENCY_SCORE = 'consistency_score' as const;
const PATH_ROOT = '/' as const;
const ANONYMOUS_USER = 'anonymous' as const;
const NO_STORE = 'no-store' as const;
const AUTHENTICATED_USER = 'authenticated' as const;
const WARNING_NO_PRODUCT_SAMPLES = 'No product text samples available, analysis may be less accurate' as const;
const WARNING_BRAND_DNA_CACHING_FAILED = 'Brand DNA caching failed, but setup completed' as const;
const WARNING_CONTENT_FETCH_FAILED = 'Some store content could not be fetched, analysis may be limited' as const;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions' as const;
const OPENAI_MODEL = 'gpt-4o-mini' as const;
const OPENAI_TIMEOUT_MS = 25000;
const OPENAI_MAX_TOKENS = 2000;
const OPENAI_TEMPERATURE = 0.7;
const TEXT_LIMIT_BRAND_DNA = 50000;
const TEXT_LIMIT_TONE = 50000;
const TEXT_LIMIT_PERSONAS = 40000;
const PRODUCT_SAMPLE_LIMIT = 30;
const ARTICLE_SAMPLE_LIMIT = 10;
const PAGE_SAMPLE_LIMIT = 5;
const DEFAULT_CONSISTENCY_SCORE = 75;
const ABOUT_PAGE_HANDLES = ['about', 'about-us', 'our-story', 'who-we-are', 'about-our-company'] as const;
const TONE_DIMENSIONS = [
  'expert',
  'conversational',
  'aspirational',
  'friendly',
  'professional',
  'casual',
  'authoritative',
  'empathetic',
] as const;
const DEFAULT_STORE_BRAND_NAME = 'Store Brand' as const;
const DEFAULT_PRICE_RANGE = 'medium' as const;
const DEFAULT_PRIMARY_CUSTOMER_NAME = 'Primary Customer' as const;
const DEFAULT_AGE_RANGE = '25-45' as const;
const DEFAULT_FREQUENCY = 'monthly' as const;
const DEFAULT_PRICE_SENSITIVITY = 'medium' as const;
const DEFAULT_CHANNEL = 'online' as const;
const MAX_PERSONAS = 3;

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
  DEFAULT_TIMEOUT: parseInt(getEnv(ENV_STORE_SETUP_TIMEOUT, String(DEFAULT_TIMEOUT)), 10),
  CORS_ORIGINS: getEnv(ENV_CORS_ORIGINS, '*').split(','),
  MAX_REQUEST_SIZE: parseInt(getEnv(ENV_MAX_REQUEST_SIZE, String(DEFAULT_MAX_REQUEST_SIZE)), 10),
  MAX_RETRIES: parseInt(getEnv(ENV_MAX_RETRIES, String(DEFAULT_MAX_RETRIES)), 10),
  RETRY_DELAY_MS: parseInt(getEnv(ENV_RETRY_DELAY_MS, String(DEFAULT_RETRY_DELAY_MS)), 10),
  MAX_PRODUCTS_TO_ANALYZE: parseInt(getEnv(ENV_MAX_PRODUCTS_TO_ANALYZE, String(DEFAULT_MAX_PRODUCTS)), 10),
} as const;

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

async function validateStoreOwnership(
  _supabase: Awaited<ReturnType<typeof getSupabaseClient>>,
  storeId: string,
  _userId?: string,
): Promise<OwnershipValidationResult> {
  try {
    const serviceSupabase = await getSupabaseClient({ clientType: 'service' });

    const { data: store, error } = await serviceSupabase
      .from(TABLE_STORES)
      .select(COLUMN_ID)
      .eq(COLUMN_ID, storeId)
      .single();

    if (error || !store) {
      return { valid: false, error: ERROR_STORE_NOT_FOUND };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Failed to validate store ownership' };
  }
}

function validateSetupParams(params: SetupRequestBody | Readonly<Record<string, unknown>>): ValidationResult {
  if (!params.storeId || typeof params.storeId !== 'string') {
    return { valid: false, error: ERROR_STORE_ID_REQUIRED };
  }

  if (params.storeId.length < 1) {
    return { valid: false, error: ERROR_STORE_ID_EMPTY };
  }

  return { valid: true };
}

function generateCorrelationId(): string {
  return `${CORRELATION_PREFIX}${Date.now()}-${Math.random().toString(ID_RADIX).substring(2, 2 + ID_LENGTH)}`;
}

async function createRequestContext(req: Request): Promise<RequestContext> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  const authHeader = req.headers.get(HEADER_AUTHORIZATION);
  const authResult = await validateAuth(authHeader);

  if (!authResult.valid) {
    throw new UtilsError(authResult.error ?? ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED as string, STATUS_UNAUTHORIZED);
  }

  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
    throw new UtilsError(ERROR_MISSING_ENV, ERROR_CODE_CONFIG_ERROR as string, STATUS_INTERNAL_ERROR);
  }

  const supabase = authHeader ? await createAuthenticatedClient(authHeader) : await getSupabaseClient({ clientType: 'anon' });

  return {
    req: req as StoreSetupRequest,
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
    if (contentLength && parseInt(contentLength, 10) > (config.maxRequestSize ?? CONFIG.MAX_REQUEST_SIZE)) {
      return createErrorResponse(ERROR_REQUEST_TOO_LARGE, STATUS_PAYLOAD_TOO_LARGE, correlationId, undefined, req);
    }

    const processedReq = await executeRequestInterceptors(req);

    const ctx = await createRequestContext(processedReq);
    correlationId = ctx.correlationId;

    if (config.rateLimit) {
      const rateLimitKey = `store-setup:${ctx.userId ?? ANONYMOUS_USER}:${ctx.storeId ?? NO_STORE}`;
      const rateLimit = checkRateLimit(rateLimitKey, config.rateLimit.maxRequests, config.rateLimit.windowMs);

      if (!rateLimit.allowed) {
        logger.warn('Rate limit exceeded', { correlationId, rateLimitKey, remaining: rateLimit.remaining });
        return createErrorResponse(ERROR_RATE_LIMIT_EXCEEDED, STATUS_TOO_MANY_REQUESTS, correlationId, {
          retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
        }, req);
      }
    }

    if (config.validateInput && req.method === METHOD_POST) {
      try {
        const body = await req.clone().json() as Readonly<Record<string, unknown>>;
        const validation = config.validateInput(body);
        if (!validation.valid) {
          return createErrorResponse(validation.error ?? ERROR_INVALID_INPUT, STATUS_BAD_REQUEST, correlationId, undefined, req);
        }
      } catch {
        return createErrorResponse(ERROR_INVALID_JSON, STATUS_BAD_REQUEST, correlationId, undefined, req);
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
      storeId: ctx.storeId,
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
      { errorCode: error instanceof UtilsError ? error.code : ERROR_CODE_INTERNAL_ERROR as string },
      req,
    );
  }
}

async function createSuccessResponse(
  data: unknown,
  correlationId: string,
  metadata: Readonly<Record<string, unknown>> | undefined,
  options: { readonly compression?: boolean; readonly request?: Request; readonly progress?: { readonly stage: string; readonly percentage: number } } = {},
): Promise<Response> {
  const response: StoreSetupResponse = {
    data,
    correlationId,
    ...(metadata && { metadata }),
    ...(options.progress && { progress: options.progress }),
  };

  if (options.compression !== false && options.request) {
    const compression = acceptsCompression(options.request);
    if (compression !== ENCODING_NONE) {
      return createCompressedResponse(response, {
        encoding: compression,
        headers: createCORSHeaders(options.request, CONFIG.CORS_ORIGINS),
      });
    }
  }

  const corsHeaders = options.request
    ? createCORSHeaders(options.request, CONFIG.CORS_ORIGINS)
    : createCORSHeaders({ headers: new Headers() } as Request, CONFIG.CORS_ORIGINS);

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
  metadata: Readonly<Record<string, unknown>> | undefined,
  request?: Request,
): Response {
  const response: StoreSetupResponse = {
    error,
    correlationId,
    ...(metadata && { metadata }),
  };

  const corsHeaders = request
    ? createCORSHeaders(request, CONFIG.CORS_ORIGINS)
    : createCORSHeaders({ headers: new Headers() } as Request, CONFIG.CORS_ORIGINS);

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

function logProgress(
  correlationId: string,
  stage: string,
  percentage: number,
  details?: Readonly<Record<string, unknown>>,
): void {
  logger.info('Setup progress', {
    correlationId,
    stage,
    percentage,
    ...details,
  });
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function findAboutPage(pages: ReadonlyArray<{ readonly handle?: string }>): { readonly handle?: string; readonly title?: string; readonly body_html?: string } | null {
  return pages.find((page) =>
    ABOUT_PAGE_HANDLES.includes((page.handle || '').toLowerCase() as typeof ABOUT_PAGE_HANDLES[number])
  ) || null;
}

function extractAboutPageText(aboutPage: { readonly title?: string; readonly body_html?: string } | null): string {
  if (!aboutPage) return '';

  const htmlContent = aboutPage.body_html || '';
  const textContent = stripHtmlTags(htmlContent);
  const title = aboutPage.title || '';

  return `${title} ${textContent}`.trim();
}

function extractStoreContent(assets: StoreAssets): ExtractedContent {
  const aboutPage = findAboutPage(assets.pages || []);

  const productText = (assets.products || [])
    .map((p) => {
      const title = p.title || '';
      const desc = stripHtmlTags(p.body_html || '');
      return `${title} ${desc}`.trim();
    })
    .filter((t) => t.length > 0);

  const collectionText = (assets.collections || [])
    .map((c) => {
      const title = c.title || '';
      const desc = stripHtmlTags(c.body_html || '');
      return `${title} ${desc}`.trim();
    })
    .filter((t) => t.length > 0);

  const pageText = (assets.pages || [])
    .map((p) => {
      const title = p.title || '';
      const content = stripHtmlTags(p.body_html || '');
      return `${title} ${content}`.trim();
    })
    .filter((t) => t.length > 0);

  const articleText = (assets.blogArticles || [])
    .map((a) => {
      const title = a.title || '';
      const content = stripHtmlTags(a.body_html || '');
      return `${title} ${content}`.trim();
    })
    .filter((t) => t.length > 0);

  return {
    shopDescription: stripHtmlTags(assets.shop?.description || ''),
    productText,
    collectionText,
    pageText,
    aboutPageText: extractAboutPageText(aboutPage),
    articleText,
  };
}

function buildTextSamples(contentData: ExtractedContent): readonly string[] {
  const samples: string[] = [];

  if (contentData.aboutPageText) {
    samples.push(`[ABOUT PAGE] ${contentData.aboutPageText}`);
  }

  if (contentData.shopDescription) {
    samples.push(`[SHOP DESCRIPTION] ${contentData.shopDescription}`);
  }

  samples.push(...contentData.collectionText.map((t) => `[COLLECTION] ${t}`));
  samples.push(...contentData.productText.slice(0, PRODUCT_SAMPLE_LIMIT).map((t) => `[PRODUCT] ${t}`));
  samples.push(...contentData.articleText.slice(0, ARTICLE_SAMPLE_LIMIT).map((t) => `[ARTICLE] ${t}`));
  samples.push(...contentData.pageText.slice(0, PAGE_SAMPLE_LIMIT).map((t) => `[PAGE] ${t}`));

  return samples.filter((s) => s.trim().length > 0);
}

async function callOpenAIViaFetch(
  prompt: string,
  openaiApiKey: string,
  model: string = OPENAI_MODEL,
  timeoutMs: number = OPENAI_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: METHOD_POST,
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: OPENAI_TEMPERATURE,
        max_tokens: OPENAI_MAX_TOKENS,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
    }

    const data = await response.json() as { choices?: ReadonlyArray<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`OpenAI API timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

async function analyzeBrandDNAViaFetch(
  textSamples: readonly string[],
  openaiApiKey: string,
  shopName?: string,
): Promise<BrandDNAResponse> {
  const combinedText = textSamples.join('\n\n').substring(0, TEXT_LIMIT_BRAND_DNA);

  const prompt = `You are a brand intelligence expert. Analyze the following brand content and extract comprehensive brand DNA.
Return a JSON object with the following structure:
{
  "brandName": "extracted brand name",
  "brandValues": ["array of core brand values"],
  "productCategories": ["array of product categories"],
  "priceRange": "low|medium|high|premium",
  "toneKeywords": ["array of key tone-related words"],
  "messagingThemes": ["array of messaging themes"],
  "uniqueSellingPoints": ["array of unique selling points"],
  "brandMission": "brand mission statement",
  "brandVision": "brand vision statement",
  "brandPersonality": ["array of personality traits"],
  "brandArchetype": "brand archetype (Hero, Sage, Explorer, Creator, Ruler, Caregiver, Magician, Innocent, Orphan, Rebel, Lover, Jester)"
}

Content to analyze: ${combinedText}`;

  try {
    const responseText = await callOpenAIViaFetch(prompt, openaiApiKey);
    const result = JSON.parse(responseText) as BrandDNAResponse;

    return {
      brandName: result.brandName || shopName || DEFAULT_STORE_BRAND_NAME,
      brandValues: result.brandValues || [],
      productCategories: result.productCategories || [],
      priceRange: result.priceRange || DEFAULT_PRICE_RANGE,
      toneKeywords: result.toneKeywords || [],
      messagingThemes: result.messagingThemes || [],
      uniqueSellingPoints: result.uniqueSellingPoints || [],
      brandMission: result.brandMission,
      brandVision: result.brandVision,
      brandPersonality: result.brandPersonality,
      brandArchetype: result.brandArchetype,
    };
  } catch (error) {
    logger.warn('Brand DNA analysis failed, using fallback', {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      brandName: shopName || DEFAULT_STORE_BRAND_NAME,
      brandValues: [],
      productCategories: [],
      priceRange: DEFAULT_PRICE_RANGE,
      toneKeywords: [],
      messagingThemes: [],
      uniqueSellingPoints: [],
    };
  }
}

async function analyzeToneViaFetch(
  textSamples: readonly string[],
  openaiApiKey: string,
): Promise<Readonly<Record<string, number>>> {
  const combinedText = textSamples.join('\n\n').substring(0, TEXT_LIMIT_TONE);

  const prompt = `You are a tone analysis expert. Return only valid JSON with tone weights.
Analyze the tone of the following brand content and return a weighted tone matrix.
Consider these tone dimensions: ${TONE_DIMENSIONS.join(', ')}.
Return a JSON object with values between 0 and 1 that sum to approximately 1.0.
Each dimension should be a key in the JSON object with its weight as the value.

Content: ${combinedText}`;

  try {
    const responseText = await callOpenAIViaFetch(prompt, openaiApiKey);
    const result = JSON.parse(responseText) as ToneAnalysisResponse;

    const normalizedMatrix: Record<string, number> = {};
    let total = 0;

    TONE_DIMENSIONS.forEach((dim) => {
      const value = typeof result[dim] === 'number' ? result[dim] : 0;
      normalizedMatrix[dim] = value;
      total += value;
    });

    if (total === 0) {
      const equalWeight = 1 / TONE_DIMENSIONS.length;
      TONE_DIMENSIONS.forEach((dim) => {
        normalizedMatrix[dim] = equalWeight;
      });
    } else {
      TONE_DIMENSIONS.forEach((dim) => {
        normalizedMatrix[dim] = normalizedMatrix[dim]! / total;
      });
    }

    return normalizedMatrix;
  } catch (error) {
    logger.warn('Tone analysis failed, using default', {
      error: error instanceof Error ? error.message : String(error),
    });

    const equalWeight = 1 / TONE_DIMENSIONS.length;
    const defaultMatrix: Record<string, number> = {};
    TONE_DIMENSIONS.forEach((dim) => {
      defaultMatrix[dim] = equalWeight;
    });
    return defaultMatrix;
  }
}

async function generateAudiencePersonasViaFetch(
  textSamples: readonly string[],
  brandDNA: BrandDNAResponse,
  openaiApiKey: string,
): Promise<ReadonlyArray<unknown>> {
  const combinedText = textSamples.join('\n\n').substring(0, TEXT_LIMIT_PERSONAS);

  const prompt = `You are a brand intelligence expert specializing in audience analysis.
Analyze the brand content and generate detailed audience personas.
Return a JSON object with a "personas" array, each persona with the following structure:
{
  "name": "persona name",
  "type": "primary|secondary|tertiary",
  "demographics": {
    "ageRange": "e.g., 25-35",
    "gender": "optional",
    "location": "optional",
    "income": "optional",
    "education": "optional"
  },
  "psychographics": {
    "interests": ["array of interests"],
    "values": ["array of values"],
    "lifestyle": ["array of lifestyle descriptors"],
    "motivations": ["array of motivations"]
  },
  "painPoints": ["array of pain points"],
  "buyingBehavior": {
    "preferredChannels": ["array of channels"],
    "decisionFactors": ["array of factors"],
    "priceSensitivity": "low|medium|high",
    "frequency": "e.g., monthly, quarterly"
  },
  "contentPreferences": ["array of content preferences"]
}

Generate 1-3 personas (primary, and optionally secondary/tertiary).
Brand context:
- Brand Values: ${(brandDNA.brandValues || []).join(', ')}
- Price Range: ${brandDNA.priceRange || DEFAULT_PRICE_RANGE}
- Product Categories: ${(brandDNA.productCategories || []).join(', ')}

Content to analyze: ${combinedText}`;

  try {
    const responseText = await callOpenAIViaFetch(prompt, openaiApiKey);
    const result = JSON.parse(responseText) as PersonaResponse;
    const personas = result.personas || [];

    if (Array.isArray(personas) && personas.length > 0) {
      return personas.slice(0, MAX_PERSONAS);
    }

    return [{
      name: DEFAULT_PRIMARY_CUSTOMER_NAME,
      type: 'primary',
      demographics: {
        ageRange: DEFAULT_AGE_RANGE,
      },
      psychographics: {
        interests: (brandDNA.messagingThemes || []).slice(0, 3),
        values: (brandDNA.brandValues || []).slice(0, 3),
        lifestyle: [],
        motivations: [],
      },
      painPoints: [],
      buyingBehavior: {
        preferredChannels: [DEFAULT_CHANNEL],
        decisionFactors: (brandDNA.uniqueSellingPoints || []).slice(0, 3),
        priceSensitivity: brandDNA.priceRange === 'high' ? 'low' : DEFAULT_PRICE_SENSITIVITY,
        frequency: DEFAULT_FREQUENCY,
      },
      contentPreferences: [],
    }];
  } catch (error) {
    logger.warn('Persona generation failed, using fallback', {
      error: error instanceof Error ? error.message : String(error),
    });

    return [{
      name: DEFAULT_PRIMARY_CUSTOMER_NAME,
      type: 'primary',
      demographics: {
        ageRange: DEFAULT_AGE_RANGE,
      },
      psychographics: {
        interests: [],
        values: [],
        lifestyle: [],
        motivations: [],
      },
      painPoints: [],
      buyingBehavior: {
        preferredChannels: [DEFAULT_CHANNEL],
        decisionFactors: [],
        priceSensitivity: DEFAULT_PRICE_SENSITIVITY,
        frequency: DEFAULT_FREQUENCY,
      },
      contentPreferences: [],
    }];
  }
}

async function handleStoreSetup(ctx: RequestContext): Promise<Response> {
  const { req, correlationId } = ctx;
  const warnings: string[] = [];

  try {
    const serviceSupabase = await getSupabaseClient({ clientType: 'service' });

    const body = await req.json() as SetupRequestBody;
    const validation = validateSetupParams(body);

    if (!validation.valid) {
      return createErrorResponse(validation.error ?? ERROR_INVALID_INPUT, STATUS_BAD_REQUEST, correlationId, undefined, req);
    }

    const storeId = body.storeId!;
    ctx.storeId = storeId;

    const ownershipValidation = await validateStoreOwnership(serviceSupabase, storeId, ctx.userId);
    if (!ownershipValidation.valid) {
      return createErrorResponse(ownershipValidation.error ?? ERROR_STORE_NOT_FOUND_OR_ACCESS_DENIED, STATUS_NOT_FOUND, correlationId, undefined, req);
    }

    logProgress(correlationId, STAGE_FETCHING_STORE, PERCENTAGE_FETCHING_STORE);

    const { data: store, error: storeError } = await retryOperation(
      async () => {
        const result = await serviceSupabase
          .from(TABLE_STORES)
          .select('*')
          .eq(COLUMN_ID, storeId)
          .single();

        if (result.error) {
          throw new SupabaseClientError('Failed to fetch store', result.error);
        }
        if (!result.data) {
          throw new UtilsError(ERROR_STORE_NOT_FOUND, ERROR_CODE_STORE_NOT_FOUND as string, STATUS_NOT_FOUND);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'fetch_store',
    );

    if (storeError || !store) {
      throw new UtilsError(ERROR_STORE_NOT_FOUND, ERROR_CODE_STORE_NOT_FOUND as string, STATUS_NOT_FOUND);
    }

    const storeData = store as unknown as DatabaseStore;

    if (!CONFIG.OPENAI_API_KEY) {
      throw new UtilsError(ERROR_OPENAI_NOT_CONFIGURED, ERROR_CODE_CONFIG_ERROR as string, STATUS_INTERNAL_ERROR);
    }

    if (!storeData.shop_domain || !storeData.access_token) {
      throw new UtilsError(ERROR_STORE_MISSING_CREDENTIALS, ERROR_CODE_STORE_CONFIG_ERROR as string, STATUS_BAD_REQUEST);
    }

    logProgress(correlationId, STAGE_FETCHING_STORE_CONTENT, PERCENTAGE_FETCHING_STORE_CONTENT);

    const { ShopifyAPI } = await import('../backend/src/integrations/ShopifyClient.ts');
    const shopifyAPI = new ShopifyAPI(storeData.shop_domain, storeData.access_token);

    let shop: unknown = null;
    let products: unknown[] = [];
    let collections: unknown[] = [];
    let pages: unknown[] = [];
    let blogArticles: unknown[] = [];

    try {
      [shop, products, collections, pages, blogArticles] = await Promise.all([
        shopifyAPI.getShop(storeData.shop_domain, storeData.access_token).catch((err) => {
          logger.warn('Failed to fetch shop data', { correlationId, error: err instanceof Error ? err.message : String(err) });
          return null;
        }),
        shopifyAPI.getProducts(storeData.shop_domain, storeData.access_token, CONFIG.MAX_PRODUCTS_TO_ANALYZE).catch((err) => {
          logger.warn('Failed to fetch products from Shopify', { correlationId, error: err instanceof Error ? err.message : String(err) });
          return [];
        }),
        shopifyAPI.getCollections(storeData.shop_domain, storeData.access_token).catch((err) => {
          logger.warn('Failed to fetch collections', { correlationId, error: err instanceof Error ? err.message : String(err) });
          return [];
        }),
        shopifyAPI.getPages(storeData.shop_domain, storeData.access_token).catch((err) => {
          logger.warn('Failed to fetch pages', { correlationId, error: err instanceof Error ? err.message : String(err) });
          return [];
        }),
        shopifyAPI.getBlogArticles(storeData.shop_domain, storeData.access_token).catch((err) => {
          logger.warn('Failed to fetch blog articles', { correlationId, error: err instanceof Error ? err.message : String(err) });
          return [];
        }),
      ]);
    } catch (error) {
      logger.warn('Error fetching store content, continuing with available data', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
      warnings.push(WARNING_CONTENT_FETCH_FAILED);
    }

    const assets: StoreAssets = {
      shop: shop as StoreAssets['shop'],
      products: products as StoreAssets['products'],
      collections: collections as StoreAssets['collections'],
      pages: pages as StoreAssets['pages'],
      blogArticles: blogArticles as StoreAssets['blogArticles'],
    };

    const contentData = extractStoreContent(assets);
    const textSamples = buildTextSamples(contentData);

    if (textSamples.length === 0) {
      warnings.push(WARNING_NO_PRODUCT_SAMPLES);
    }

    const shopName = (shop as { name?: string })?.name || storeData.shop_domain || 'Unknown';

    logProgress(correlationId, STAGE_ANALYZING_BRAND, PERCENTAGE_ANALYZING_BRAND);

    logger.info('Starting comprehensive brand analysis', {
      correlationId,
      textSamplesCount: textSamples.length,
      hasAboutPage: contentData.aboutPageText.length > 0,
      hasShopDescription: contentData.shopDescription.length > 0,
      productsCount: contentData.productText.length,
      collectionsCount: contentData.collectionText.length,
      pagesCount: contentData.pageText.length,
      articlesCount: contentData.articleText.length,
    });

    const [brandDNAResult, toneMatrix] = await Promise.all([
      analyzeBrandDNAViaFetch(textSamples, CONFIG.OPENAI_API_KEY, shopName),
      analyzeToneViaFetch(textSamples, CONFIG.OPENAI_API_KEY),
    ]);

    const personas = await generateAudiencePersonasViaFetch(textSamples, brandDNAResult, CONFIG.OPENAI_API_KEY);

    const brandDNA: Readonly<Record<string, unknown>> = {
      brandName: brandDNAResult.brandName || shopName,
      brandValues: brandDNAResult.brandValues || [],
      targetAudiences: personas,
      productCategories: brandDNAResult.productCategories || [],
      priceRange: brandDNAResult.priceRange || DEFAULT_PRICE_RANGE,
      toneKeywords: brandDNAResult.toneKeywords || [],
      messagingThemes: brandDNAResult.messagingThemes || [],
      uniqueSellingPoints: brandDNAResult.uniqueSellingPoints || [],
      brandMission: brandDNAResult.brandMission,
      brandVision: brandDNAResult.brandVision,
      brandPersonality: brandDNAResult.brandPersonality,
      brandArchetype: brandDNAResult.brandArchetype,
    };

    const consistencyScore: number = DEFAULT_CONSISTENCY_SCORE;

    if (!brandDNA || !toneMatrix) {
      throw new UtilsError(ERROR_BRAND_ANALYSIS_FAILED, ERROR_CODE_ANALYSIS_ERROR as string, STATUS_INTERNAL_ERROR);
    }

    logProgress(correlationId, STAGE_SAVING_RESULTS, PERCENTAGE_SAVING_RESULTS);

    await retryOperation(
      async () => {
        const result = await serviceSupabase
          .from(TABLE_STORES)
          .update({
            [COLUMN_BRAND_DNA]: brandDNA,
            [COLUMN_TONE_MATRIX]: toneMatrix,
            [COLUMN_AUDIENCE_PERSONAS]: brandDNA.targetAudiences ?? [],
            [COLUMN_BRAND_CONSISTENCY_SCORE]: consistencyScore,
            [COLUMN_BRAND_SETUP_COMPLETED_AT]: new Date().toISOString(),
            [COLUMN_UPDATED_AT]: new Date().toISOString(),
          })
          .eq(COLUMN_ID, storeId);

        if (result.error) {
          throw new SupabaseClientError('Failed to update store', result.error);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'update_store',
    );

    retryOperation(
      async () => {
        const targetAudiences = (brandDNA.targetAudiences as ReadonlyArray<unknown> | undefined) ?? [];
        const result = await serviceSupabase.from(TABLE_BRAND_DNA_CACHE).insert({
          [COLUMN_STORE_ID]: storeId,
          [COLUMN_EXTRACTED_DNA]: brandDNA,
          [COLUMN_TONE_ANALYSIS]: toneMatrix,
          [COLUMN_AUDIENCE_MODEL]: targetAudiences,
          [COLUMN_CONSISTENCY_SCORE]: consistencyScore,
        });
        if (result.error) {
          throw new SupabaseClientError('Failed to cache brand DNA', result.error);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'cache_brand_dna',
    ).catch((err) => {
      logger.warn('Failed to cache brand DNA', {
        correlationId,
        error: err instanceof Error ? err.message : String(err),
      });
      warnings.push(WARNING_BRAND_DNA_CACHING_FAILED);
    });

    logProgress(correlationId, STAGE_SAVING_RESULTS, PERCENTAGE_COMPLETED);

    logger.info('Store setup completed successfully', {
      correlationId,
      storeId,
      consistencyScore,
      textSamplesCount: textSamples.length,
      warnings: warnings.length,
    });

    const targetAudiences = (brandDNA.targetAudiences as ReadonlyArray<unknown> | undefined) ?? [];
    const result: SetupResult = {
      success: true,
      brand_dna: brandDNA,
      tone_matrix: toneMatrix,
      audience_personas: targetAudiences,
      consistency_score: consistencyScore,
      textSamplesAnalyzed: textSamples.length,
      ...(warnings.length > 0 && { warnings }),
    };

    return createSuccessResponse(
      result,
      correlationId,
      {
        duration: performance.now() - ctx.startTime,
        textSamplesCount: textSamples.length,
      },
      {
        compression: true,
        request: req,
        progress: { stage: STAGE_COMPLETED, percentage: PERCENTAGE_COMPLETED },
      },
    );
  } catch (error) {
    logger.error('Store setup failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      storeId: ctx.storeId,
    });
    throw error;
  }
}

async function routeRequest(ctx: RequestContext): Promise<Response> {
  const url = new URL(ctx.req.url);
  const path = url.pathname.replace('/store-setup', '').replace(/^\/+/, '') || PATH_ROOT;
  const method = ctx.req.method;

  if (path === '' || path === PATH_ROOT) {
    if (method === METHOD_POST) {
      return handleStoreSetup(ctx);
    }
  }

  return createErrorResponse(ERROR_NOT_FOUND, STATUS_NOT_FOUND, ctx.correlationId, undefined, ctx.req);
}

serve(async (req: Request) => {
  if (req.method === METHOD_OPTIONS) {
    return new Response(null, {
      status: STATUS_NO_CONTENT,
      headers: createCORSHeaders(req, CONFIG.CORS_ORIGINS),
    });
  }

  const config: EndpointConfig = {
    requiresAuth: true,
    compression: true,
    rateLimit: { maxRequests: RATE_LIMIT_MAX_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS },
    timeout: CONFIG.DEFAULT_TIMEOUT,
    validateInput: validateSetupParams,
    maxRequestSize: CONFIG.MAX_REQUEST_SIZE,
  };

  try {
    return await handleRequest(req, routeRequest, config);
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
      { errorCode: error instanceof UtilsError ? error.code : ERROR_CODE_INTERNAL_ERROR as string },
      req,
    );
  }
});
