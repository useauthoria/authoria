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
import type { BlogPostContent } from '../backend/src/core/BlogComposer.ts';
import { PlanManager } from '../backend/src/core/PlanManager.ts';
import { GDPRDataGuard } from '../backend/src/core/GDPRDataGuard.ts';
import { BlogComposer } from '../backend/src/core/BlogComposer.ts';
import { KeywordMiner } from '../backend/src/core/KeywordMiner.ts';
import { SEOOptimizer } from '../backend/src/core/SEOOptimizer.ts';
import { ContentGraph } from '../backend/src/core/ContentGraph.ts';
import { ProductContextEngine } from '../backend/src/core/ProductContextEngine.ts';
import { ImageGenerator } from '../backend/src/core/ImageGenerator.ts';
import { JobQueue } from '../backend/src/core/JobQueue.ts';
import { ShopifyClient } from '../backend/src/integrations/ShopifyClient.ts';
import { ArticlesQueue } from '../backend/src/core/ArticlesQueue.ts';

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
  readonly supabase: Awaited<ReturnType<typeof getSupabaseClient>>;
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
  readonly regenerateFrom?: string;
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

interface DatabasePost {
  readonly id: string;
  readonly store_id: string;
  readonly [key: string]: unknown;
}

interface DatabaseStore {
  readonly id: string;
  readonly plan_id?: string | null;
  readonly tone_matrix?: Readonly<Record<string, number>> | null;
  readonly brand_dna?: Readonly<Record<string, unknown>> | null;
  readonly is_active: boolean;
  readonly shop_domain: string;
  readonly access_token: string;
  readonly content_preferences?: {
    readonly topic_preferences?: string[];
    readonly keyword_focus?: string[];
    readonly content_angles?: string[];
  };
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
const METHOD_PATCH = 'PATCH';
const METHOD_DELETE = 'DELETE';
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
const CORS_METHODS_VALUE = 'GET, POST, PATCH, DELETE, OPTIONS';
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
const PARAM_STORE_UUID = 'p_store_uuid';
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
const COLUMN_TONE_MATRIX = 'tone_matrix';
const COLUMN_BRAND_DNA = 'brand_dna';
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
const COLUMN_CONTENT = 'content';
const COLUMN_EXCERPT = 'excerpt';
const COLUMN_SEO_TITLE = 'seo_title';
const COLUMN_SEO_DESCRIPTION = 'seo_description';
const COLUMN_KEYWORDS = 'keywords';
const COLUMN_PRIMARY_KEYWORD = 'primary_keyword';
const COLUMN_PRODUCT_MENTIONS = 'product_mentions';
const COLUMN_FEATURED_IMAGE_URL = 'featured_image_url';
const COLUMN_STRUCTURED_DATA = 'structured_data';
const COLUMN_SCHEDULED_PUBLISH_AT = 'scheduled_publish_at';
const COLUMN_UPDATED_AT = 'updated_at';
const COLUMN_STATUS = 'status';
const STATUS_PUBLISHED = 'published';
const STATUS_DRAFT = 'draft';
const STATUS_SCHEDULED = 'scheduled';
const STATUS_ARCHIVED = 'archived';
const VALID_STATUSES: ReadonlyArray<string> = [STATUS_PUBLISHED, STATUS_DRAFT, STATUS_SCHEDULED, STATUS_ARCHIVED, 'queued'];
const ERROR_POST_NOT_FOUND = 'Post not found';
const ERROR_POST_ID_REQUIRED = 'postId is required';
const ERROR_CODE_POST_NOT_FOUND = 'POST_NOT_FOUND';
const ENV_FLUX_API_KEY = 'FLUX_API_KEY';
const ENV_CREATE_POST_TIMEOUT = 'CREATE_POST_TIMEOUT';
const ENV_ENABLE_IMAGE_GENERATION = 'ENABLE_IMAGE_GENERATION';
const ENV_ENABLE_LLM_SNIPPETS = 'ENABLE_LLM_SNIPPETS';
const ENV_ENABLE_SEO_OPTIMIZATION = 'ENABLE_SEO_OPTIMIZATION';
const ENV_ENABLE_PRODUCT_MENTIONS = 'ENABLE_PRODUCT_MENTIONS';
const ENV_ENABLE_INTERNAL_LINKS = 'ENABLE_INTERNAL_LINKS';
const DEFAULT_CREATE_POST_TIMEOUT = 300000;
const DEFAULT_MAX_REQUEST_SIZE_POSTS = 10485760;
const MAX_KEYWORDS = 50;
const MAX_TOPIC_LENGTH = 500;
const IMAGE_WIDTH = 1280;
const IMAGE_HEIGHT = 720;
const IMAGE_FORMAT = 'webp';
const IMAGE_QUALITY = 85;
const JOB_PRIORITY_NORMAL = 'normal';
const JOB_MAX_ATTEMPTS = 3;
const JOB_TYPE_LLM_SNIPPET = 'llm_snippet';
const DEFAULT_TONE_MATRIX: Readonly<Record<string, number>> = {
  expert: 0.3,
  conversational: 0.3,
  aspirational: 0.2,
  friendly: 0.2,
};
const RATE_LIMIT_WINDOW_MS = 60000;
const CACHE_TTL_QUOTA = 120000;
const CACHE_TTL_POSTS = 120000;
const CACHE_TTL_ANALYTICS = 600000;
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
  FLUX_API_KEY: getEnv(ENV_FLUX_API_KEY, ''),
  GOOGLE_CLIENT_ID: getEnv('GOOGLE_CLIENT_ID', ''),
  GOOGLE_CLIENT_SECRET: getEnv('GOOGLE_CLIENT_SECRET', ''),
  ENABLE_CACHING: getEnv(ENV_ENABLE_CACHING, 'true') !== 'false',
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_TIMEOUT,
  CREATE_POST_TIMEOUT: parseInt(getEnv(ENV_CREATE_POST_TIMEOUT, String(DEFAULT_CREATE_POST_TIMEOUT))),
  ENABLE_AUDIT_LOGGING: true,
  ENABLE_METRICS: true,
  CORS_ORIGINS: getEnv(ENV_CORS_ORIGINS, '*').split(','),
  MAX_REQUEST_SIZE: parseInt(getEnv(ENV_MAX_REQUEST_SIZE, String(DEFAULT_MAX_REQUEST_SIZE))),
  MAX_BATCH_SIZE: parseInt(getEnv(ENV_MAX_BATCH_SIZE, String(DEFAULT_MAX_BATCH_SIZE))),
  MAX_REQUEST_SIZE_TRACK: parseInt(getEnv(ENV_MAX_REQUEST_SIZE, String(DEFAULT_MAX_REQUEST_SIZE_TRACK))),
  ENABLE_RETRY: getEnv(ENV_ENABLE_RETRY, 'true') !== 'false',
  MAX_RETRIES: parseInt(getEnv(ENV_MAX_RETRIES, String(DEFAULT_MAX_RETRIES))),
  RETRY_DELAY_MS: parseInt(getEnv(ENV_RETRY_DELAY_MS, String(DEFAULT_RETRY_DELAY_MS))),
  ENABLE_IMAGE_GENERATION: getEnv(ENV_ENABLE_IMAGE_GENERATION, 'true') !== 'false',
  ENABLE_LLM_SNIPPETS: getEnv(ENV_ENABLE_LLM_SNIPPETS, 'true') !== 'false',
  ENABLE_SEO_OPTIMIZATION: getEnv(ENV_ENABLE_SEO_OPTIMIZATION, 'true') !== 'false',
  ENABLE_PRODUCT_MENTIONS: getEnv(ENV_ENABLE_PRODUCT_MENTIONS, 'true') !== 'false',
  ENABLE_INTERNAL_LINKS: getEnv(ENV_ENABLE_INTERNAL_LINKS, 'true') !== 'false',
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

const storeIdCache = new Map<string, { readonly storeId: string; readonly timestamp: number }>();
const STORE_ID_CACHE_TTL = 5 * 60 * 1000;

async function resolveStoreIdFromShopDomain(
  shopDomain: string,
  supabase: Awaited<ReturnType<typeof getSupabaseClient>>,
  correlationId: string,
): Promise<string | null> {
  if (!shopDomain) {
    return null;
  }

  // Check cache first
  const cached = storeIdCache.get(shopDomain);
  if (cached && Date.now() - cached.timestamp < STORE_ID_CACHE_TTL) {
    logger.debug('StoreId cache hit', { correlationId, shopDomain, storeId: cached.storeId });
    return cached.storeId;
  }

  // Cache miss - look up in database
  try {
    // Try service role client first (bypasses RLS)
    const serviceSupabase = await getSupabaseClient({ clientType: 'service' });
    const { data: store, error } = await serviceSupabase
      .from(TABLE_STORES)
      .select(COLUMN_ID)
      .eq(COLUMN_SHOP_DOMAIN, shopDomain)
      .single();

    if (error || !store) {
      logger.debug('Store not found for shopDomain', { correlationId, shopDomain, error: error?.message });
      return null;
    }

    // Cache the result
    storeIdCache.set(shopDomain, { storeId: store.id, timestamp: Date.now() });
    logger.debug('StoreId resolved and cached', { correlationId, shopDomain, storeId: store.id });
    
    return store.id;
  } catch (error) {
    logger.error('Error resolving storeId from shopDomain', {
      correlationId,
      shopDomain,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function extractShopDomainFromPath(url: URL): string | null {
  const pathParts = url.pathname.split(PATH_SEPARATOR).filter((p) => p);
  const storeIndex = pathParts.indexOf('store');
  
  if (storeIndex !== -1 && storeIndex < pathParts.length - 1) {
    return pathParts[storeIndex + 1] || null;
  }
  
  return null;
}

async function resolveStoreId(
  ctx: RequestContext,
  options: {
    queryParams?: URLSearchParams;
    body?: { storeId?: string; shopDomain?: string };
    shopDomain?: string;
  } = {},
): Promise<{ storeId: string | null; shopDomain: string | null; source: string }> {
  const { correlationId, supabase } = ctx;
  
  // 1. Try query params
  if (options.queryParams) {
    const storeIdFromParams = options.queryParams.get(PARAM_STORE_ID);
    if (storeIdFromParams) {
      return { storeId: storeIdFromParams, shopDomain: options.shopDomain || null, source: 'query_params' };
    }
    
    // Try shopDomain from query params
    const shopDomainFromParams = options.queryParams.get('shopDomain');
    if (shopDomainFromParams) {
      const resolvedId = await resolveStoreIdFromShopDomain(shopDomainFromParams, supabase, correlationId);
      if (resolvedId) {
        return { storeId: resolvedId, shopDomain: shopDomainFromParams, source: 'query_params_shopDomain' };
      }
    }
  }
  
  // 2. Try request body
  if (options.body?.storeId) {
    return { storeId: options.body.storeId, shopDomain: options.body.shopDomain || null, source: 'request_body' };
  }
  
  if (options.body?.shopDomain) {
    const resolvedId = await resolveStoreIdFromShopDomain(options.body.shopDomain, supabase, correlationId);
    if (resolvedId) {
      return { storeId: resolvedId, shopDomain: options.body.shopDomain, source: 'request_body_shopDomain' };
    }
  }
  
  // 3. Try context storeId
  if (ctx.storeId) {
    return { storeId: ctx.storeId, shopDomain: options.shopDomain || null, source: 'context' };
  }
  
  // 4. Try shopDomain from options or URL path
  const shopDomain = options.shopDomain || extractShopDomainFromPath(new URL(ctx.req.url));
  if (shopDomain) {
    const resolvedId = await resolveStoreIdFromShopDomain(shopDomain, supabase, correlationId);
    if (resolvedId) {
      return { storeId: resolvedId, shopDomain, source: 'shopDomain_lookup' };
    }
  }
  
  return { storeId: null, shopDomain: null, source: 'not_found' };
}

async function getStoreIdOrError(
  ctx: RequestContext,
  options: {
    queryParams?: URLSearchParams;
    body?: { storeId?: string; shopDomain?: string };
    shopDomain?: string;
  } = {},
): Promise<{ storeId: string; shopDomain: string | null } | Response> {
  const { correlationId } = ctx;
  const result = await resolveStoreId(ctx, options);
  
  if (!result.storeId) {
    logger.warn('StoreId resolution failed', {
      correlationId,
      source: result.source,
      shopDomain: result.shopDomain,
      hasQueryParams: !!options.queryParams,
      hasBody: !!options.body,
    });
    
    return createErrorResponse(
      'Store not found. Please ensure you are accessing from a valid Shopify store context.',
      STATUS_BAD_REQUEST,
      correlationId,
      { 
        code: 'STORE_ID_REQUIRED',
        hint: 'Provide storeId in query params, request body, or ensure shopDomain is valid',
      },
      ctx.req,
    );
  }
  
  // Validate the storeId format
  const validation = validateStoreId(result.storeId);
  if (!validation.valid) {
    return createErrorResponse(
      validation.error ?? ERROR_INVALID_STORE_ID,
      STATUS_BAD_REQUEST,
      correlationId,
      { code: 'INVALID_STORE_ID' },
      ctx.req,
    );
  }
  
  logger.debug('StoreId resolved successfully', {
    correlationId,
    storeId: result.storeId,
    shopDomain: result.shopDomain,
    source: result.source,
  });
  
  return { storeId: result.storeId, shopDomain: result.shopDomain };
}

async function createRequestContext(req: Request, requiresAuth: boolean = true): Promise<RequestContext> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  const authHeader = req.headers.get(HEADER_AUTHORIZATION);
  const authResult = await validateAuth(authHeader);

  if (requiresAuth && !authResult.valid) {
    throw new UtilsError(authResult.error ?? ERROR_UNAUTHORIZED, ERROR_CODE_UNAUTHORIZED, STATUS_UNAUTHORIZED);
  }

  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
    const missingVars: string[] = [];
    if (!CONFIG.SUPABASE_URL) missingVars.push('SUPABASE_URL');
    if (!CONFIG.SUPABASE_ANON_KEY) missingVars.push('SUPABASE_ANON_KEY');
    throw new UtilsError(
      `Missing required environment variables: ${missingVars.join(', ')}`,
      ERROR_CODE_CONFIG_ERROR as string,
      STATUS_INTERNAL_ERROR,
    );
  }

  const supabase = authHeader ? await createAuthenticatedClient(authHeader) : await getSupabaseClient({ clientType: 'anon' });
  
  const url = new URL(req.url);
  let storeId: string | undefined;
  
  const shopDomain = extractShopDomainFromPath(url) || undefined;
  
  const storeIdFromParams = url.searchParams.get(PARAM_STORE_ID);
  if (storeIdFromParams) {
    storeId = storeIdFromParams;
  }

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
  const { req, correlationId } = ctx;
  const url = new URL(req.url);
  
  // Parse request body if POST
  let body: { storeId?: string; shopDomain?: string } = {};
  if (req.method === METHOD_POST) {
    try {
      const clonedReq = req.clone();
      body = await clonedReq.json() as QuotaBody;
    } catch (error) {
      logger.debug('Failed to parse quota request body', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Use comprehensive storeId resolution
  const storeIdResult = await getStoreIdOrError(ctx, {
    queryParams: url.searchParams,
    body,
    shopDomain: url.searchParams.get('shopDomain') || undefined,
  });
  
  if (storeIdResult instanceof Response) {
    return storeIdResult;
  }
  
  const { storeId } = storeIdResult;

  try {
    const serviceSupabase = await getSupabaseClient({ clientType: 'service' });
    
    const { data: store, error: storeCheckError } = await retryOperation(
      async () => {
        const result = await serviceSupabase
          .from(TABLE_STORES)
          .select(`${COLUMN_ID}, ${COLUMN_PLAN_ID}, ${COLUMN_TRIAL_STARTED_AT}, ${COLUMN_TRIAL_ENDS_AT}`)
          .eq(COLUMN_ID, storeId)
          .single();
        if (result.error) {
          const errorCode = (result.error as { code?: string })?.code;
          if (errorCode === 'PGRST116') {
            return { data: null, error: result.error };
          }
          const errorMessage = (result.error as { message?: string })?.message || String(result.error);
          const errorDetails = (result.error as { details?: string })?.details;
          const errorHint = (result.error as { hint?: string })?.hint;
          logger.error('Failed to fetch store in handleQuota', {
            correlationId,
            storeId,
            errorCode,
            errorMessage,
            errorDetails,
            errorHint,
            fullError: result.error,
          });
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
    
    if (!storeData.plan_id) {
      try {
        const planManager = new PlanManager(serviceSupabase);

        const initResult = await retryOperation(
          async () => {
            return await planManager.initializeTrial(storeId, 14, correlationId, false);
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
          throw new SupabaseClientError('Failed to initialize trial', { error: initResult.error || 'Unknown error' });
        }

        logger.info('Initialized trial for store without plan', {
          correlationId,
          storeId,
          trialStatus: initResult.trialStatus,
        });
      } catch (planError) {
        logger.error('Error in PlanManager initialization', {
          correlationId,
          storeId,
          error: planError instanceof Error ? planError.message : String(planError),
          stack: planError instanceof Error ? planError.stack : undefined,
        });
        // Continue anyway - we'll try to get quota status
      }
    }

    const quotaStatus = await retryOperation(
      async () => {
        const result = await serviceSupabase.rpc(RPC_GET_STORE_QUOTA_STATUS, {
          [PARAM_STORE_UUID]: storeId,
        });
        
        if (result.error) {
          logger.error('RPC get_store_quota_status (cached) error', {
            correlationId,
            storeId,
            error: result.error,
            errorMessage: (result.error as { message?: string })?.message || String(result.error),
            errorCode: (result.error as { code?: string })?.code,
            errorDetails: (result.error as { details?: string })?.details,
            errorHint: (result.error as { hint?: string })?.hint,
          });
          throw new SupabaseClientError('Failed to fetch quota', result.error);
        }
        
        const quotaData = Array.isArray(result.data) && result.data.length > 0 
          ? result.data[0] 
          : null;
        
        if (!quotaData) {
          logger.warn('RPC get_store_quota_status (cached) returned no data, using defaults', {
            correlationId,
            storeId,
          });
          return {
            store_id: storeId,
            plan_name: 'free_trial',
            articles_generated_today: 0,
            articles_published_today: 0,
            daily_limit: 10,
            monthly_limit: 100,
            articles_generated_this_month: 0,
            articles_published_this_month: 0,
            remaining_daily: 10,
            remaining_monthly: 100,
            trial_ends_at: null,
            is_trial_active: true,
          };
        }
        
        return quotaData;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
    );

    return createSuccessResponse(quotaStatus ?? {}, correlationId, {}, { compression: true, request: req });
  } catch (error) {
    logger.error('Quota fetch error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      errorName: error instanceof Error ? error.name : typeof error,
      storeId,
    });
    
    // Return a more detailed error response
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = error instanceof UtilsError ? error.code : 'QUOTA_FETCH_ERROR';
    const statusCode = error instanceof UtilsError ? error.statusCode : STATUS_INTERNAL_ERROR;
    
    return createErrorResponse(
      errorMessage || 'Failed to fetch quota status',
      statusCode,
      correlationId,
      {
        code: errorCode,
        storeId,
        debugInfo: {
          errorName: error instanceof Error ? error.name : typeof error,
        },
      },
      req,
    );
  }
}

async function handlePosts(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  const url = new URL(req.url);
  const status = url.searchParams.get(PARAM_STATUS);

  const storeIdResult = await getStoreIdOrError(ctx, {
    queryParams: url.searchParams,
    shopDomain: url.searchParams.get('shopDomain') || undefined,
  });
  
  if (storeIdResult instanceof Response) {
    return storeIdResult;
  }
  
  const { storeId } = storeIdResult;

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
  const startDate = url.searchParams.get(PARAM_START);
  const endDate = url.searchParams.get(PARAM_END);

  const storeIdResult = await getStoreIdOrError(ctx, {
    queryParams: url.searchParams,
    shopDomain: url.searchParams.get('shopDomain') || undefined,
  });
  
  if (storeIdResult instanceof Response) {
    return storeIdResult;
  }
  
  const { storeId } = storeIdResult;

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
            logger.warn('Metrics query returned error, returning empty', {
              correlationId,
              storeId: storeId!,
              error: result.error.message,
            });
            return { data: [], error: null };
          }
          return result;
        },
        CONFIG.MAX_RETRIES,
        CONFIG.RETRY_DELAY_MS,
      ),
      retryOperation(
        async () => {
          // Query top posts without embedded join - no FK relationship exists
          let topPostsQuery = supabase
            .from(TABLE_PERFORMANCE_METRICS)
            .select(`${COLUMN_POST_ID}, ${COLUMN_IMPRESSIONS}, ${COLUMN_CLICKS}, ${COLUMN_CTR}, ${COLUMN_POSITION}`)
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
            logger.warn('Top posts query returned error, returning empty', {
              correlationId,
              storeId: storeId!,
              error: result.error.message,
            });
            return { data: [], error: null };
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
          const errorCode = (result.error as { code?: string })?.code;
          if (errorCode === 'PGRST116') {
            return { data: null, error: result.error };
          }
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

    const isNotFoundError = error && (() => {
      const errorObj = error as { code?: string; message?: string };
      const errorCode = errorObj.code;
      return errorCode === 'PGRST116' || 
        (errorObj.message && (errorObj.message.includes('PGRST116') || errorObj.message.includes('No rows returned')));
    })();

    if (error && !isNotFoundError) {
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

    if (!store || isNotFoundError) {
      try {
        const serviceSupabase = await getSupabaseClient({ clientType: 'service' });
        
        const { data: existingStore, error: checkError } = await serviceSupabase
          .from(TABLE_STORES)
          .select('*')
          .eq(COLUMN_SHOP_DOMAIN, shopDomain)
          .single();
        
        if (existingStore && !checkError) {
          storeIdCache.set(shopDomain, { storeId: existingStore.id, timestamp: Date.now() });
          logger.info('Store found with service role client', { correlationId, shopDomain, storeId: existingStore.id });
          return createSuccessResponse(existingStore, correlationId, {}, { compression: true, request: req });
        }
        
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
        
        const { data: newStore, error: createError } = await serviceSupabase
          .from(TABLE_STORES)
          .insert({
            [COLUMN_SHOP_DOMAIN]: shopDomain,
            [COLUMN_ACCESS_TOKEN]: 'auto-created-placeholder-token',
            [COLUMN_PLAN_ID]: plan.id,
            [COLUMN_IS_ACTIVE]: true,
            [COLUMN_IS_PAUSED]: false,
            language_settings: { primary: 'en', enabled: ['en'] },
            frequency_settings: { interval: 'weekly', count: 3 },
          })
          .select()
          .single();
        
        if (createError || !newStore) {
          const errorCode = createError ? (createError as { code?: string })?.code : undefined;
          const errorMessage = createError ? (createError as { message?: string; details?: string })?.message || String(createError) : 'Unknown error';
          const errorDetails = createError ? (createError as { details?: string })?.details : undefined;
          
          if (errorCode === '23505' || errorMessage.includes('duplicate key') || errorMessage.includes('unique constraint')) {
            logger.warn('Store creation failed due to duplicate key, fetching existing store', { correlationId, shopDomain });
            const { data: fetchedStore, error: fetchError } = await serviceSupabase
              .from(TABLE_STORES)
              .select('*')
              .eq(COLUMN_SHOP_DOMAIN, shopDomain)
              .single();
            
            if (fetchedStore && !fetchError) {
              storeIdCache.set(shopDomain, { storeId: fetchedStore.id, timestamp: Date.now() });
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
        
        storeIdCache.set(shopDomain, { storeId: newStore.id, timestamp: Date.now() });
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

    if (store?.id) {
      storeIdCache.set(shopDomain, { storeId: store.id, timestamp: Date.now() });
    }
    return createSuccessResponse(store, correlationId, {}, { compression: true, request: req });
  } catch (error) {
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
  const { req, correlationId } = ctx;
  const url = new URL(req.url);
  const pathParts = url.pathname.split('/').filter((p) => p);
  
  // Parse request body if POST
  let body: { storeId?: string; shopDomain?: string; articleIds?: string[]; articleId?: string } = {};
  if (req.method === METHOD_POST) {
    try {
      body = await req.clone().json() as typeof body;
    } catch {
      // Body might not be JSON or might not have storeId
    }
  }
  
  // Use comprehensive storeId resolution
  const storeIdResult = await resolveStoreId(ctx, {
    queryParams: url.searchParams,
    body,
    shopDomain: url.searchParams.get('shopDomain') || undefined,
  });
  
  const targetStoreId = storeIdResult.storeId;
  
  // Handle nested routes: /queue/metrics, /queue/reorder, /queue/regenerate-title, /queue/refill
  const lastPart = pathParts[pathParts.length - 1];
  const isQueueAction = pathParts.length >= 3 && pathParts[pathParts.length - 2] === 'queue';
  
  if (isQueueAction) {
    const action = lastPart;
    
    if (action === 'metrics' && req.method === METHOD_GET) {
      if (!targetStoreId) {
        return createErrorResponse('storeId is required', STATUS_BAD_REQUEST, correlationId);
      }
      
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

  const serviceSupabase = await getSupabaseClient({ clientType: 'service' });

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

    if (storeBeforeUpdate && !storeFetchError) {
      const planId = (storeBeforeUpdate as { plan_id?: string | null }).plan_id;
      const trialEndsAt = (storeBeforeUpdate as { trial_ends_at?: string | null }).trial_ends_at;
      
      const trialExpired = !trialEndsAt || new Date(trialEndsAt) < new Date();
      
      if (!planId || trialExpired) {
        const planManager = new PlanManager(serviceSupabase);

        const initResult = await planManager.initializeTrial(
          storeId,
          14,
          correlationId,
          trialExpired,
        );

        if (initResult.success && !planId) {
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

  try {
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
      
      await queue.refillQueue(storeId);
      
      logger.info('Queue refilled after setup', { correlationId, storeId });
    }
  } catch (queueError) {
    logger.warn('Failed to refill queue after setup', {
      correlationId,
      storeId,
      error: queueError instanceof Error ? queueError.message : String(queueError),
    });
  }

  return createSuccessResponse(updatedStore, correlationId, { cached: false }, { compression: true, request: req });
}

async function handleBillingCheck(ctx: RequestContext): Promise<Response> {
  const { req, correlationId } = ctx;
  const url = new URL(req.url);
  
  // Parse request body if POST
  let body: { storeId?: string; shopDomain?: string } = {};
  if (req.method === METHOD_POST) {
    try {
      const clonedReq = req.clone();
      body = await clonedReq.json() as typeof body;
    } catch {
      // Ignore parse errors
    }
  }
  
  const storeIdResult = await getStoreIdOrError(ctx, {
    queryParams: url.searchParams,
    body,
    shopDomain: url.searchParams.get('shopDomain') || body.shopDomain || undefined,
  });
  
  if (storeIdResult instanceof Response) {
    return storeIdResult;
  }
  
  const { storeId } = storeIdResult;
  
  try {
    const serviceSupabase = await getSupabaseClient({ clientType: 'service' });
    
    const { data: store, error } = await serviceSupabase
      .from(TABLE_STORES)
      .select(`
        id,
        plan_id,
        trial_started_at,
        trial_ends_at,
        is_active,
        is_paused,
        plan_limits(id, plan_name, daily_article_limit, monthly_article_limit)
      `)
      .eq(COLUMN_ID, storeId)
      .single();
    
    if (error || !store) {
      return createErrorResponse('Store not found', STATUS_NOT_FOUND, correlationId);
    }
    
    const planLimits = store.plan_limits as { plan_name?: string; daily_article_limit?: number; monthly_article_limit?: number } | null;
    const trialEndsAt = store.trial_ends_at ? new Date(store.trial_ends_at) : null;
    const isTrialActive = trialEndsAt ? trialEndsAt > new Date() : false;
    const isTrialExpired = trialEndsAt ? trialEndsAt <= new Date() : false;
    
    return createSuccessResponse({
      storeId: store.id,
      planId: store.plan_id,
      planName: planLimits?.plan_name || 'unknown',
      isActive: store.is_active,
      isPaused: store.is_paused,
      trialStartedAt: store.trial_started_at,
      trialEndsAt: store.trial_ends_at,
      isTrialActive,
      isTrialExpired,
      dailyLimit: planLimits?.daily_article_limit || 0,
      monthlyLimit: planLimits?.monthly_article_limit || 0,
    }, correlationId, {}, { compression: true, request: req });
  } catch (error) {
    logger.error('Billing check error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      storeId,
    });
    throw error;
  }
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
        const insertData = eventsToRecord.map((event) => ({
        store_id: event.storeId,
        post_id: event.postId,
        event_type: event.eventType,
        event_data: event.eventData || {},
        timestamp: event.metadata?.timestamp && typeof event.metadata.timestamp === 'number' ? new Date(event.metadata.timestamp).toISOString() : new Date().toISOString(),
        user_agent: event.metadata?.userAgent || null,
        referrer: event.metadata?.referrer || null,
        ip_address: event.metadata?.ipAddress || null,
      }));

      if (CONFIG.ENABLE_RETRY) {
        await retryOperation(async () => {
          const { error: insertError } = await supabase
            .from('analytics')
            .insert(insertData);
          if (insertError) throw insertError;
          eventsRecorded = events.length;
        }, CONFIG.MAX_RETRIES, CONFIG.RETRY_DELAY_MS);
      } else {
        const { error: insertError } = await supabase
          .from('analytics')
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

async function handleDashboardBatch(ctx: RequestContext): Promise<Response> {
  const { req, correlationId } = ctx;
  const url = new URL(req.url);

  let body: { storeId?: string; shopDomain?: string } = {};
  if (req.method === METHOD_POST) {
    try {
      const clonedReq = req.clone();
      body = await clonedReq.json() as typeof body;
    } catch (error) {
      logger.debug('Failed to parse dashboard batch request body', { correlationId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Use comprehensive storeId resolution
  const storeIdResult = await getStoreIdOrError(ctx, {
    queryParams: url.searchParams,
    body,
    shopDomain: url.searchParams.get('shopDomain') || body.shopDomain || undefined,
  });
  
  if (storeIdResult instanceof Response) {
    return storeIdResult;
  }
  
  const { storeId } = storeIdResult;

  try {
    const serviceSupabase = await getSupabaseClient({ clientType: 'service' });

    const [quotaResult, postsResult, scheduledPostsResult, draftPostsResult, analyticsResult] = await Promise.all([
      retryOperation(
        async () => {
          const result = await serviceSupabase.rpc(RPC_GET_STORE_QUOTA_STATUS, {
            [PARAM_STORE_UUID]: storeId!,
          });
          
          if (result.error) {
            logger.error('RPC get_store_quota_status (cached) error in batch', {
              correlationId,
              storeId: storeId!,
              error: result.error,
              errorMessage: (result.error as { message?: string })?.message || String(result.error),
            });
            throw new SupabaseClientError('Failed to fetch quota', result.error);
          }
          
          // The RPC function returns a TABLE, so result.data is an array
          const quotaData = Array.isArray(result.data) && result.data.length > 0 
            ? result.data[0] 
            : {
                store_id: storeId!,
                plan_name: 'free_trial',
                articles_generated_today: 0,
                articles_published_today: 0,
                daily_limit: 10,
                monthly_limit: 100,
                articles_generated_this_month: 0,
                articles_published_this_month: 0,
                remaining_daily: 10,
                remaining_monthly: 100,
                trial_ends_at: null,
                is_trial_active: true,
              };
          
          return quotaData;
        },
        CONFIG.MAX_RETRIES,
        CONFIG.RETRY_DELAY_MS,
      ),
      retryOperation(
        async () => {
          const result = await serviceSupabase
            .from(TABLE_BLOG_POSTS)
            .select('*')
            .eq(COLUMN_STORE_ID, storeId!)
            .eq(PARAM_STATUS, STATUS_PUBLISHED)
            .order(COLUMN_CREATED_AT, { ascending: false })
            .limit(50);
          if (result.error) {
            throw new SupabaseClientError('Failed to fetch published posts', result.error);
          }
          return result.data ?? [];
        },
        CONFIG.MAX_RETRIES,
        CONFIG.RETRY_DELAY_MS,
      ),
      retryOperation(
        async () => {
          const result = await serviceSupabase
            .from(TABLE_BLOG_POSTS)
            .select('*')
            .eq(COLUMN_STORE_ID, storeId!)
            .eq(PARAM_STATUS, STATUS_SCHEDULED)
            .order(COLUMN_CREATED_AT, { ascending: false })
            .limit(50);
          if (result.error) {
            throw new SupabaseClientError('Failed to fetch scheduled posts', result.error);
          }
          return result.data ?? [];
        },
        CONFIG.MAX_RETRIES,
        CONFIG.RETRY_DELAY_MS,
      ),
      retryOperation(
        async () => {
          const result = await serviceSupabase
            .from(TABLE_BLOG_POSTS)
            .select('*')
            .eq(COLUMN_STORE_ID, storeId!)
            .eq(PARAM_STATUS, STATUS_DRAFT)
            .order(COLUMN_CREATED_AT, { ascending: false })
            .limit(50);
          if (result.error) {
            throw new SupabaseClientError('Failed to fetch draft posts', result.error);
          }
          return result.data ?? [];
        },
        CONFIG.MAX_RETRIES,
        CONFIG.RETRY_DELAY_MS,
      ),
      retryOperation(
        async () => {
          const summaryResult = await serviceSupabase
            .from('analytics_summary_30d')
            .select('pageviews, clicks, conversions, total_events')
            .eq(COLUMN_STORE_ID, storeId!)
            .order('event_date', { ascending: false })
            .limit(30);
          
          if (!summaryResult.error && summaryResult.data && summaryResult.data.length > 0) {
            const summary = summaryResult.data.reduce((acc: { pageviews: number; clicks: number; conversions: number; totalEvents: number }, row: { pageviews: number; clicks: number; conversions: number; total_events: number }) => {
              acc.pageviews += row.pageviews || 0;
              acc.clicks += row.clicks || 0;
              acc.conversions += row.conversions || 0;
              acc.totalEvents += row.total_events || 0;
              return acc;
            }, { pageviews: 0, clicks: 0, conversions: 0, totalEvents: 0 });
            
            return summary;
          }
          
          const endDate = new Date();
          const startDate = new Date();
          startDate.setDate(startDate.getDate() - 30);

          const result = await serviceSupabase.rpc('get_analytics_summary', {
            store_uuid: storeId!,
            start_date: startDate.toISOString(),
            end_date: endDate.toISOString(),
          });
          
          if (!result.error && result.data) {
            return result.data;
          }
          
          const fallbackResult = await serviceSupabase
            .from('analytics')
            .select('event_type')
            .eq(COLUMN_STORE_ID, storeId!)
            .gte('timestamp', startDate.toISOString())
            .lte('timestamp', endDate.toISOString());
          
          if (fallbackResult.error) {
            throw new SupabaseClientError('Failed to fetch analytics', fallbackResult.error);
          }
          
          const events = fallbackResult.data ?? [];
          return {
            totalEvents: events.length,
            pageviews: events.filter((e: { event_type: string }) => e.event_type === 'pageview').length,
            clicks: events.filter((e: { event_type: string }) => e.event_type === 'click').length,
            conversions: events.filter((e: { event_type: string }) => e.event_type === 'conversion').length,
          };
        },
        CONFIG.MAX_RETRIES,
        CONFIG.RETRY_DELAY_MS,
      ),
    ]);

    return createSuccessResponse(
      {
        quota: quotaResult ?? {},
        posts: postsResult ?? [],
        scheduledPosts: scheduledPostsResult ?? [],
        draftPosts: draftPostsResult ?? [],
        analytics: analyticsResult ?? {},
      },
      correlationId,
      { cached: false },
      { compression: true, request: req },
    );
  } catch (error) {
    logger.error('Dashboard batch error', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      errorName: error instanceof Error ? error.name : typeof error,
      storeId,
    });
    
    // Return a more detailed error response
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = error instanceof UtilsError ? error.code : 'DASHBOARD_BATCH_ERROR';
    const statusCode = error instanceof UtilsError ? error.statusCode : STATUS_INTERNAL_ERROR;
    
    return createErrorResponse(
      errorMessage || 'Failed to fetch dashboard data',
      statusCode,
      correlationId,
      {
        code: errorCode,
        storeId,
        debugInfo: {
          errorName: error instanceof Error ? error.name : typeof error,
        },
      },
      req,
    );
  }
}

async function fetchPost(
  supabase: Awaited<ReturnType<typeof getSupabaseClient>>,
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
  );
}

function validatePostUpdateParams(params: Readonly<Record<string, unknown>>): { readonly valid: boolean; readonly error?: string; readonly warnings?: ReadonlyArray<string> } {
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

function validatePostCreationParams(params: Readonly<Record<string, unknown>>): { readonly valid: boolean; readonly error?: string; readonly warnings?: ReadonlyArray<string> } {
  const warnings: string[] = [];

  if (!params.storeId || typeof params.storeId !== 'string') {
    return { valid: false, error: 'storeId is required and must be a string' };
  }

  if (!params.topic || typeof params.topic !== 'string' || params.topic.trim().length === 0) {
    return { valid: false, error: 'topic is required and must be a non-empty string' };
  }

  if (params.topic.length > MAX_TOPIC_LENGTH) {
    return { valid: false, error: 'topic must be less than 500 characters' };
  }

  if (params.keywords !== undefined && !Array.isArray(params.keywords)) {
    return { valid: false, error: 'keywords must be an array' };
  }

  if (params.keywords && Array.isArray(params.keywords) && params.keywords.length > MAX_KEYWORDS) {
    warnings.push('Too many keywords provided, only first 50 will be used');
  }

  if (params.products !== undefined && !Array.isArray(params.products)) {
    return { valid: false, error: 'products must be an array' };
  }

  return { valid: true, warnings: warnings.length > 0 ? warnings : undefined };
}

async function handleCreatePost(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  const warnings: string[] = [];

  try {
    const body = await req.json() as Readonly<Record<string, unknown>>;
    const validation = validatePostCreationParams(body);

    if (!validation.valid) {
      return createErrorResponse(validation.error ?? ERROR_INVALID_INPUT, STATUS_BAD_REQUEST, correlationId);
    }

    if (validation.warnings) {
      warnings.push(...validation.warnings);
    }

    const params: PostCreationParams = {
      storeId: body.storeId as string,
      topic: (body.topic as string).trim(),
      keywords: Array.isArray(body.keywords) ? (body.keywords as string[]).slice(0, MAX_KEYWORDS) : [],
      products: Array.isArray(body.products) ? (body.products as string[]) : [],
      structure: body.structure as string | undefined,
      language: 'en',
      experienceLevel: body.experienceLevel as string | undefined,
      audiencePersona: body.audiencePersona as string | undefined,
      includeCitations: body.includeCitations !== false,
      validateQuality: body.validateQuality !== false,
    };

    if (body.regenerateFrom) {
      const { data: limitCheck, error: limitError } = await supabase
        .rpc('check_regeneration_limits', {
          store_uuid: params.storeId,
          post_uuid: body.regenerateFrom as string,
          regenerated_from_uuid: body.regenerateFrom as string,
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
          throw new UtilsError('Store not found', 'STORE_NOT_FOUND', STATUS_NOT_FOUND);
        }
        return result;
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
    );

    if (storeError || !store) {
      throw new UtilsError('Store not found', 'STORE_NOT_FOUND', STATUS_NOT_FOUND);
    }

    const storeData = store as unknown as DatabaseStore;

    if (!storeData.is_active) {
      return createErrorResponse('Store is not active', 403, correlationId);
    }

    const planManager = new PlanManager(supabase);
    const enforcementResult = await retryOperation(
      async () => {
        return await planManager.enforceQuotaWithLock(params.storeId, 'create_article', correlationId);
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
    );

    if (!enforcementResult.allowed) {
      return createErrorResponse(
        enforcementResult.reason || 'Article quota exceeded',
        403,
        correlationId,
        {
          quotaStatus: enforcementResult.quotaStatus,
          trialStatus: enforcementResult.trialStatus,
        },
      );
    }

    if (!CONFIG.OPENAI_API_KEY) {
      throw new UtilsError('OPENAI_API_KEY not configured', ERROR_CODE_CONFIG_ERROR, STATUS_INTERNAL_ERROR);
    }

    const gdprGuard = new GDPRDataGuard(supabase);
    const toneMatrix = (storeData.tone_matrix as Readonly<Record<string, number>> | null) ?? DEFAULT_TONE_MATRIX;
    const blogComposer = new BlogComposer(CONFIG.OPENAI_API_KEY, toneMatrix, storeData.brand_dna ?? {});
    const keywordMiner = new KeywordMiner(CONFIG.OPENAI_API_KEY);

    let finalKeywords = params.keywords && params.keywords.length > 0 ? [...params.keywords] : [];
    const contentPreferences = storeData.content_preferences || {};
    if (contentPreferences.keyword_focus && contentPreferences.keyword_focus.length > 0) {
      finalKeywords = [...finalKeywords, ...contentPreferences.keyword_focus];
      finalKeywords = Array.from(new Set(finalKeywords));
    }
    
    if (finalKeywords.length === 0) {
      try {
        const keywordCluster = await retryOperation(
          async () => await keywordMiner.mineKeywords(params.topic),
          CONFIG.MAX_RETRIES,
          CONFIG.RETRY_DELAY_MS,
        );
        finalKeywords = [
          keywordCluster.primaryKeyword.keyword,
          ...keywordCluster.longTailKeywords.map((k) => k.keyword),
        ];
      } catch (error) {
        logger.error('Keyword mining failed', { correlationId, error: error instanceof Error ? error.message : String(error) });
        warnings.push('Keyword mining failed, proceeding without keywords');
      }
    }

    const sanitizedTopic = await retryOperation(
      async () => await gdprGuard.sanitizeContent(params.topic, params.storeId, undefined, 'content_generation'),
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
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
        ),
      ),
    );

    const postContent = await retryOperation(
      async () =>
        await blogComposer.composePost(sanitizedTopic.sanitizedContent, sanitizedKeywords, {
          structure: params.structure as 'default' | 'how-to' | 'listicle' | 'comparison' | 'tutorial' | 'case-study' | undefined,
          language: 'en',
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
    );

    let seoOptimizedContent = postContent.content;
    let seoMetadata: Readonly<Record<string, unknown>> | undefined;
    if (CONFIG.ENABLE_SEO_OPTIMIZATION) {
      try {
        const contentGraph = new ContentGraph(supabase, CONFIG.OPENAI_API_KEY);
        const seoOptimizer = new SEOOptimizer(CONFIG.OPENAI_API_KEY, supabase, contentGraph, storeData.shop_domain);
        const [seoHealthScore, keywordAnalysis, structuredData] = await Promise.all([
          retryOperation(
            async () => await seoOptimizer.calculateSEOHealthScore({
              title: postContent.title,
              content: postContent.content,
              metaDescription: postContent.seoDescription,
              keywords: sanitizedKeywords,
              primaryKeyword: postContent.primaryKeyword,
            }),
            CONFIG.MAX_RETRIES,
            CONFIG.RETRY_DELAY_MS,
          ),
          retryOperation(
            async () => await seoOptimizer.analyzeKeywords(postContent.content, sanitizedKeywords),
            CONFIG.MAX_RETRIES,
            CONFIG.RETRY_DELAY_MS,
          ),
          retryOperation(
            async () => await seoOptimizer.generateStructuredData({
              title: postContent.title,
              content: postContent.content,
              excerpt: postContent.excerpt,
              keywords: sanitizedKeywords,
            }),
            CONFIG.MAX_RETRIES,
            CONFIG.RETRY_DELAY_MS,
          ),
        ]);
        seoMetadata = { seoHealthScore, keywordAnalysis, structuredData };
      } catch (seoError) {
        logger.warn('SEO optimization failed', { correlationId, error: seoError instanceof Error ? seoError.message : String(seoError) });
        warnings.push('SEO optimization failed');
      }
    }

    let finalContent = seoOptimizedContent;
    let productMentions: ReadonlyArray<unknown> | undefined;
    if (params.products && params.products.length > 0 && CONFIG.ENABLE_PRODUCT_MENTIONS) {
      try {
        const shopifyClient = new ShopifyClient(storeData.shop_domain, storeData.access_token);
        const productContextEngine = new ProductContextEngine(
          shopifyClient,
          CONFIG.OPENAI_API_KEY,
          storeData.brand_dna as Readonly<Record<string, unknown>> | null,
        );
        const productResult = await retryOperation(
          async () =>
            await productContextEngine.injectProductMentions(seoOptimizedContent, params.products!, {
              maxMentions: 5,
              naturalPlacement: true,
              contextualRelevance: true,
            }),
          CONFIG.MAX_RETRIES,
          CONFIG.RETRY_DELAY_MS,
        );
        finalContent = productResult.content;
        productMentions = productResult.mentions;
      } catch (productError) {
        logger.warn('Product mention injection failed', { correlationId, error: productError instanceof Error ? productError.message : String(productError) });
        warnings.push('Product mention injection failed');
      }
    }

    const sanitizedContent = await retryOperation(
      async () =>
        await gdprGuard.sanitizeContent(finalContent, params.storeId, undefined, 'content_generation'),
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
    );

    let featuredImageUrl: string | null = null;
    if (CONFIG.ENABLE_IMAGE_GENERATION && CONFIG.FLUX_API_KEY && postContent.imagePrompt) {
      try {
        const imageGenerator = new ImageGenerator(CONFIG.FLUX_API_KEY);
        const imageResult = await retryOperation(
          async () =>
            await imageGenerator.generateFeaturedImage(postContent.imagePrompt!, postContent.title, sanitizedKeywords),
          CONFIG.MAX_RETRIES,
          CONFIG.RETRY_DELAY_MS,
        );
        try {
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
          );
          featuredImageUrl = cdnResult.cdnUrl;
        } catch (cdnError) {
          logger.warn('Shopify CDN upload failed', { correlationId, error: cdnError instanceof Error ? cdnError.message : String(cdnError) });
          featuredImageUrl = imageResult.imageUrl;
          warnings.push('Image CDN upload failed');
        }
      } catch (imageError) {
        logger.error('Image generation failed', { correlationId, error: imageError instanceof Error ? imageError.message : String(imageError) });
        warnings.push('Image generation failed');
      }
    }

    const { data: storeSettings } = await supabase
      .from(TABLE_STORES)
      .select('review_window_hours, require_approval')
      .eq(COLUMN_ID, params.storeId)
      .single();

    const reviewWindowHours = (storeSettings as { review_window_hours?: number } | null)?.review_window_hours ?? 24;
    const requireApproval = (storeSettings as { require_approval?: boolean } | null)?.require_approval ?? false;
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
          [COLUMN_KEYWORDS]: sanitizedKeywords,
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
            ...(seoMetadata || {}),
          },
        };

        if (body.regenerateFrom) {
          insertData.regenerated_from = body.regenerateFrom as string;
          insertData.regeneration_count = 0;
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
    );

    if (postError) {
      throw postError;
    }

    if (body.regenerateFrom && post) {
      const postData = post as DatabasePost;
      await supabase.rpc('increment_regeneration_count', {
        post_uuid: body.regenerateFrom as string,
      }).catch(async () => {
        const { data: originalPost } = await supabase
          .from(TABLE_BLOG_POSTS)
          .select('regeneration_count')
          .eq(COLUMN_ID, body.regenerateFrom as string)
          .single();
        
        if (originalPost) {
          const currentCount = (originalPost as { regeneration_count?: number }).regeneration_count ?? 0;
          await supabase
            .from(TABLE_BLOG_POSTS)
            .update({ regeneration_count: currentCount + 1 })
            .eq(COLUMN_ID, body.regenerateFrom);
        }
      });

      await supabase
        .from('regeneration_usage')
        .insert({
          store_id: params.storeId,
          post_id: postData[COLUMN_ID] as string,
          regenerated_from_post_id: body.regenerateFrom as string,
          usage_date: new Date().toISOString().split('T')[0],
        });
    }

    await retryOperation(
      async () => {
        const quotaManager = new PlanManager(supabase);
        await quotaManager.recordUsage(params.storeId, (post as DatabasePost)[COLUMN_ID] as string, 'generated');
        return { data: true };
      },
      CONFIG.MAX_RETRIES,
      CONFIG.RETRY_DELAY_MS,
    );

    if (CONFIG.ENABLE_INTERNAL_LINKS) {
      try {
        const contentGraph = new ContentGraph(supabase, CONFIG.OPENAI_API_KEY);
        await retryOperation(
          async () => {
            const internalLinks = await contentGraph.rebuildInternalLinks(
              params.storeId,
              (post as DatabasePost)[COLUMN_ID] as string,
            );
            await supabase
              .from(TABLE_BLOG_POSTS)
              .update({ internal_links: internalLinks })
              .eq(COLUMN_ID, (post as DatabasePost)[COLUMN_ID]);
            return internalLinks;
          },
          CONFIG.MAX_RETRIES,
          CONFIG.RETRY_DELAY_MS,
        );
      } catch (linkError) {
        logger.warn('Internal link generation failed', { correlationId, error: linkError instanceof Error ? linkError.message : String(linkError) });
        warnings.push('Internal link generation failed');
      }
    }

    if (CONFIG.ENABLE_LLM_SNIPPETS) {
      try {
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
                keywords: sanitizedKeywords,
                seoMetadata: seoMetadata ?? {},
              },
              {
                priority: JOB_PRIORITY_NORMAL,
                maxAttempts: JOB_MAX_ATTEMPTS,
              },
            ),
          CONFIG.MAX_RETRIES,
          CONFIG.RETRY_DELAY_MS,
        );
      } catch (error) {
        logger.error('Failed to enqueue LLM snippet job', { correlationId, error: error instanceof Error ? error.message : String(error) });
        warnings.push('LLM snippet generation job enqueue failed');
      }
    }

    return createSuccessResponse(
      post,
      correlationId,
      warnings.length > 0 ? { warnings } : undefined,
      { compression: true, request: req },
    );
  } catch (error) {
    logger.error('Post creation failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

async function handleUpdatePost(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  const url = new URL(req.url);
  const pathParts = url.pathname.split(PATH_SEPARATOR).filter((p) => p);
  const postId = pathParts.length >= 2 && pathParts[0] === 'posts-api' ? pathParts[1] : pathParts[pathParts.length - 1];

  if (!postId) {
    return createErrorResponse(ERROR_POST_ID_REQUIRED, STATUS_BAD_REQUEST, correlationId);
  }

  try {
    const body = await req.json() as Readonly<Record<string, unknown>>;
    const validation = validatePostUpdateParams(body);

    if (!validation.valid) {
      return createErrorResponse(validation.error ?? ERROR_INVALID_INPUT, STATUS_BAD_REQUEST, correlationId);
    }

    const fetchResult = await fetchPost(supabase, postId);
    if (fetchResult.error || !fetchResult.data) {
      throw new UtilsError(ERROR_POST_NOT_FOUND, ERROR_CODE_POST_NOT_FOUND, STATUS_NOT_FOUND);
    }

    const updates: Record<string, unknown> = {
      [COLUMN_UPDATED_AT]: new Date().toISOString(),
    };

    if (body.title !== undefined) updates[COLUMN_TITLE] = (body.title as string).trim();
    if (body.content !== undefined) updates[COLUMN_CONTENT] = body.content;
    if (body.excerpt !== undefined) updates[COLUMN_EXCERPT] = body.excerpt;
    if (body.seoTitle !== undefined) updates[COLUMN_SEO_TITLE] = body.seoTitle;
    if (body.seoDescription !== undefined) updates[COLUMN_SEO_DESCRIPTION] = body.seoDescription;
    if (body.keywords !== undefined) updates[COLUMN_KEYWORDS] = body.keywords;
    if (body.status !== undefined) updates[COLUMN_STATUS] = body.status;
    if (body.scheduled_publish_at !== undefined) {
      updates[COLUMN_SCHEDULED_PUBLISH_AT] = (body.scheduled_publish_at as string) || null;
    }
    if (body.review_status !== undefined) updates.review_status = body.review_status;
    if (body.reviewed_at !== undefined) updates.reviewed_at = (body.reviewed_at as string) || new Date().toISOString();
    if (body.review_feedback !== undefined) updates.review_feedback = body.review_feedback;

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
    );

    if (updateError || !updatedPost) {
      throw new UtilsError('Failed to update post', ERROR_CODE_INTERNAL_ERROR, STATUS_INTERNAL_ERROR);
    }

    return createSuccessResponse(updatedPost, correlationId, {}, { compression: true, request: req });
  } catch (error) {
    logger.error('Post update failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function handleDeletePost(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  const url = new URL(req.url);
  const pathParts = url.pathname.split(PATH_SEPARATOR).filter((p) => p);
  const postId = pathParts.length >= 2 && pathParts[0] === 'posts-api' ? pathParts[1] : pathParts[pathParts.length - 1];

  if (!postId) {
    return createErrorResponse(ERROR_POST_ID_REQUIRED, STATUS_BAD_REQUEST, correlationId);
  }

  try {
    const fetchResult = await fetchPost(supabase, postId);
    if (fetchResult.error || !fetchResult.data) {
      throw new UtilsError(ERROR_POST_NOT_FOUND, ERROR_CODE_POST_NOT_FOUND, STATUS_NOT_FOUND);
    }

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
    );

    if (deleteError) {
      throw new UtilsError('Failed to delete post', ERROR_CODE_INTERNAL_ERROR, STATUS_INTERNAL_ERROR);
    }

    return createSuccessResponse({ success: true, postId }, correlationId, {}, { compression: true, request: req });
  } catch (error) {
    logger.error('Post deletion failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function handleSchedulePost(ctx: RequestContext): Promise<Response> {
  const { supabase, req, correlationId } = ctx;
  const url = new URL(req.url);
  const pathParts = url.pathname.split(PATH_SEPARATOR).filter((p) => p);
  const postId = pathParts.length >= 3 && pathParts[0] === 'posts-api' ? pathParts[1] : pathParts[pathParts.length - 2];

  if (!postId) {
    return createErrorResponse(ERROR_POST_ID_REQUIRED, STATUS_BAD_REQUEST, correlationId);
  }

  try {
    const body = await req.json() as { scheduled_at: string };
    
    if (!body.scheduled_at) {
      return createErrorResponse('scheduled_at is required', STATUS_BAD_REQUEST, correlationId);
    }

    const scheduledDate = new Date(body.scheduled_at);
    if (isNaN(scheduledDate.getTime())) {
      return createErrorResponse('Invalid scheduled_at date format', STATUS_BAD_REQUEST, correlationId);
    }

    if (scheduledDate < new Date()) {
      return createErrorResponse('scheduled_at must be in the future', STATUS_BAD_REQUEST, correlationId);
    }

    const fetchResult = await fetchPost(supabase, postId);
    if (fetchResult.error || !fetchResult.data) {
      throw new UtilsError(ERROR_POST_NOT_FOUND, ERROR_CODE_POST_NOT_FOUND, STATUS_NOT_FOUND);
    }

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
    );

    if (updateError || !updatedPost) {
      throw new UtilsError('Failed to schedule post', ERROR_CODE_INTERNAL_ERROR, STATUS_INTERNAL_ERROR);
    }

    return createSuccessResponse(updatedPost, correlationId, {}, { compression: true, request: req });
  } catch (error) {
    logger.error('Post scheduling failed', {
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

  if (pathParts.length >= 2 && pathParts[0] === 'posts-api') {
    const method = ctx.req.method;
    const lastPart = pathParts[pathParts.length - 1];
    const secondLastPart = pathParts.length >= 3 ? pathParts[pathParts.length - 2] : null;

    if (lastPart === 'schedule' && secondLastPart && method === METHOD_POST) {
      const postId = secondLastPart;
      return handleRequest(ctx.req, handleSchedulePost, {
        requiresAuth: true,
        compression: true,
        rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
        timeout: DEFAULT_CREATE_POST_TIMEOUT,
        maxRequestSize: DEFAULT_MAX_REQUEST_SIZE_POSTS,
      });
    }

    const postId = lastPart;

    if (method === METHOD_PATCH) {
      return handleRequest(ctx.req, handleUpdatePost, {
        requiresAuth: true,
        compression: true,
        rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
        timeout: DEFAULT_CREATE_POST_TIMEOUT,
        validateInput: validatePostUpdateParams,
        maxRequestSize: DEFAULT_MAX_REQUEST_SIZE_POSTS,
      });
    }

    if (method === METHOD_DELETE) {
      return handleRequest(ctx.req, handleDeletePost, {
        requiresAuth: true,
        compression: true,
        rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
        timeout: DEFAULT_CREATE_POST_TIMEOUT,
      });
    }
  }

  if (path === 'create-post' && ctx.req.method === METHOD_POST) {
    return handleRequest(ctx.req, handleCreatePost, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: 10, windowMs: RATE_LIMIT_WINDOW_MS },
      timeout: DEFAULT_CREATE_POST_TIMEOUT,
      validateInput: validatePostCreationParams,
      maxRequestSize: DEFAULT_MAX_REQUEST_SIZE_POSTS,
    });
  }

  if (pathParts.length >= 3 && pathParts[pathParts.length - 2] === 'analytics' && path === 'track' && ctx.req.method === METHOD_POST) {
    const correlationId = ctx.correlationId;
    return await handleTrack(ctx.req, correlationId);
  }

  if (pathParts.length >= 2 && pathParts[0] === 'schedule' && pathParts[1] === 'check-conflicts') {
    return handleRequest(ctx.req, handleCheckScheduleConflicts, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
    });
  }

  if (pathParts.length >= 2 && pathParts[0] === 'regeneration' && pathParts[1] === 'check-limits') {
    return handleRequest(ctx.req, handleRegenerationLimits, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
    });
  }

  if (pathParts.length >= 2 && pathParts[pathParts.length - 2] === 'queue') {
    return handleRequest(ctx.req, handleQueue, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
    });
  }
  
  if (pathParts[pathParts.length - 1] === 'queue') {
    return handleRequest(ctx.req, handleQueue, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
    });
  }

  if (pathParts.length >= 2 && pathParts[0] === 'billing' && pathParts[1] === 'check') {
    return handleRequest(ctx.req, handleBillingCheck, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_QUOTA, windowMs: RATE_LIMIT_WINDOW_MS },
      cache: { ttl: 60000 },
    });
  }

  if (pathParts.length >= 2 && pathParts[pathParts.length - 2] === 'billing' && pathParts[pathParts.length - 1] === 'check') {
    return handleRequest(ctx.req, handleBillingCheck, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_QUOTA, windowMs: RATE_LIMIT_WINDOW_MS },
      cache: { ttl: 60000 },
    });
  }

  if (pathParts.length >= 2 && pathParts[pathParts.length - 2] === 'dashboard' && pathParts[pathParts.length - 1] === 'batch') {
    return handleRequest(ctx.req, handleDashboardBatch, {
      requiresAuth: true,
      compression: true,
      rateLimit: { maxRequests: RATE_LIMIT_POSTS, windowMs: RATE_LIMIT_WINDOW_MS },
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
        validateInput: () => ({ valid: true }),
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
        cache: { ttl: 30000 },
      },
    },
  };

  const matchedRoute = routes[path];

  if (!matchedRoute) {
    return createErrorResponse(ERROR_NOT_FOUND, STATUS_NOT_FOUND, ctx.correlationId);
  }

  return handleRequest(ctx.req, matchedRoute.handler, matchedRoute.config);
}

try {
  serve(async (req: Request) => {
    if (req.method === METHOD_OPTIONS) {
      return new Response('ok', { headers: getCORSHeaders(req) });
    }

    try {
      const url = new URL(req.url);
      const pathParts = url.pathname.split(PATH_SEPARATOR).filter((p) => p);
      
      const storeIndex = pathParts.indexOf('store');
      if (storeIndex !== -1 && storeIndex < pathParts.length - 1) {
        return await handleRequest(req, handleStore, {
          requiresAuth: false,
          compression: true,
          rateLimit: { maxRequests: 100, windowMs: 60000 },
          cache: { ttl: 300000 },
        });
      }
      
      const ctx = await createRequestContext(req);
      return await routeRequest(ctx);
    } catch (error) {
      const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
      logger.error('Request failed', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

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
  logger.error('FATAL: Function initialization failed', {
    error: initError instanceof Error ? initError.message : String(initError),
    stack: initError instanceof Error ? initError.stack : undefined,
  });
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
