import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface DenoEnv {
  readonly get?: (key: string) => string | undefined;
}

interface DenoGlobal {
  readonly Deno?: {
    readonly env?: DenoEnv;
    readonly memoryUsage?: () => Readonly<Record<string, number>>;
  };
}

interface SupabaseClientConfig {
  readonly url: string;
  readonly key: string;
  readonly authHeader?: string;
  readonly clientType?: 'service' | 'anon';
}

interface CompressionOptions {
  readonly encoding?: 'gzip' | 'brotli' | 'auto';
  readonly level?: number;
  readonly threshold?: number;
  readonly contentType?: string;
  readonly cache?: boolean;
  readonly adaptive?: boolean;
}

interface CompressionMetrics {
  readonly originalSize: number;
  readonly compressedSize: number;
  readonly ratio: number;
  readonly encoding: string;
  readonly timeMs: number;
}

interface PerformanceMetrics {
  readonly functionName: string;
  readonly duration: number;
  readonly timestamp: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface LogLevel {
  readonly DEBUG: 0;
  readonly INFO: 1;
  readonly WARN: 2;
  readonly ERROR: 3;
}

type LogLevelKey = keyof LogLevel;

interface ClientInstance {
  readonly client: ReturnType<typeof createClient>;
  lastInitTime: number;
  lastHealthCheck: number;
  isHealthy: boolean;
  errorCount: number;
  readonly clientType: 'service' | 'anon';
}

interface CompressionCacheEntry {
  readonly data: Uint8Array;
  readonly encoding: string;
  readonly timestamp: number;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface ClientMetrics {
  created: number;
  reused: number;
  errors: number;
  healthChecks: number;
  recoveries: number;
}

interface SupabaseClientOptions {
  readonly auth?: {
    readonly persistSession?: boolean;
  };
  readonly global?: {
    readonly headers?: Readonly<Record<string, string>>;
  };
  db?: {
    readonly schema?: string;
  };
}

interface JWTPayload {
  readonly sub: string;
  readonly email?: string;
  readonly role?: string;
  readonly aud?: string;
  readonly exp?: number;
  readonly iat?: number;
  readonly [key: string]: unknown;
}

interface JWTValidationResult {
  readonly valid: boolean;
  readonly userId?: string;
  readonly payload?: JWTPayload;
  readonly error?: string;
}

interface ValidationRule {
  readonly field: string;
  readonly required?: boolean;
  readonly type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly enum?: readonly string[];
  readonly validate?: (value: unknown) => boolean | string;
}

interface ValidationResult {
  readonly valid: boolean;
  readonly errors?: ReadonlyArray<{ readonly field: string; readonly error: string }>;
}

type RequestInterceptor = (request: Request) => Request | Promise<Request>;
type ResponseInterceptor = (response: Response) => Response | Promise<Response>;
type ErrorInterceptor = (error: Error, request: Request) => Response | Promise<Response>;

const DEFAULT_CLIENT_REFRESH_INTERVAL = 300000;
const DEFAULT_CLIENT_HEALTH_CHECK_INTERVAL = 60000;
const DEFAULT_CLIENT_MAX_RETRIES = 3;
const DEFAULT_COMPRESSION_LEVEL = 6;
const DEFAULT_COMPRESSION_THRESHOLD = 1024;
const DEFAULT_COMPRESSION_CACHE_TTL = 3600000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 100;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60000;
const MAX_METRICS_HISTORY = 1000;
const COMPRESSION_CACHE_CLEANUP_THRESHOLD = 100;
const RATE_LIMIT_CLEANUP_THRESHOLD = 1000;
const CLIENT_CLEANUP_MULTIPLIER = 2;
const BROTLI_LEVEL_MIN = 1;
const BROTLI_LEVEL_MAX = 11;
const GZIP_LEVEL_MIN = 1;
const GZIP_LEVEL_MAX = 9;
const DEFAULT_STATUS_CODE = 200;
const IDENTITY_ENCODING = 'identity';
const GZIP_ENCODING = 'gzip';
const BROTLI_ENCODING = 'br';
const CONTENT_TYPE_JSON = 'application/json';
const CONTENT_TYPE_PLAIN = 'text/plain';
const HEADER_CONTENT_TYPE = 'Content-Type';
const HEADER_CONTENT_ENCODING = 'Content-Encoding';
const HEADER_VARY = 'Vary';
const HEADER_X_COMPRESSION_METRICS = 'X-Compression-Metrics';
const HEADER_ACCEPT_ENCODING = 'Accept-Encoding';
const HEADER_AUTHORIZATION = 'Authorization';
const HEADER_X_CLIENT_INFO = 'x-client-info';
const CLIENT_INFO_VALUE = 'authoria-edge-function';
const STORES_TABLE = 'stores';
const ID_COLUMN = 'id';
const DEFAULT_CACHE_KEY = 'default';
const DEFAULT_CLIENT_TYPE: 'service' | 'anon' = 'service';
const DEFAULT_ENCODING = 'auto';
const DEFAULT_COMPRESSION = 'brotli';
const ENV_SUPABASE_URL = 'SUPABASE_URL';
const ENV_SUPABASE_SERVICE_ROLE_KEY = 'SUPABASE_SERVICE_ROLE_KEY';
const ENV_SUPABASE_ANON_KEY = 'SUPABASE_ANON_KEY';
const ENV_SUPABASE_CLIENT_REFRESH_INTERVAL = 'SUPABASE_CLIENT_REFRESH_INTERVAL';
const ENV_SUPABASE_CLIENT_HEALTH_CHECK_INTERVAL = 'SUPABASE_CLIENT_HEALTH_CHECK_INTERVAL';
const ENV_SUPABASE_CLIENT_MAX_RETRIES = 'SUPABASE_CLIENT_MAX_RETRIES';
const ENV_SUPABASE_ENABLE_POOLING = 'SUPABASE_ENABLE_POOLING';
const ENV_COMPRESSION_LEVEL = 'COMPRESSION_LEVEL';
const ENV_COMPRESSION_THRESHOLD = 'COMPRESSION_THRESHOLD';
const ENV_COMPRESSION_CACHE_ENABLED = 'COMPRESSION_CACHE_ENABLED';
const ENV_COMPRESSION_CACHE_TTL = 'COMPRESSION_CACHE_TTL';
const ENV_LOG_LEVEL = 'LOG_LEVEL';
const ENV_ENABLE_METRICS = 'ENABLE_METRICS';
const ENV_ENABLE_PERFORMANCE_MONITORING = 'ENABLE_PERFORMANCE_MONITORING';
const ENV_RATE_LIMIT_ENABLED = 'RATE_LIMIT_ENABLED';
const ENV_RATE_LIMIT_MAX_REQUESTS = 'RATE_LIMIT_MAX_REQUESTS';
const ENV_RATE_LIMIT_WINDOW_MS = 'RATE_LIMIT_WINDOW_MS';
const ENV_VALUE_TRUE = 'true';
const ENV_VALUE_FALSE = 'false';
const DEFAULT_LOG_LEVEL: LogLevelKey = 'INFO';
const SCHEMA_PUBLIC = 'public';
const ENCODING_BR = 'br';
const ENCODING_GZIP = 'gzip';
const ENCODING_NONE = 'none';
const BEARER_PREFIX = 'Bearer ';
const BEARER_PREFIX_LENGTH = 7;
const MIN_TOKEN_LENGTH = 10;
const JWT_PARTS_COUNT = 3;
const BASE64_PADDING_CHAR = '=';
const BASE64_URL_REPLACE_DASH = /-/g;
const BASE64_URL_REPLACE_UNDERSCORE = /_/g;
const BASE64_URL_PLUS = '+';
const BASE64_URL_SLASH = '/';
const BASE64_MODULO = 4;
const JWT_AUD_AUTHENTICATED = 'authenticated';
const JWT_AUD_ANON = 'anon';
const JWT_ROLE_ANON = 'anon';
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g;
const SCRIPT_TAG_REGEX = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const EVENT_HANDLER_REGEX = /\son\w+\s*=\s*["'][^"']*["']/gi;
const JAVASCRIPT_PROTOCOL_REGEX = /javascript:/gi;
const DATA_HTML_REGEX = /data:\s*text\/html/gi;
const CORS_HEADER_ORIGIN = 'Origin';
const CORS_HEADER_ALLOW_ORIGIN = 'Access-Control-Allow-Origin';
const CORS_HEADER_ALLOW_HEADERS = 'Access-Control-Allow-Headers';
const CORS_HEADER_ALLOW_METHODS = 'Access-Control-Allow-Methods';
const CORS_HEADER_MAX_AGE = 'Access-Control-Max-Age';
const CORS_HEADER_ALLOW_CREDENTIALS = 'Access-Control-Allow-Credentials';
const CORS_MAX_AGE = '86400';
const CORS_CREDENTIALS_TRUE = 'true';
const CORS_CREDENTIALS_FALSE = 'false';
const CORS_ALLOWED_HEADERS = 'authorization, x-client-info, apikey, content-type, x-correlation-id, x-request-id';
const CORS_ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';

function getEnv(key: string, defaultValue = ''): string {
  try {
    const deno = (globalThis as DenoGlobal).Deno;
    return deno?.env?.get?.(key) ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

function parseIntSafe(value: string, defaultValue: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

const CONFIG = {
  CLIENT_REFRESH_INTERVAL: parseIntSafe(getEnv(ENV_SUPABASE_CLIENT_REFRESH_INTERVAL, String(DEFAULT_CLIENT_REFRESH_INTERVAL)), DEFAULT_CLIENT_REFRESH_INTERVAL),
  CLIENT_HEALTH_CHECK_INTERVAL: parseIntSafe(getEnv(ENV_SUPABASE_CLIENT_HEALTH_CHECK_INTERVAL, String(DEFAULT_CLIENT_HEALTH_CHECK_INTERVAL)), DEFAULT_CLIENT_HEALTH_CHECK_INTERVAL),
  CLIENT_MAX_RETRIES: parseIntSafe(getEnv(ENV_SUPABASE_CLIENT_MAX_RETRIES, String(DEFAULT_CLIENT_MAX_RETRIES)), DEFAULT_CLIENT_MAX_RETRIES),
  ENABLE_CONNECTION_POOLING: getEnv(ENV_SUPABASE_ENABLE_POOLING, ENV_VALUE_TRUE) !== ENV_VALUE_FALSE,
  COMPRESSION_LEVEL: parseIntSafe(getEnv(ENV_COMPRESSION_LEVEL, String(DEFAULT_COMPRESSION_LEVEL)), DEFAULT_COMPRESSION_LEVEL),
  COMPRESSION_THRESHOLD: parseIntSafe(getEnv(ENV_COMPRESSION_THRESHOLD, String(DEFAULT_COMPRESSION_THRESHOLD)), DEFAULT_COMPRESSION_THRESHOLD),
  COMPRESSION_CACHE_ENABLED: getEnv(ENV_COMPRESSION_CACHE_ENABLED, ENV_VALUE_TRUE) !== ENV_VALUE_FALSE,
  COMPRESSION_CACHE_TTL: parseIntSafe(getEnv(ENV_COMPRESSION_CACHE_TTL, String(DEFAULT_COMPRESSION_CACHE_TTL)), DEFAULT_COMPRESSION_CACHE_TTL),
  LOG_LEVEL: (getEnv(ENV_LOG_LEVEL, DEFAULT_LOG_LEVEL)) as LogLevelKey,
  ENABLE_METRICS: getEnv(ENV_ENABLE_METRICS, ENV_VALUE_TRUE) !== ENV_VALUE_FALSE,
  ENABLE_PERFORMANCE_MONITORING: getEnv(ENV_ENABLE_PERFORMANCE_MONITORING, ENV_VALUE_TRUE) !== ENV_VALUE_FALSE,
  RATE_LIMIT_ENABLED: getEnv(ENV_RATE_LIMIT_ENABLED, ENV_VALUE_FALSE) === ENV_VALUE_TRUE,
  RATE_LIMIT_MAX_REQUESTS: parseIntSafe(getEnv(ENV_RATE_LIMIT_MAX_REQUESTS, String(DEFAULT_RATE_LIMIT_MAX_REQUESTS)), DEFAULT_RATE_LIMIT_MAX_REQUESTS),
  RATE_LIMIT_WINDOW_MS: parseIntSafe(getEnv(ENV_RATE_LIMIT_WINDOW_MS, String(DEFAULT_RATE_LIMIT_WINDOW_MS)), DEFAULT_RATE_LIMIT_WINDOW_MS),
} as const;

const LOG_LEVELS: LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const;

const currentLogLevel = LOG_LEVELS[CONFIG.LOG_LEVEL] ?? LOG_LEVELS.INFO;

function log(level: LogLevelKey, message: string, data?: Readonly<Record<string, unknown>>): void {
  const levelValue = LOG_LEVELS[level];
  if (levelValue < currentLogLevel) return;

  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...(data && { data }),
  };

  if (level === 'ERROR') {
    console.error(JSON.stringify(logEntry));
  } else if (level === 'WARN') {
    console.warn(JSON.stringify(logEntry));
  } else {
    console.log(JSON.stringify(logEntry));
  }
}

export const logger = {
  debug: (message: string, data?: Readonly<Record<string, unknown>>) => log('DEBUG', message, data),
  info: (message: string, data?: Readonly<Record<string, unknown>>) => log('INFO', message, data),
  warn: (message: string, data?: Readonly<Record<string, unknown>>) => log('WARN', message, data),
  error: (message: string, data?: Readonly<Record<string, unknown>>) => log('ERROR', message, data),
};

export class UtilsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'UtilsError';
  }
}

export class SupabaseClientError extends UtilsError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, 'SUPABASE_CLIENT_ERROR', 500, details);
    this.name = 'SupabaseClientError';
  }
}

class CompressionError extends UtilsError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, 'COMPRESSION_ERROR', 500, details);
    this.name = 'CompressionError';
  }
}

function validateSupabaseConfig(config: SupabaseClientConfig): void {
  if (!config.url || typeof config.url !== 'string') {
    throw new SupabaseClientError('SUPABASE_URL is required and must be a string');
  }
  if (!config.key || typeof config.key !== 'string') {
    throw new SupabaseClientError('SUPABASE_KEY is required and must be a string');
  }
}

function validateCompressionOptions(options: CompressionOptions): void {
  if (options.level !== undefined) {
    if (options.encoding === 'brotli' && (options.level < BROTLI_LEVEL_MIN || options.level > BROTLI_LEVEL_MAX)) {
      throw new CompressionError('Brotli compression level must be between 1 and 11');
    }
    if (options.encoding === 'gzip' && (options.level < GZIP_LEVEL_MIN || options.level > GZIP_LEVEL_MAX)) {
      throw new CompressionError('Gzip compression level must be between 1 and 9');
    }
  }
  if (options.threshold !== undefined && options.threshold < 0) {
    throw new CompressionError('Compression threshold must be non-negative');
  }
}

const performanceMetrics: PerformanceMetrics[] = [];

function trackPerformance(functionName: string, duration: number, metadata?: Readonly<Record<string, unknown>>): void {
  if (!CONFIG.ENABLE_PERFORMANCE_MONITORING) return;

  const metric: PerformanceMetrics = {
    functionName,
    duration,
    timestamp: Date.now(),
    metadata,
  };

  performanceMetrics.push(metric);
  if (performanceMetrics.length > MAX_METRICS_HISTORY) {
    performanceMetrics.shift();
  }
}

export function getPerformanceMetrics(functionName?: string): readonly PerformanceMetrics[] {
  if (functionName) {
    return performanceMetrics.filter((m) => m.functionName === functionName);
  }
  return [...performanceMetrics];
}

function withPerformanceTracking<T>(
  functionName: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const start = performance.now();
  const result = fn();

  if (result instanceof Promise) {
    return result.finally(() => {
      const duration = performance.now() - start;
      trackPerformance(functionName, duration);
    });
  }

  const duration = performance.now() - start;
  trackPerformance(functionName, duration);
  return Promise.resolve(result);
}

const clientInstances = new Map<string, ClientInstance>();
const clientMetrics: ClientMetrics = {
  created: 0,
  reused: 0,
  errors: 0,
  healthChecks: 0,
  recoveries: 0,
};

async function healthCheckClient(client: ReturnType<typeof createClient>): Promise<boolean> {
  try {
    const { error } = await client.from(STORES_TABLE).select(ID_COLUMN).limit(1);
    return !error;
  } catch {
    return false;
  }
}

function createSupabaseClient(config: SupabaseClientConfig): ReturnType<typeof createClient> {
  validateSupabaseConfig(config);

  const clientOptions: SupabaseClientOptions = {
    auth: {
      persistSession: false,
    },
    global: {
      headers: {
        [HEADER_X_CLIENT_INFO]: CLIENT_INFO_VALUE,
        ...(config.authHeader && { [HEADER_AUTHORIZATION]: config.authHeader }),
      },
    },
  };

  if (CONFIG.ENABLE_CONNECTION_POOLING) {
    clientOptions.db = {
      schema: SCHEMA_PUBLIC,
    };
  }

  const client = createClient(config.url, config.key, clientOptions);
  clientMetrics.created++;
  logger.debug('Created new Supabase client', { clientType: config.clientType });
  return client;
}

export async function getSupabaseClient(
  options: {
    readonly authHeader?: string;
    readonly clientType?: 'service' | 'anon';
    readonly forceNew?: boolean;
  } = {},
): Promise<ReturnType<typeof createClient>> {
  return withPerformanceTracking('getSupabaseClient', async () => {
    const clientType = options.clientType ?? DEFAULT_CLIENT_TYPE;
    const cacheKey = `${clientType}_${options.authHeader ?? DEFAULT_CACHE_KEY}`;
    const now = Date.now();

    if (options.forceNew) {
      logger.debug('Forcing new Supabase client creation');
      const config: SupabaseClientConfig = {
        url: getEnv(ENV_SUPABASE_URL, ''),
        key: clientType === 'service'
          ? getEnv(ENV_SUPABASE_SERVICE_ROLE_KEY, '')
          : getEnv(ENV_SUPABASE_ANON_KEY, ''),
        authHeader: options.authHeader,
        clientType,
      };
      return createSupabaseClient(config);
    }

    let instance = clientInstances.get(cacheKey);

    const needsRefresh = !instance ||
      (now - instance.lastInitTime) > CONFIG.CLIENT_REFRESH_INTERVAL ||
      !instance.isHealthy;

    if (needsRefresh) {
      if (instance && (now - instance.lastHealthCheck) > CONFIG.CLIENT_HEALTH_CHECK_INTERVAL) {
        instance.lastHealthCheck = now;
        clientMetrics.healthChecks++;
        const isHealthy = await healthCheckClient(instance.client);
        instance.isHealthy = isHealthy;

        if (!isHealthy) {
          logger.warn('Supabase client health check failed, recreating', { cacheKey });
          instance.errorCount++;

          if (instance.errorCount >= CONFIG.CLIENT_MAX_RETRIES) {
            logger.warn('Max retries reached, resetting client', { cacheKey });
            clientInstances.delete(cacheKey);
            clientMetrics.recoveries++;
            instance = undefined;
          }
        }
      }

      if (!instance || !instance.isHealthy) {
        const config: SupabaseClientConfig = {
          url: getEnv(ENV_SUPABASE_URL, ''),
          key: clientType === 'service'
            ? getEnv(ENV_SUPABASE_SERVICE_ROLE_KEY, '')
            : getEnv(ENV_SUPABASE_ANON_KEY, ''),
          authHeader: options.authHeader,
          clientType,
        };

        const client = createSupabaseClient(config);
        instance = {
          client,
          lastInitTime: now,
          lastHealthCheck: now,
          isHealthy: true,
          errorCount: 0,
          clientType,
        };
        clientInstances.set(cacheKey, instance);
      }
    } else {
      clientMetrics.reused++;
      logger.debug('Reusing existing Supabase client', { cacheKey });
    }

    const finalInstance = clientInstances.get(cacheKey);
    if (!finalInstance) {
      throw new SupabaseClientError('Failed to create Supabase client instance');
    }

    return finalInstance.client;
  });
}

export async function createAuthenticatedClient(authHeader: string): Promise<ReturnType<typeof createClient>> {
  return withPerformanceTracking('createAuthenticatedClient', () => {
    const config: SupabaseClientConfig = {
      url: getEnv(ENV_SUPABASE_URL, ''),
      key: getEnv(ENV_SUPABASE_ANON_KEY, ''),
      authHeader,
      clientType: 'anon',
    };
    return createSupabaseClient(config);
  });
}

export function getClientMetrics() {
  return {
    ...clientMetrics,
    activeClients: clientInstances.size,
    clients: Array.from(clientInstances.entries()).map(([key, instance]) => ({
      key,
      clientType: instance.clientType,
      lastInitTime: instance.lastInitTime,
      isHealthy: instance.isHealthy,
      errorCount: instance.errorCount,
    })),
  };
}

function cleanupClients(): void {
  const now = Date.now();
  const maxAge = CONFIG.CLIENT_REFRESH_INTERVAL * CLIENT_CLEANUP_MULTIPLIER;

  for (const [key, instance] of clientInstances.entries()) {
    if (now - instance.lastInitTime > maxAge) {
      clientInstances.delete(key);
      logger.debug('Cleaned up old Supabase client', { key });
    }
  }
}

const compressionCache = new Map<string, CompressionCacheEntry>();

function detectContentType(data: string | object): string {
  if (typeof data === 'string') {
    try {
      JSON.parse(data);
      return CONTENT_TYPE_JSON;
    } catch {
      return CONTENT_TYPE_PLAIN;
    }
  }
  return CONTENT_TYPE_JSON;
}

function getCompressionLevel(encoding: string, level?: number): number {
  const defaultLevel = CONFIG.COMPRESSION_LEVEL;
  if (level !== undefined) {
    return encoding === 'brotli' ? Math.min(BROTLI_LEVEL_MAX, Math.max(BROTLI_LEVEL_MIN, level)) : Math.min(GZIP_LEVEL_MAX, Math.max(GZIP_LEVEL_MIN, level));
  }
  return defaultLevel;
}

async function compressStream(input: Uint8Array, format: CompressionFormat): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    return input;
  }

  try {
    const stream = new CompressionStream(format);
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    writer.write(input as BufferSource);
    writer.close();

    const chunks: Uint8Array[] = [];
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        chunks.push(value);
      }
    }

    const compressed = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      compressed.set(chunk, offset);
      offset += chunk.length;
    }

    return compressed;
  } catch (error) {
    logger.error('Compression failed', { format, error });
    throw new CompressionError(`Compression failed: ${format}`, { format, error });
  }
}

async function compressGzip(input: Uint8Array, level = DEFAULT_COMPRESSION_LEVEL): Promise<Uint8Array> {
  return compressStream(input, GZIP_ENCODING);
}

async function compressBrotli(input: Uint8Array, level = DEFAULT_COMPRESSION_LEVEL): Promise<Uint8Array> {
  return compressStream(input, BROTLI_ENCODING as CompressionFormat);
}

function generateCompressionCacheKey(jsonString: string, encoding: string, level: number): string {
  return `${jsonString}_${encoding}_${level}`;
}

function cleanupCompressionCache(): void {
  if (compressionCache.size <= COMPRESSION_CACHE_CLEANUP_THRESHOLD) {
    return;
  }

  const now = Date.now();
  for (const [key, value] of compressionCache.entries()) {
    if (now - value.timestamp > CONFIG.COMPRESSION_CACHE_TTL) {
      compressionCache.delete(key);
    }
  }
}

async function compressResponse(
  data: string | object,
  options: CompressionOptions = {},
): Promise<{ readonly body: Uint8Array; readonly encoding: string; readonly contentType: string; readonly metrics?: CompressionMetrics }> {
  return withPerformanceTracking('compressResponse', async () => {
    const startTime = performance.now();
    validateCompressionOptions(options);

    const jsonString = typeof data === 'string' ? data : JSON.stringify(data);
    const encoder = new TextEncoder();
    const input = encoder.encode(jsonString);
    const originalSize = input.length;

    const threshold = options.threshold ?? CONFIG.COMPRESSION_THRESHOLD;
    if (originalSize < threshold) {
      logger.debug('Response too small to compress', { size: originalSize, threshold });
      return {
        body: input,
        encoding: IDENTITY_ENCODING,
        contentType: options.contentType ?? detectContentType(data),
        metrics: {
          originalSize,
          compressedSize: originalSize,
          ratio: 1,
          encoding: IDENTITY_ENCODING,
          timeMs: performance.now() - startTime,
        },
      };
    }

    const encoding = options.encoding ?? DEFAULT_ENCODING;
    const compressionLevel = getCompressionLevel(encoding, options.level);

    if (CONFIG.COMPRESSION_CACHE_ENABLED && options.cache !== false) {
      const cacheKey = generateCompressionCacheKey(jsonString, encoding, compressionLevel);
      const cached = compressionCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < CONFIG.COMPRESSION_CACHE_TTL) {
        logger.debug('Using cached compression result');
        return {
          body: cached.data,
          encoding: cached.encoding,
          contentType: options.contentType ?? detectContentType(data),
          metrics: {
            originalSize,
            compressedSize: cached.data.length,
            ratio: cached.data.length / originalSize,
            encoding: cached.encoding,
            timeMs: performance.now() - startTime,
          },
        };
      }
    }

    let finalEncoding = encoding;
    if (options.adaptive || encoding === DEFAULT_ENCODING) {
      finalEncoding = DEFAULT_COMPRESSION;
    }

    let compressed: Uint8Array;
    let finalEncodingResult: string;

    try {
      if (finalEncoding === 'brotli' || encoding === DEFAULT_ENCODING) {
        try {
          compressed = await compressBrotli(input, compressionLevel);
          finalEncodingResult = BROTLI_ENCODING;
        } catch {
          logger.warn('Brotli compression failed, falling back to gzip');
          compressed = await compressGzip(input, compressionLevel);
          finalEncodingResult = GZIP_ENCODING;
        }
      } else {
        compressed = await compressGzip(input, compressionLevel);
        finalEncodingResult = GZIP_ENCODING;
      }

      if (CONFIG.COMPRESSION_CACHE_ENABLED && options.cache !== false) {
        const cacheKey = generateCompressionCacheKey(jsonString, encoding, compressionLevel);
        compressionCache.set(cacheKey, {
          data: compressed,
          encoding: finalEncodingResult,
          timestamp: Date.now(),
        });
        cleanupCompressionCache();
      }

      const metrics: CompressionMetrics = {
        originalSize,
        compressedSize: compressed.length,
        ratio: compressed.length / originalSize,
        encoding: finalEncodingResult,
        timeMs: performance.now() - startTime,
      };

      logger.debug('Compression completed', metrics as unknown as Readonly<Record<string, unknown>>);

      return {
        body: compressed,
        encoding: finalEncodingResult,
        contentType: options.contentType ?? detectContentType(data),
        metrics,
      };
    } catch (error) {
      logger.error('Compression failed, returning uncompressed', { error });
      return {
        body: input,
        encoding: IDENTITY_ENCODING,
        contentType: options.contentType ?? detectContentType(data),
        metrics: {
          originalSize,
          compressedSize: originalSize,
          ratio: 1,
          encoding: IDENTITY_ENCODING,
          timeMs: performance.now() - startTime,
        },
      };
    }
  });
}

export async function createCompressedResponse(
  data: string | object,
  options: CompressionOptions & {
    readonly status?: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly request?: Request;
  } = {},
): Promise<Response> {
  return withPerformanceTracking('createCompressedResponse', async () => {
    let compressionOptions = { ...options };
    if (options.adaptive && options.request) {
      const acceptEncoding = acceptsCompression(options.request);
      if (acceptEncoding === 'brotli') {
        compressionOptions.encoding = 'brotli';
      } else if (acceptEncoding === GZIP_ENCODING) {
        compressionOptions.encoding = GZIP_ENCODING;
      } else {
        compressionOptions.encoding = DEFAULT_ENCODING;
      }
    }

    const { body, encoding, contentType, metrics } = await compressResponse(data, compressionOptions);

    const headerObj: Record<string, string> = {
      [HEADER_CONTENT_TYPE]: options.contentType ?? contentType,
      [HEADER_CONTENT_ENCODING]: encoding,
      [HEADER_VARY]: HEADER_ACCEPT_ENCODING,
      ...(options.headers ?? {}),
    };

    if (CONFIG.ENABLE_METRICS && metrics) {
      headerObj[HEADER_X_COMPRESSION_METRICS] = JSON.stringify({
        ratio: metrics.ratio.toFixed(2),
        encoding: metrics.encoding,
        timeMs: metrics.timeMs.toFixed(2),
      });
    }

    const headers = new Headers();
    Object.entries(headerObj).forEach(([key, value]) => {
      headers.set(key, value);
    });

    return new Response(body as BodyInit, {
      status: options.status ?? DEFAULT_STATUS_CODE,
      headers,
    });
  });
}

export function acceptsCompression(request: Request): 'gzip' | 'brotli' | 'none' {
  const acceptEncoding = request.headers.get(HEADER_ACCEPT_ENCODING) ?? '';

  if (acceptEncoding.includes(ENCODING_BR)) {
    return 'brotli';
  } else if (acceptEncoding.includes(ENCODING_GZIP)) {
    return GZIP_ENCODING;
  }

  return ENCODING_NONE;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

export function checkRateLimit(
  key: string,
  maxRequests: number = CONFIG.RATE_LIMIT_MAX_REQUESTS,
  windowMs: number = CONFIG.RATE_LIMIT_WINDOW_MS,
): { readonly allowed: boolean; readonly remaining: number; readonly resetAt: number } {
  if (!CONFIG.RATE_LIMIT_ENABLED) {
    return { allowed: true, remaining: Infinity, resetAt: Date.now() + windowMs };
  }

  const now = Date.now();
  let entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetTime) {
    entry = {
      count: 0,
      resetTime: now + windowMs,
    };
    rateLimitStore.set(key, entry);
  }

  entry.count++;

  if (rateLimitStore.size > RATE_LIMIT_CLEANUP_THRESHOLD) {
    for (const [k, e] of rateLimitStore.entries()) {
      if (now > e.resetTime) {
        rateLimitStore.delete(k);
      }
    }
  }

  return {
    allowed: entry.count <= maxRequests,
    remaining: Math.max(0, maxRequests - entry.count),
    resetAt: entry.resetTime,
  };
}

const requestInterceptors: RequestInterceptor[] = [];
const responseInterceptors: ResponseInterceptor[] = [];
const errorInterceptors: ErrorInterceptor[] = [];

export async function executeRequestInterceptors(request: Request): Promise<Request> {
  let processedRequest = request;
  for (const interceptor of requestInterceptors) {
    processedRequest = await interceptor(processedRequest);
  }
  return processedRequest;
}

export async function executeResponseInterceptors(response: Response): Promise<Response> {
  let processedResponse = response;
  for (const interceptor of responseInterceptors) {
    processedResponse = await interceptor(processedResponse);
  }
  return processedResponse;
}

export async function executeErrorInterceptors(error: Error, request: Request): Promise<Response | null> {
  for (const interceptor of errorInterceptors) {
    const response = await interceptor(error, request);
    if (response) {
      return response;
    }
  }
  return null;
}

function decodeBase64Url(base64Url: string): string {
  const base64 = base64Url
    .replace(BASE64_URL_REPLACE_DASH, BASE64_URL_PLUS)
    .replace(BASE64_URL_REPLACE_UNDERSCORE, BASE64_URL_SLASH);
  const padding = BASE64_PADDING_CHAR.repeat((BASE64_MODULO - (base64.length % BASE64_MODULO)) % BASE64_MODULO);
  return atob(base64 + padding);
}

export async function validateJWT(
  token: string,
  supabaseUrl: string,
  anonKey: string,
): Promise<JWTValidationResult> {
  try {
    const parts = token.split('.');
    if (parts.length !== JWT_PARTS_COUNT) {
      return { valid: false, error: 'Invalid JWT format' };
    }

    let payload: JWTPayload;
    try {
      const payloadJson = decodeBase64Url(parts[1]!);
      payload = JSON.parse(payloadJson) as JWTPayload;
    } catch {
      return { valid: false, error: 'Invalid JWT payload' };
    }

    if (payload.exp) {
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) {
        return { valid: false, error: 'JWT token expired' };
      }
    }

    const userId = payload.sub;
    if (!userId && payload.role !== JWT_ROLE_ANON) {
      return { valid: false, error: 'JWT missing subject' };
    }

    if (payload.aud && payload.aud !== JWT_AUD_AUTHENTICATED && payload.aud !== JWT_AUD_ANON) {
      logger.debug('JWT has unexpected audience', { aud: payload.aud });
    }

    return {
      valid: true,
      userId,
      payload,
    };
  } catch (error) {
    logger.error('JWT validation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'JWT validation failed',
    };
  }
}

export async function validateAuthHeader(
  authHeader: string | null,
  supabaseUrl: string,
  anonKey: string,
): Promise<JWTValidationResult> {
  if (!authHeader) {
    return { valid: false, error: 'Missing authorization header' };
  }

  if (!authHeader.startsWith(BEARER_PREFIX)) {
    return { valid: false, error: 'Invalid authorization format' };
  }

  const token = authHeader.substring(BEARER_PREFIX_LENGTH);
  if (token.length < MIN_TOKEN_LENGTH) {
    return { valid: false, error: 'Token too short' };
  }

  return await validateJWT(token, supabaseUrl, anonKey);
}

export function validateInput(
  data: Readonly<Record<string, unknown>>,
  rules: ReadonlyArray<ValidationRule>,
): ValidationResult {
  const errors: Array<{ field: string; error: string }> = [];

  for (const rule of rules) {
    const value = data[rule.field];

    if (rule.required && (value === undefined || value === null || value === '')) {
      errors.push({ field: rule.field, error: `${rule.field} is required` });
      continue;
    }

    if (!rule.required && (value === undefined || value === null)) {
      continue;
    }

    if (rule.type) {
      const typeMatch = checkType(value, rule.type);
      if (!typeMatch) {
        errors.push({
          field: rule.field,
          error: `${rule.field} must be of type ${rule.type}`,
        });
        continue;
      }
    }

    if (rule.type === 'string' && typeof value === 'string') {
      if (rule.minLength !== undefined && value.length < rule.minLength) {
        errors.push({
          field: rule.field,
          error: `${rule.field} must be at least ${rule.minLength} characters`,
        });
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        errors.push({
          field: rule.field,
          error: `${rule.field} must be at most ${rule.maxLength} characters`,
        });
      }
      if (rule.pattern && !rule.pattern.test(value)) {
        errors.push({
          field: rule.field,
          error: `${rule.field} format is invalid`,
        });
      }
    }

    if (rule.enum && !rule.enum.includes(value as string)) {
      errors.push({
        field: rule.field,
        error: `${rule.field} must be one of: ${rule.enum.join(', ')}`,
      });
    }

    if (rule.validate) {
      const customResult = rule.validate(value);
      if (customResult !== true) {
        errors.push({
          field: rule.field,
          error: typeof customResult === 'string' ? customResult : `${rule.field} validation failed`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

function checkType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

export function sanitizeHTML(content: string): string {
  let sanitized = content.replace(SCRIPT_TAG_REGEX, '');
  sanitized = sanitized.replace(EVENT_HANDLER_REGEX, '');
  sanitized = sanitized.replace(JAVASCRIPT_PROTOCOL_REGEX, '');
  sanitized = sanitized.replace(DATA_HTML_REGEX, '');
  return sanitized.trim();
}

export function sanitizeText(content: string): string {
  return content
    .replace(CONTROL_CHARS_REGEX, '')
    .trim();
}

export function createCORSHeaders(
  request: Request,
  allowedOrigins: ReadonlyArray<string> | string = '*',
): Readonly<Record<string, string>> {
  const originHeader = request.headers.get(CORS_HEADER_ORIGIN);
  let allowedOrigin = '*';

  if (typeof allowedOrigins === 'string') {
    allowedOrigin = allowedOrigins;
  } else if (allowedOrigins.length > 0) {
    if (allowedOrigins[0] === '*') {
      allowedOrigin = '*';
    } else if (originHeader && allowedOrigins.includes(originHeader)) {
      allowedOrigin = originHeader;
    } else if (allowedOrigins.length === 1) {
      allowedOrigin = allowedOrigins[0]!;
    }
  }

  return {
    [CORS_HEADER_ALLOW_ORIGIN]: allowedOrigin,
    [CORS_HEADER_ALLOW_HEADERS]: CORS_ALLOWED_HEADERS,
    [CORS_HEADER_ALLOW_METHODS]: CORS_ALLOWED_METHODS,
    [CORS_HEADER_MAX_AGE]: CORS_MAX_AGE,
    [CORS_HEADER_ALLOW_CREDENTIALS]: allowedOrigin !== '*' ? CORS_CREDENTIALS_TRUE : CORS_CREDENTIALS_FALSE,
  };
}

export function getMemoryStats() {
  try {
    const deno = (globalThis as DenoGlobal).Deno;
    const memory = deno?.memoryUsage?.() ?? {};
    return {
      ...memory,
      clientInstances: clientInstances.size,
      compressionCacheSize: compressionCache.size,
      rateLimitEntries: rateLimitStore.size,
      performanceMetricsCount: performanceMetrics.length,
    };
  } catch {
    return {
      clientInstances: clientInstances.size,
      compressionCacheSize: compressionCache.size,
      rateLimitEntries: rateLimitStore.size,
      performanceMetricsCount: performanceMetrics.length,
    };
  }
}
