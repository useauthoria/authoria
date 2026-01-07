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

interface ShopifyRequest extends Request {
  readonly correlationId?: string;
  readonly userId?: string;
  readonly storeId?: string;
  readonly startTime?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface ShopifyResponse {
  readonly data?: unknown;
  readonly error?: string;
  readonly correlationId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly warnings?: ReadonlyArray<string>;
}

interface RequestContext {
  readonly req: ShopifyRequest;
  readonly supabase: Awaited<ReturnType<typeof getSupabaseClient>>;
  readonly correlationId: string;
  readonly userId?: string;
  readonly startTime: number;
}

interface PublishBody {
  readonly postId?: string;
  readonly storeId?: string;
  readonly blogId?: number;
  readonly published?: boolean;
}

interface SyncBody {
  readonly storeId?: string;
  readonly syncType?: 'products' | 'collections' | 'metadata' | 'all';
}

interface CreateSubscriptionBody {
  readonly storeId?: string;
  readonly planName?: string;
  readonly returnUrl?: string;
  readonly isAnnual?: boolean;
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
  readonly shop_domain: string;
  readonly access_token: string;
  readonly shopify_blog_id?: number | null;
  readonly content_preferences?: {
    readonly default_author?: string;
    readonly [key: string]: unknown;
  } | null;
  readonly shop_metadata?: {
    readonly name?: string;
    readonly shop_name?: string;
    readonly [key: string]: unknown;
  } | null;
  readonly [key: string]: unknown;
}

interface DatabasePost {
  readonly id: string;
  readonly store_id: string;
  readonly title: string;
  readonly content: string;
  readonly excerpt?: string | null;
  readonly seo_title?: string | null;
  readonly seo_description?: string | null;
  readonly keywords?: readonly string[] | null;
  readonly featured_image_url?: string | null;
  readonly shopify_article_id?: number | null;
  readonly [key: string]: unknown;
}

interface ProductData {
  readonly id: number;
  readonly title: string;
  readonly body_html?: string;
  readonly description?: string;
  readonly handle: string;
  readonly product_type?: string;
  readonly tags?: string;
  readonly variants?: ReadonlyArray<{ readonly price: string; readonly [key: string]: unknown }>;
  readonly images?: ReadonlyArray<{ readonly src: string; readonly [key: string]: unknown }>;
  readonly collections?: ReadonlyArray<unknown>;
  readonly published_at?: string;
}

interface CollectionData {
  readonly id: number;
  readonly title: string;
  readonly handle: string;
  readonly description?: string;
  readonly products_count?: number;
}

interface ShopData {
  readonly name?: string;
  readonly email?: string;
  readonly domain?: string;
  readonly currency?: string;
  readonly timezone?: string;
  readonly [key: string]: unknown;
}

interface GSCCredentials {
  readonly access_token?: string;
  readonly site_url?: string;
  readonly sitemap_url?: string;
}

interface SyncResult {
  readonly synced: number;
  readonly errors: number;
}

interface MetadataSyncResult {
  readonly synced: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface ShopifyArticle {
  readonly id?: number;
  readonly [key: string]: unknown;
}

interface PlanData {
  readonly id: string;
  readonly plan_name: string;
  readonly price_monthly?: number | string;
  readonly price_annual?: number | string;
}

const ENV_SUPABASE_URL = 'SUPABASE_URL' as const;
const ENV_SUPABASE_ANON_KEY = 'SUPABASE_ANON_KEY' as const;
const ENV_PUBLISH_SHOPIFY_TIMEOUT = 'PUBLISH_SHOPIFY_TIMEOUT' as const;
const ENV_SHOPIFY_SYNC_TIMEOUT = 'SHOPIFY_SYNC_TIMEOUT' as const;
const ENV_CORS_ORIGINS = 'CORS_ORIGINS' as const;
const ENV_MAX_REQUEST_SIZE = 'MAX_REQUEST_SIZE' as const;
const ENV_MAX_RETRIES = 'MAX_RETRIES' as const;
const ENV_RETRY_DELAY_MS = 'RETRY_DELAY_MS' as const;
const MIN_TOKEN_LENGTH = 10;
const BEARER_PREFIX = 'Bearer ' as const;
const BEARER_PREFIX_LENGTH = 7;
const ID_RADIX = 36;
const ID_LENGTH = 9;
const CORRELATION_PREFIX = 'shopify-api-' as const;
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
const ERROR_STORE_NOT_FOUND = 'Store not found' as const;
const ERROR_POST_NOT_FOUND = 'Post not found' as const;
const ERROR_POST_ID_REQUIRED = 'postId is required' as const;
const ERROR_STORE_ID_REQUIRED = 'storeId is required' as const;
const ERROR_PLAN_NAME_REQUIRED = 'planName is required' as const;
const ERROR_RETURN_URL_INVALID = 'returnUrl must be a string' as const;
const ERROR_SYNC_TYPE_INVALID = 'syncType must be one of: products, collections, metadata, all' as const;
const ERROR_CODE_UNAUTHORIZED = 'UNAUTHORIZED' as const;
const ERROR_CODE_CONFIG_ERROR = 'CONFIG_ERROR' as const;
const ERROR_CODE_STORE_NOT_FOUND = 'STORE_NOT_FOUND' as const;
const ERROR_CODE_POST_NOT_FOUND = 'POST_NOT_FOUND' as const;
const ERROR_CODE_INTERNAL_ERROR = 'INTERNAL_ERROR' as const;
const RETRY_BACKOFF_BASE = 2;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS_PUBLISH = 20;
const RATE_LIMIT_MAX_REQUESTS_SYNC = 10;
const RATE_LIMIT_MAX_REQUESTS_BILLING = 5;
const DEFAULT_TIMEOUT_PUBLISH = 120000;
const DEFAULT_TIMEOUT_SYNC = 300000;
const DEFAULT_MAX_REQUEST_SIZE = 10485760;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const TABLE_STORES = 'stores' as const;
const TABLE_BLOG_POSTS = 'blog_posts' as const;
const TABLE_PRODUCTS_CACHE = 'products_cache' as const;
const TABLE_COLLECTIONS_CACHE = 'collections_cache' as const;
const TABLE_ANALYTICS_INTEGRATIONS = 'analytics_integrations' as const;
const TABLE_PLAN_LIMITS = 'plan_limits' as const;
const COLUMN_SHOPIFY_PRODUCT_ID = 'shopify_product_id' as const;
const COLUMN_SHOPIFY_COLLECTION_ID = 'shopify_collection_id' as const;
const COLUMN_SYNCED_AT = 'synced_at' as const;
const COLUMN_ID = 'id' as const;
const COLUMN_STORE_ID = 'store_id' as const;
const COLUMN_SHOP_DOMAIN = 'shop_domain' as const;
const COLUMN_ACCESS_TOKEN = 'access_token' as const;
const COLUMN_SHOPIFY_BLOG_ID = 'shopify_blog_id' as const;
const COLUMN_SHOPIFY_ARTICLE_ID = 'shopify_article_id' as const;
const COLUMN_STATUS = 'status' as const;
const COLUMN_PUBLISHED_AT = 'published_at' as const;
const COLUMN_UPDATED_AT = 'updated_at' as const;
const COLUMN_SHOP_METADATA = 'shop_metadata' as const;
const COLUMN_CONTENT_PREFERENCES = 'content_preferences' as const;
const STATUS_PUBLISHED = 'published' as const;
const SYNC_TYPE_PRODUCTS = 'products' as const;
const SYNC_TYPE_COLLECTIONS = 'collections' as const;
const SYNC_TYPE_METADATA = 'metadata' as const;
const SYNC_TYPE_ALL = 'all' as const;
const INTEGRATION_TYPE_GSC = 'google_search_console' as const;
const INTERVAL_ANNUAL = 'ANNUAL' as const;
const INTERVAL_EVERY_30_DAYS = 'EVERY_30_DAYS' as const;
const CURRENCY_USD = 'USD' as const;
const DEFAULT_AUTHORIA_NAME = 'Authoria' as const;
const DEFAULT_EDITORIAL_SUFFIX = "'s Editorial" as const;
const STORE_NAME_PLACEHOLDER = '{Storename}' as const;
const PATH_SEPARATOR = '/' as const;
const ROUTE_PUBLISH = 'publish' as const;
const ROUTE_SYNC = 'sync' as const;
const ROUTE_CREATE_SUBSCRIPTION = 'create-subscription' as const;
const ERROR_INVALID_ROUTE = 'Invalid route. Use /publish, /sync, or /create-subscription' as const;

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
  DEFAULT_TIMEOUT_PUBLISH: parseInt(getEnv(ENV_PUBLISH_SHOPIFY_TIMEOUT, String(DEFAULT_TIMEOUT_PUBLISH)), 10),
  DEFAULT_TIMEOUT_SYNC: parseInt(getEnv(ENV_SHOPIFY_SYNC_TIMEOUT, String(DEFAULT_TIMEOUT_SYNC)), 10),
  DEFAULT_TIMEOUT: Math.max(
    parseInt(getEnv(ENV_PUBLISH_SHOPIFY_TIMEOUT, String(DEFAULT_TIMEOUT_PUBLISH)), 10),
    parseInt(getEnv(ENV_SHOPIFY_SYNC_TIMEOUT, String(DEFAULT_TIMEOUT_SYNC)), 10),
  ),
  CORS_ORIGINS: getEnv(ENV_CORS_ORIGINS, '*').split(','),
  MAX_REQUEST_SIZE: parseInt(getEnv(ENV_MAX_REQUEST_SIZE, String(DEFAULT_MAX_REQUEST_SIZE)), 10),
  MAX_RETRIES: parseInt(getEnv(ENV_MAX_RETRIES, String(DEFAULT_MAX_RETRIES)), 10),
  RETRY_DELAY_MS: parseInt(getEnv(ENV_RETRY_DELAY_MS, String(DEFAULT_RETRY_DELAY_MS)), 10),
} as const;

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

function validatePublishParams(params: PublishBody | Readonly<Record<string, unknown>>): ValidationResult {
  if (!params.postId || typeof params.postId !== 'string') {
    return { valid: false, error: ERROR_POST_ID_REQUIRED };
  }

  if (!params.storeId || typeof params.storeId !== 'string') {
    return { valid: false, error: ERROR_STORE_ID_REQUIRED };
  }

  return { valid: true };
}

function validateSyncParams(params: SyncBody | Readonly<Record<string, unknown>>): ValidationResult {
  if (!params.storeId || typeof params.storeId !== 'string') {
    return { valid: false, error: ERROR_STORE_ID_REQUIRED };
  }

  const validSyncTypes = [SYNC_TYPE_PRODUCTS, SYNC_TYPE_COLLECTIONS, SYNC_TYPE_METADATA, SYNC_TYPE_ALL] as const;
  if (params.syncType && !validSyncTypes.includes(params.syncType as typeof validSyncTypes[number])) {
    return { valid: false, error: ERROR_SYNC_TYPE_INVALID };
  }

  return { valid: true };
}

function validateSubscriptionParams(params: CreateSubscriptionBody | Readonly<Record<string, unknown>>): ValidationResult {
  if (!params.storeId || typeof params.storeId !== 'string') {
    return { valid: false, error: ERROR_STORE_ID_REQUIRED };
  }

  if (!params.planName || typeof params.planName !== 'string') {
    return { valid: false, error: ERROR_PLAN_NAME_REQUIRED };
  }

  if (params.returnUrl && typeof params.returnUrl !== 'string') {
    return { valid: false, error: ERROR_RETURN_URL_INVALID };
  }

  return { valid: true };
}

function generateCorrelationId(): string {
  return `${CORRELATION_PREFIX}${Date.now()}-${Math.random().toString(ID_RADIX).substring(2, 2 + ID_LENGTH)}`;
}


async function submitSitemapToGSC(
  supabase: Awaited<ReturnType<typeof getSupabaseClient>>,
  storeId: string,
  shopDomain: string,
  correlationId: string,
): Promise<void> {
  try {
    const { data: integration, error: integrationError } = await supabase
      .from(TABLE_ANALYTICS_INTEGRATIONS)
      .select('credentials')
      .eq(COLUMN_STORE_ID, storeId)
      .eq('integration_type', INTEGRATION_TYPE_GSC)
      .eq('is_active', true)
      .single();

    if (integrationError || !integration) {
      return;
    }

    const credentials = integration.credentials as GSCCredentials;

    if (!credentials.access_token || !credentials.site_url) {
      return;
    }

    const { GoogleSearchConsole } = await import('../backend/src/integrations/GoogleServices.ts');
    const gsc = new GoogleSearchConsole({
      accessToken: credentials.access_token,
      siteUrl: credentials.site_url,
    });

    let sitemapUrl = credentials.sitemap_url;

    if (!sitemapUrl) {
      try {
        sitemapUrl = await gsc.detectSitemapUrl();

        if (sitemapUrl) {
          const updatedCredentials: GSCCredentials = {
            ...credentials,
            sitemap_url: sitemapUrl,
          };

          await supabase
            .from(TABLE_ANALYTICS_INTEGRATIONS)
            .update({ credentials: updatedCredentials })
            .eq(COLUMN_STORE_ID, storeId)
            .eq('integration_type', INTEGRATION_TYPE_GSC);

          logger.info('Detected and saved sitemap URL', {
            correlationId,
            storeId,
            sitemapUrl,
          });
        }
      } catch (error) {
        logger.warn('Failed to detect sitemap URL', {
          correlationId,
          storeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (sitemapUrl) {
      const result = await gsc.submitSitemapUrl(sitemapUrl);
      if (result.success) {
        logger.info('Sitemap submitted to GSC successfully', {
          correlationId,
          storeId,
          sitemapUrl,
        });
      } else {
        logger.warn('Sitemap submission to GSC failed', {
          correlationId,
          storeId,
          sitemapUrl,
          error: result.message,
        });
      }
    } else {
      const articleUrl = `https://${shopDomain}/blogs/news`;
      const fallbackResult = await gsc.submitSitemapForArticle(articleUrl);
      if (fallbackResult.success) {
        logger.info('Sitemap submitted to GSC via fallback method', {
          correlationId,
          storeId,
          message: fallbackResult.message,
        });
      }
    }
  } catch (error) {
    logger.warn('Error submitting sitemap to GSC', {
      correlationId,
      storeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
    req: req as ShopifyRequest,
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
      const rateLimitKey = `shopify-api:${ctx.userId ?? 'anonymous'}`;
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
  options: { readonly compression?: boolean; readonly request?: Request; readonly warnings?: ReadonlyArray<string> } = {},
): Promise<Response> {
  const response: ShopifyResponse = {
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
  const response: ShopifyResponse = {
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

async function syncProducts(
  supabase: Awaited<ReturnType<typeof getSupabaseClient>>,
  store: DatabaseStore,
  correlationId: string,
): Promise<SyncResult> {
  const { ShopifyAPI, ShopifyError, ShopifyErrorType } = await import('../backend/src/integrations/ShopifyClient.ts');
  const shopifyAPI = new ShopifyAPI(store.shop_domain, store.access_token);

  try {
    const products = await shopifyAPI.getProducts(store.shop_domain, store.access_token);

    let synced = 0;
    let errors = 0;

    for (const product of products) {
      try {
        const productData = product as ProductData;

        const minPrice = productData.variants && productData.variants.length > 0
          ? Math.min(...productData.variants.map((v) => parseFloat(v.price)))
          : 0;

        const { error: upsertError } = await supabase
          .from(TABLE_PRODUCTS_CACHE)
          .upsert({
            [COLUMN_STORE_ID]: store.id,
            [COLUMN_SHOPIFY_PRODUCT_ID]: productData.id,
            title: productData.title,
            description: productData.body_html || productData.description || '',
            handle: productData.handle,
            product_type: productData.product_type || null,
            tags: productData.tags ? productData.tags.split(',').map((t) => t.trim()) : [],
            price: minPrice,
            images: productData.images || [],
            variants: productData.variants || [],
            collections: productData.collections || [],
            is_published: !!productData.published_at,
            [COLUMN_SYNCED_AT]: new Date().toISOString(),
            [COLUMN_UPDATED_AT]: new Date().toISOString(),
          }, {
            onConflict: `${COLUMN_STORE_ID},${COLUMN_SHOPIFY_PRODUCT_ID}`,
          });

        if (upsertError) {
          logger.error('Failed to upsert product', {
            correlationId,
            productId: productData.id,
            error: upsertError.message,
          });
          errors++;
        } else {
          synced++;
        }
      } catch (error) {
        logger.error('Error processing product', {
          correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
        errors++;
      }
    }

    return { synced, errors };
  } catch (error) {
    logger.error('Failed to sync products', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof ShopifyError ? error.type : 'unknown',
    });

    if (error instanceof ShopifyError) {
      if (error.type === ShopifyErrorType.RATE_LIMIT) {
        throw new UtilsError(
          'Shopify API rate limit exceeded. Please try again later.',
          ERROR_CODE_INTERNAL_ERROR as string,
          STATUS_TOO_MANY_REQUESTS,
        );
      }
      if (error.type === ShopifyErrorType.AUTHENTICATION_FAILED) {
        throw new UtilsError(
          'Shopify authentication failed. Please reconnect your store.',
          ERROR_CODE_INTERNAL_ERROR as string,
          STATUS_UNAUTHORIZED,
        );
      }
    }

    throw error;
  }
}

async function syncCollections(
  supabase: Awaited<ReturnType<typeof getSupabaseClient>>,
  store: DatabaseStore,
  correlationId: string,
): Promise<SyncResult> {
  const { ShopifyAPI, ShopifyError, ShopifyErrorType } = await import('../backend/src/integrations/ShopifyClient.ts');
  const shopifyAPI = new ShopifyAPI(store.shop_domain, store.access_token);

  try {
    const collections = await shopifyAPI.getCollections(store.shop_domain, store.access_token);

    let synced = 0;
    let errors = 0;

    for (const collection of collections) {
      try {
        const collectionData = collection as CollectionData;

        const { error: upsertError } = await supabase
          .from(TABLE_COLLECTIONS_CACHE)
          .upsert({
            [COLUMN_STORE_ID]: store.id,
            [COLUMN_SHOPIFY_COLLECTION_ID]: collectionData.id,
            title: collectionData.title,
            handle: collectionData.handle,
            description: collectionData.description || null,
            products_count: collectionData.products_count || 0,
            [COLUMN_SYNCED_AT]: new Date().toISOString(),
          }, {
            onConflict: `${COLUMN_STORE_ID},${COLUMN_SHOPIFY_COLLECTION_ID}`,
          });

        if (upsertError) {
          logger.error('Failed to upsert collection', {
            correlationId,
            collectionId: collectionData.id,
            error: upsertError.message,
          });
          errors++;
        } else {
          synced++;
        }
      } catch (error) {
        logger.error('Error processing collection', {
          correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
        errors++;
      }
    }

    return { synced, errors };
  } catch (error) {
    logger.error('Failed to sync collections', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof ShopifyError ? error.type : 'unknown',
    });

    if (error instanceof ShopifyError) {
      if (error.type === ShopifyErrorType.RATE_LIMIT) {
        throw new UtilsError(
          'Shopify API rate limit exceeded. Please try again later.',
          ERROR_CODE_INTERNAL_ERROR as string,
          STATUS_TOO_MANY_REQUESTS,
        );
      }
      if (error.type === ShopifyErrorType.AUTHENTICATION_FAILED) {
        throw new UtilsError(
          'Shopify authentication failed. Please reconnect your store.',
          ERROR_CODE_INTERNAL_ERROR as string,
          STATUS_UNAUTHORIZED,
        );
      }
    }

    throw error;
  }
}

async function syncStoreMetadata(
  supabase: Awaited<ReturnType<typeof getSupabaseClient>>,
  store: DatabaseStore,
  correlationId: string,
): Promise<MetadataSyncResult> {
  const { ShopifyAPI, ShopifyError, ShopifyErrorType } = await import('../backend/src/integrations/ShopifyClient.ts');
  const shopifyAPI = new ShopifyAPI(store.shop_domain, store.access_token);

  try {
    const shopData = await shopifyAPI.getShop(store.shop_domain, store.access_token);

    const shop = shopData as ShopData;

    const metadata: Readonly<Record<string, unknown>> = {
      shop_name: shop.name,
      shop_email: shop.email,
      shop_domain: shop.domain,
      currency: shop.currency,
      timezone: shop.timezone,
      ...shop,
    };

    const { error: updateError } = await supabase
      .from(TABLE_STORES)
      .update({
        [COLUMN_SHOP_METADATA]: metadata,
        [COLUMN_UPDATED_AT]: new Date().toISOString(),
      })
      .eq(COLUMN_ID, store.id);

    if (updateError) {
      throw new SupabaseClientError('Failed to update store metadata', updateError);
    }

    return { synced: true, metadata };
  } catch (error) {
    logger.error('Failed to sync store metadata', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof ShopifyError ? error.type : 'unknown',
    });

    if (error instanceof ShopifyError) {
      if (error.type === ShopifyErrorType.RATE_LIMIT) {
        throw new UtilsError(
          'Shopify API rate limit exceeded. Please try again later.',
          ERROR_CODE_INTERNAL_ERROR as string,
          STATUS_TOO_MANY_REQUESTS,
        );
      }
      if (error.type === ShopifyErrorType.AUTHENTICATION_FAILED) {
        throw new UtilsError(
          'Shopify authentication failed. Please reconnect your store.',
          ERROR_CODE_INTERNAL_ERROR as string,
          STATUS_UNAUTHORIZED,
        );
      }
    }

    throw error;
  }
}

function formatStoreName(shopDomain: string, shopMetadata?: { readonly name?: string; readonly shop_name?: string } | null): string {
  let storeName = (shopMetadata?.name || shopMetadata?.shop_name || shopDomain || DEFAULT_AUTHORIA_NAME) as string;

  if (storeName.includes('.')) {
    storeName = storeName.split('.')[0]!;
  }

  storeName = storeName
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

  return storeName;
}

function resolveAuthor(storeName: string, contentPreferences?: { readonly default_author?: string } | null): string {
  const defaultAuthorTemplate = contentPreferences?.default_author || `${storeName}${DEFAULT_EDITORIAL_SUFFIX}`;
  return defaultAuthorTemplate.replace(STORE_NAME_PLACEHOLDER, storeName);
}

async function handlePublishToShopify(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  const warnings: string[] = [];

  try {
    const body = await req.json() as PublishBody;
    const validation = validatePublishParams(body);

    if (!validation.valid) {
      return createErrorResponse(validation.error ?? ERROR_INVALID_INPUT, STATUS_BAD_REQUEST, correlationId, undefined, req);
    }

    if (validation.warnings) {
      warnings.push(...validation.warnings);
    }

    const postId = body.postId!;
    const storeId = body.storeId!;

    const [{ data: store, error: storeError }, { data: post, error: postError }] = await Promise.all([
      retryOperation(
        async () => {
          const result = await supabase
            .from(TABLE_STORES)
            .select(`${COLUMN_ID}, ${COLUMN_SHOP_DOMAIN}, ${COLUMN_ACCESS_TOKEN}, ${COLUMN_SHOPIFY_BLOG_ID}, ${COLUMN_CONTENT_PREFERENCES}, ${COLUMN_SHOP_METADATA}`)
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
      ),
      retryOperation(
        async () => {
          const result = await supabase
            .from(TABLE_BLOG_POSTS)
            .select('*')
            .eq(COLUMN_ID, postId)
            .single();

          if (result.error) {
            throw new SupabaseClientError('Failed to fetch post', result.error);
          }
          if (!result.data) {
            throw new UtilsError(ERROR_POST_NOT_FOUND, ERROR_CODE_POST_NOT_FOUND as string, STATUS_NOT_FOUND);
          }
          return result;
        },
        CONFIG.MAX_RETRIES,
        CONFIG.RETRY_DELAY_MS,
        'fetch_post',
      ),
    ]);

    if (storeError || !store) {
      throw new UtilsError(ERROR_STORE_NOT_FOUND, ERROR_CODE_STORE_NOT_FOUND as string, STATUS_NOT_FOUND);
    }

    if (postError || !post) {
      throw new UtilsError(ERROR_POST_NOT_FOUND, ERROR_CODE_POST_NOT_FOUND as string, STATUS_NOT_FOUND);
    }

    const storeData = store as unknown as DatabaseStore;
    const postData = post as unknown as DatabasePost;

    const { ShopifyClient } = await import('../backend/src/integrations/ShopifyClient.ts');
    const shopifyClient = new ShopifyClient(storeData.shop_domain, storeData.access_token);
    const shopifyAPI = shopifyClient.rest;

    let blogId = body.blogId || storeData.shopify_blog_id;
    if (!blogId) {
      const blogs = await shopifyAPI.getBlogs(storeData.shop_domain, storeData.access_token);
      if (blogs.length === 0) {
        throw new UtilsError('No blog found in Shopify store', ERROR_CODE_INTERNAL_ERROR as string, STATUS_NOT_FOUND);
      }
      blogId = (blogs[0] as { id?: number }).id;
    }

    if (!blogId) {
      throw new UtilsError('No blog ID available', ERROR_CODE_INTERNAL_ERROR as string, STATUS_NOT_FOUND);
    }

    const storeName = formatStoreName(storeData.shop_domain, storeData.shop_metadata);
    const author = resolveAuthor(storeName, storeData.content_preferences);

    const articleData = {
      title: postData.title,
      body_html: postData.content,
      summary: postData.excerpt || undefined,
      author,
      tags: (postData.keywords || []).join(', '),
      published: body.published !== false,
      published_at: body.published !== false ? new Date().toISOString() : undefined,
    };

    let shopifyArticle: ShopifyArticle | null = null;
    let shopifyArticleId: number | null = null;

    if (postData.shopify_article_id) {
      try {
        shopifyArticle = await shopifyAPI.updateBlogArticle(
          storeData.shop_domain,
          storeData.access_token,
          blogId,
          postData.shopify_article_id,
          articleData,
        ) as ShopifyArticle;
        shopifyArticleId = postData.shopify_article_id;
      } catch (error) {
        logger.warn('Failed to update article, creating new one', {
          correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
        warnings.push('Failed to update existing article, creating new one');
      }
    }

    if (!shopifyArticle) {
      shopifyArticle = await shopifyAPI.createBlogArticle(
        storeData.shop_domain,
        storeData.access_token,
        blogId,
        articleData,
      ) as ShopifyArticle;
      shopifyArticleId = shopifyArticle.id || null;
    }

    await retryOperation(
      async () => {
        const updates: Record<string, unknown> = {
          [COLUMN_STATUS]: STATUS_PUBLISHED,
          [COLUMN_PUBLISHED_AT]: new Date().toISOString(),
          [COLUMN_UPDATED_AT]: new Date().toISOString(),
        };

        if (shopifyArticleId) {
          updates[COLUMN_SHOPIFY_ARTICLE_ID] = shopifyArticleId;
        }

        const result = await supabase
          .from(TABLE_BLOG_POSTS)
          .update(updates)
          .eq(COLUMN_ID, postId);

        if (result.error) {
          throw new SupabaseClientError('Failed to update post', result.error);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
      'update_post',
    );

    if (shopifyArticleId && body.published !== false) {
      try {
        await submitSitemapToGSC(supabase, storeId, storeData.shop_domain, correlationId);
      } catch (error) {
        logger.warn('Failed to submit sitemap to GSC', {
          correlationId,
          storeId,
          error: error instanceof Error ? error.message : String(error),
        });
        warnings.push('Sitemap submission to Google Search Console failed');
      }
    }

    logger.info('Article published to Shopify', {
      correlationId,
      postId,
      storeId,
      blogId,
      shopifyArticleId,
      warnings: warnings.length,
    });

    return createSuccessResponse(
      {
        success: true,
        shopifyArticle,
        shopifyArticleId,
        blogId,
      },
      correlationId,
      {},
      { compression: true, request: req, warnings: warnings.length > 0 ? warnings : undefined },
    );
  } catch (error) {
    logger.error('Failed to publish to Shopify', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    if (error instanceof Error && error.message.includes('rate limit')) {
      return createErrorResponse(
        'Shopify API rate limit exceeded. Please try again later.',
        STATUS_TOO_MANY_REQUESTS,
        correlationId,
        { retryAfter: 60 },
        req,
      );
    }

    throw error;
  }
}

async function handleShopifySync(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  const warnings: string[] = [];

  try {
    const body = await req.json() as SyncBody;
    const validation = validateSyncParams(body);

    if (!validation.valid) {
      return createErrorResponse(validation.error ?? ERROR_INVALID_INPUT, STATUS_BAD_REQUEST, correlationId, undefined, req);
    }

    if (validation.warnings) {
      warnings.push(...validation.warnings);
    }

    const storeId = body.storeId!;
    const syncType = body.syncType || SYNC_TYPE_ALL;

    const { data: store, error: storeError } = await retryOperation(
      async () => {
        const result = await supabase
          .from(TABLE_STORES)
          .select(`${COLUMN_ID}, ${COLUMN_SHOP_DOMAIN}, ${COLUMN_ACCESS_TOKEN}`)
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
    const results: Record<string, unknown> = {};

    if (syncType === SYNC_TYPE_PRODUCTS || syncType === SYNC_TYPE_ALL) {
      try {
        const productResult = await syncProducts(supabase, storeData, correlationId);
        results.products = productResult;
      } catch (error) {
        logger.error('Product sync failed', {
          correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
        warnings.push('Product sync failed');
        results.products = { synced: 0, errors: 1 };
      }
    }

    if (syncType === SYNC_TYPE_COLLECTIONS || syncType === SYNC_TYPE_ALL) {
      try {
        const collectionResult = await syncCollections(supabase, storeData, correlationId);
        results.collections = collectionResult;
      } catch (error) {
        logger.error('Collection sync failed', {
          correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
        warnings.push('Collection sync failed');
        results.collections = { synced: 0, errors: 1 };
      }
    }

    if (syncType === SYNC_TYPE_METADATA || syncType === SYNC_TYPE_ALL) {
      try {
        const metadataResult = await syncStoreMetadata(supabase, storeData, correlationId);
        results.metadata = metadataResult;
      } catch (error) {
        logger.error('Metadata sync failed', {
          correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
        warnings.push('Metadata sync failed');
        results.metadata = { synced: false };
      }
    }

    logger.info('Shopify sync completed', {
      correlationId,
      storeId,
      syncType,
      results,
      warnings: warnings.length,
    });

    return createSuccessResponse(
      results,
      correlationId,
      {},
      { compression: true, request: req, warnings: warnings.length > 0 ? warnings : undefined },
    );
  } catch (error) {
    logger.error('Shopify sync failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

async function handleCreateSubscription(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;

  try {
    const body = await req.json() as CreateSubscriptionBody;
    const validation = validateSubscriptionParams(body);

    if (!validation.valid) {
      return createErrorResponse(validation.error ?? ERROR_INVALID_INPUT, STATUS_BAD_REQUEST, correlationId, undefined, req);
    }

    const storeId = body.storeId!;
    const planName = body.planName!;
    const isAnnual = body.isAnnual === true;
    const origin = req.headers.get('origin');
    const returnUrl = body.returnUrl || (origin ? `${origin}/settings/billing` : '/settings/billing');

    const { data: store, error: storeError } = await retryOperation(
      async () => {
        const result = await supabase
          .from(TABLE_STORES)
          .select(`${COLUMN_ID}, ${COLUMN_SHOP_DOMAIN}, ${COLUMN_ACCESS_TOKEN}`)
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

    const { data: plan, error: planError } = await supabase
      .from(TABLE_PLAN_LIMITS)
      .select('id, plan_name, price_monthly, price_annual')
      .eq('plan_name', planName)
      .single();

    if (planError || !plan) {
      throw new UtilsError(`Plan '${planName}' not found`, ERROR_CODE_CONFIG_ERROR as string, STATUS_BAD_REQUEST);
    }

    const planData = plan as unknown as PlanData;

    const { ShopifyBilling } = await import('../backend/src/integrations/ShopifyBilling.ts');
    const shopifyBilling = new ShopifyBilling(supabase, storeData.shop_domain, storeData.access_token);

    const priceAmount = isAnnual
      ? (typeof planData.price_annual === 'string' ? parseFloat(planData.price_annual) : (planData.price_annual as number))
      : (typeof planData.price_monthly === 'string' ? parseFloat(planData.price_monthly) : (planData.price_monthly as number));

    if (!priceAmount || isNaN(priceAmount)) {
      throw new UtilsError(`Invalid price for plan '${planName}'`, ERROR_CODE_CONFIG_ERROR as string, STATUS_INTERNAL_ERROR);
    }

    const interval = isAnnual ? INTERVAL_ANNUAL : INTERVAL_EVERY_30_DAYS;
    const planDisplayName = `${planName.charAt(0).toUpperCase()}${planName.slice(1)} Plan`;

    const input = {
      name: planDisplayName,
      returnUrl,
      test: true,
      lineItems: [{
        plan: {
          appRecurringPricingDetails: {
            price: {
              amount: priceAmount,
              currencyCode: CURRENCY_USD,
            },
            interval: interval as 'EVERY_30_DAYS' | 'ANNUAL',
          },
        },
      }],
    };

    const result = await shopifyBilling.createSubscription(input);

    if (result.userErrors && result.userErrors.length > 0) {
      const errorMsg = result.userErrors.map((e: { message: string }) => e.message).join(', ');
      throw new UtilsError(`Shopify Billing Error: ${errorMsg}`, ERROR_CODE_INTERNAL_ERROR as string, STATUS_INTERNAL_ERROR);
    }

    if (!result.confirmationUrl) {
      throw new UtilsError('Failed to generate confirmation URL', ERROR_CODE_INTERNAL_ERROR as string, STATUS_INTERNAL_ERROR);
    }

    logger.info('Subscription confirmation URL generated', {
      correlationId,
      storeId,
      planName,
      confirmationUrl: result.confirmationUrl,
    });

    return createSuccessResponse(
      {
        confirmationUrl: result.confirmationUrl,
      },
      correlationId,
      {},
      { compression: true, request: req },
    );
  } catch (error) {
    logger.error('Create subscription failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

async function routeRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathParts = url.pathname.split(PATH_SEPARATOR).filter((p) => p);
  const route = pathParts[pathParts.length - 1] || '';

  if (route === ROUTE_PUBLISH) {
    const config: EndpointConfig = {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_MAX_REQUESTS_PUBLISH, windowMs: RATE_LIMIT_WINDOW_MS },
      timeout: CONFIG.DEFAULT_TIMEOUT_PUBLISH,
      validateInput: validatePublishParams,
      maxRequestSize: CONFIG.MAX_REQUEST_SIZE,
    };
    return await handleRequest(req, handlePublishToShopify, config);
  }

  if (route === ROUTE_SYNC) {
    const config: EndpointConfig = {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_MAX_REQUESTS_SYNC, windowMs: RATE_LIMIT_WINDOW_MS },
      timeout: CONFIG.DEFAULT_TIMEOUT_SYNC,
      validateInput: validateSyncParams,
      maxRequestSize: CONFIG.MAX_REQUEST_SIZE,
    };
    return await handleRequest(req, handleShopifySync, config);
  }

  if (route === ROUTE_CREATE_SUBSCRIPTION) {
    const config: EndpointConfig = {
      requiresAuth: true,
      rateLimit: { maxRequests: RATE_LIMIT_MAX_REQUESTS_BILLING, windowMs: RATE_LIMIT_WINDOW_MS },
      timeout: CONFIG.DEFAULT_TIMEOUT,
      validateInput: validateSubscriptionParams,
      maxRequestSize: CONFIG.MAX_REQUEST_SIZE,
    };
    return await handleRequest(req, handleCreateSubscription, config);
  }

  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  return createErrorResponse(ERROR_INVALID_ROUTE, STATUS_BAD_REQUEST, correlationId, undefined, req);
}

serve(async (req: Request) => {
  if (req.method === METHOD_OPTIONS) {
    return new Response(null, {
      status: 204,
      headers: createCORSHeaders(req, CONFIG.CORS_ORIGINS),
    });
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
      { errorCode: error instanceof UtilsError ? error.code : ERROR_CODE_INTERNAL_ERROR as string },
      req,
    );
  }
});
