import axios, { AxiosInstance, AxiosError } from 'axios';
import { retry } from '../utils/error-handling.ts';
import { RateLimiter } from '../utils/rate-limiter.ts';

export type FluxModel = 'pro' | 'flex';
export type AspectRatio = '16:9' | '1:1' | '9:16' | '4:3' | '3:4';

export interface ImageGenerationOptions {
  readonly prompt: string;
  readonly aspectRatio?: AspectRatio;
  readonly width?: number;
  readonly height?: number;
  readonly seed?: number;
  readonly safetyTolerance?: number;
  readonly outputFormat?: 'jpeg' | 'png';
  readonly model?: FluxModel;
  readonly steps?: number;
  readonly guidance?: number;
}

export interface GenerationResult {
  readonly imageUrl: string;
  readonly cost: number;
  readonly inputMp: number;
  readonly outputMp: number;
}

interface SubmitResponse {
  readonly id: string;
  readonly polling_url: string;
  readonly cost?: number;
  readonly input_mp?: number;
  readonly output_mp?: number;
}

type PollStatus = 'Ready' | 'Failed' | 'Processing' | 'Pending';

interface PollResponse {
  readonly status: PollStatus;
  readonly result?: {
    readonly sample: string;
  };
  readonly error?: string;
}

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

type LogLevel = 'info' | 'warn' | 'error';

const structuredLog = (
  level: LogLevel,
  service: string,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): void => {
  const payload = JSON.stringify({
    level,
    service,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  });

  if (typeof globalThis === 'undefined' || !('Deno' in globalThis)) {
    return;
  }

  const encoder = new TextEncoder();
  const deno = globalThis as unknown as { Deno: { stderr: { writeSync: (data: Uint8Array) => void }; stdout: { writeSync: (data: Uint8Array) => void } } };
  
  if (level === 'error') {
    deno.Deno.stderr.writeSync(encoder.encode(payload + '\n'));
    return;
  }

  deno.Deno.stdout.writeSync(encoder.encode(payload + '\n'));
};

const nowMs = (): number => Date.now();

const getCache = <T>(cache: Map<string, CacheEntry<T>>, key: string): T | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (nowMs() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
};

const setCache = <T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void => {
  cache.set(key, { value, expiresAt: nowMs() + ttlMs });
};

const cleanupExpiredCache = <T>(cache: Map<string, CacheEntry<T>>): void => {
  const now = nowMs();
  for (const [key, entry] of cache.entries()) {
    if (now > entry.expiresAt) {
      cache.delete(key);
    }
  }
};

const hashString = (input: string): string => {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
};

const validatePrompt = (prompt: string): void => {
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('Invalid prompt: must be a non-empty string');
  }
  if (prompt.length > 2000) {
    throw new Error('Invalid prompt: exceeds maximum length of 2000 characters');
  }
};

const validateDimensions = (width: number, height: number): void => {
  if (!Number.isInteger(width) || width < 1 || width > 4096) {
    throw new Error('Invalid width: must be an integer between 1 and 4096');
  }
  if (!Number.isInteger(height) || height < 1 || height > 4096) {
    throw new Error('Invalid height: must be an integer between 1 and 4096');
  }
};

const validateSeed = (seed: number): void => {
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
    throw new Error('Invalid seed: must be an integer between 0 and 4294967295');
  }
};

const validateSafetyTolerance = (tolerance: number): void => {
  if (typeof tolerance !== 'number' || tolerance < 0 || tolerance > 10) {
    throw new Error('Invalid safetyTolerance: must be a number between 0 and 10');
  }
};

export class ImageGenerator {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly axios: AxiosInstance;
  private readonly limiter: RateLimiter;
  private readonly responseCache: Map<string, CacheEntry<GenerationResult>>;
  private readonly inflight: Map<string, Promise<GenerationResult>>;
  private cacheCleanupInterval?: number;

  private static readonly BASE_URL = 'https://api.bfl.ai';
  private static readonly MAX_RETRIES = 60;
  private static readonly POLL_INTERVAL = 500;
  private static readonly DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffMultiplier: 2,
    retryableErrors: ['rate limit', 'timeout', 'network'] as const,
  } as const;
  private static readonly FORCED_MODEL: FluxModel = 'pro';
  private static readonly DIMENSION_MULTIPLE = 16;
  private static readonly MAX_DIMENSION = 2048;
  private static readonly DEFAULT_ASPECT_RATIO: AspectRatio = '16:9';
  private static readonly DEFAULT_OUTPUT_FORMAT = 'jpeg' as const;
  private static readonly NOT_FOUND_STATUS = 404;
  private static readonly CACHE_TTL_MS = 30 * 60 * 1000;
  private static readonly CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly SERVICE_NAME = 'ImageGenerator';
  private static readonly MAX_WAIT_MS = 60_000;

  private static readonly ASPECT_RATIO_DIMENSIONS: Readonly<Record<AspectRatio, Dimensions>> = {
    '16:9': { width: 1360, height: 768 },
    '1:1': { width: 1024, height: 1024 },
    '9:16': { width: 1080, height: 1920 },
    '4:3': { width: 1280, height: 960 },
    '3:4': { width: 960, height: 1280 },
  } as const;

  constructor(apiKey: string) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new Error('API key is required');
    }
    this.apiKey = apiKey;
    this.baseUrl = ImageGenerator.BASE_URL;
    this.axios = axios.create({
      baseURL: this.baseUrl,
      headers: {
        accept: 'application/json',
        'x-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    this.limiter = new RateLimiter({
      maxRequests: 10,
      windowMs: 60000,
      burst: 2,
      algorithm: 'token-bucket',
      keyPrefix: 'flux-api',
      concurrency: 5,
    });
    this.responseCache = new Map();
    this.inflight = new Map();
    this.startCacheCleanup();
  }

  private startCacheCleanup(): void {
    if (typeof globalThis !== 'undefined' && 'setInterval' in globalThis) {
      this.cacheCleanupInterval = setInterval(() => {
        cleanupExpiredCache(this.responseCache);
      }, ImageGenerator.CACHE_CLEANUP_INTERVAL_MS) as unknown as number;
    }
  }

  destroy(): void {
    if (this.cacheCleanupInterval !== undefined && typeof globalThis !== 'undefined' && 'clearInterval' in globalThis) {
      clearInterval(this.cacheCleanupInterval);
    }
    this.responseCache.clear();
    this.inflight.clear();
  }

  async generateImage(options: ImageGenerationOptions): Promise<GenerationResult> {
    validatePrompt(options.prompt);

    if (options.width !== undefined && options.height !== undefined) {
      validateDimensions(options.width, options.height);
    }

    if (options.seed !== undefined) {
      validateSeed(options.seed);
    }

    if (options.safetyTolerance !== undefined) {
      validateSafetyTolerance(options.safetyTolerance);
    }

    const cacheKey = this.buildCacheKey(options);
    const cached = getCache(this.responseCache, cacheKey);
    if (cached) {
      structuredLog('info', ImageGenerator.SERVICE_NAME, 'Cache hit', { cacheKey });
      return cached;
    }

    const inflight = this.inflight.get(cacheKey);
    if (inflight) {
      structuredLog('info', ImageGenerator.SERVICE_NAME, 'Deduplicating request', { cacheKey });
      return inflight;
    }

    const startTime = Date.now();
    const promise = this.executeGeneration(options, cacheKey, startTime);

    this.inflight.set(cacheKey, promise);
    return promise.finally(() => {
      this.inflight.delete(cacheKey);
    });
  }

  private async executeGeneration(
    options: ImageGenerationOptions,
    cacheKey: string,
    startTime: number,
  ): Promise<GenerationResult> {
    try {
      const allowed = await this.limiter.waitForToken('flux-api', ImageGenerator.MAX_WAIT_MS);
      if (!allowed) {
        throw new Error('Rate limit wait exceeded');
      }

      const { width, height } = this.calculateDimensions(options);
      const payload = this.buildPayload(options, width, height);
      const endpoint = this.buildEndpoint(ImageGenerator.FORCED_MODEL);

      const submitStart = Date.now();
      const submitResponse = await this.retryRequest<{ data: SubmitResponse }>(() =>
        this.axios.post(endpoint, payload),
      );
      const submitDuration = Date.now() - submitStart;

      structuredLog('info', ImageGenerator.SERVICE_NAME, 'Image generation submitted', {
        endpoint,
        width,
        height,
        submitDurationMs: submitDuration,
      });

      const pollingUrl = submitResponse.data.polling_url;
      const cost = submitResponse.data.cost || 0;
      const inputMp = submitResponse.data.input_mp || 0;
      const outputMp = submitResponse.data.output_mp || 0;

      const pollStart = Date.now();
      const imageUrl = await this.pollForResult(pollingUrl);
      const pollDuration = Date.now() - pollStart;
      const totalDuration = Date.now() - startTime;

      const result: GenerationResult = {
        imageUrl,
        cost,
        inputMp,
        outputMp,
      };

      setCache(this.responseCache, cacheKey, result, ImageGenerator.CACHE_TTL_MS);

      structuredLog('info', ImageGenerator.SERVICE_NAME, 'Image generation completed', {
        cost,
        inputMp,
        outputMp,
        pollDurationMs: pollDuration,
        totalDurationMs: totalDuration,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorDetails: Record<string, unknown> = {
        model: ImageGenerator.FORCED_MODEL,
        aspectRatio: options.aspectRatio,
        durationMs: duration,
      };

      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as { response?: { status?: number; data?: unknown } };
        if (axiosError.response) {
          errorDetails.status = axiosError.response.status;
          if (axiosError.response.status !== 401 && axiosError.response.status !== 403) {
            errorDetails.responseData = axiosError.response.data;
          }
        }
      }

      structuredLog('error', ImageGenerator.SERVICE_NAME, 'Image generation failed', {
        error: errorMessage,
        ...errorDetails,
      });

      throw new Error(`Failed to generate image: ${errorMessage}`);
    }
  }

  async generateFeaturedImage(
    imagePrompt?: string,
    fallbackTitle?: string,
    fallbackKeywords?: readonly string[],
    options?: Partial<ImageGenerationOptions>,
  ): Promise<GenerationResult> {
    const prompt = imagePrompt || this.buildImagePrompt(fallbackTitle || '', fallbackKeywords || []);

    return this.generateImage({
      prompt,
      aspectRatio: ImageGenerator.DEFAULT_ASPECT_RATIO,
      ...options,
    });
  }

  private buildCacheKey(options: ImageGenerationOptions): string {
    const keyParts = [
      options.prompt,
      options.aspectRatio || ImageGenerator.DEFAULT_ASPECT_RATIO,
      options.width?.toString() || '',
      options.height?.toString() || '',
      options.seed?.toString() || '',
      options.safetyTolerance?.toString() || '',
      options.outputFormat || ImageGenerator.DEFAULT_OUTPUT_FORMAT,
      ImageGenerator.FORCED_MODEL,
    ];
    return `image:${hashString(keyParts.join('|'))}`;
  }

  private async pollForResult(pollingUrl: string): Promise<string> {
    let attempts = 0;
    const pollStart = Date.now();

    while (attempts < ImageGenerator.MAX_RETRIES) {
      try {
        const response = await this.retryRequest<{ data: PollResponse }>(() =>
          this.axios.get(pollingUrl),
        );
        const status = response.data.status;

        if (status === 'Ready') {
          const imageUrl = response.data.result?.sample;
          if (!imageUrl) {
            throw new Error('Image URL not found in response');
          }
          return imageUrl;
        }

        if (status === 'Failed') {
          const errorMessage = response.data.error || 'Generation failed';
          structuredLog('error', ImageGenerator.SERVICE_NAME, 'Image generation failed', {
            pollingUrl,
            error: errorMessage,
            attempts,
          });
          throw new Error(errorMessage);
        }

        if (status === 'Processing' || status === 'Pending') {
          await this.sleep(ImageGenerator.POLL_INTERVAL);
          attempts++;
        } else {
          throw new Error(`Unknown status: ${status}`);
        }
      } catch (error) {
        if (this.isNotFoundError(error)) {
          throw new Error('Task not found. It may have expired.');
        }
        if (attempts >= ImageGenerator.MAX_RETRIES - 1) {
          throw error;
        }
        await this.sleep(ImageGenerator.POLL_INTERVAL);
        attempts++;
      }
    }

    const pollDuration = Date.now() - pollStart;
    structuredLog('error', ImageGenerator.SERVICE_NAME, 'Image generation timed out', {
      pollingUrl,
      attempts,
      pollDurationMs: pollDuration,
    });
    throw new Error('Image generation timed out');
  }

  private buildPayload(
    options: ImageGenerationOptions,
    width: number,
    height: number,
  ): Readonly<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      prompt: options.prompt,
      width,
      height,
    };

    if (options.seed !== undefined) {
      payload.seed = options.seed;
    }

    if (options.safetyTolerance !== undefined) {
      payload.safety_tolerance = options.safetyTolerance;
    }

    if (options.outputFormat) {
      payload.output_format = options.outputFormat;
    }

    return payload;
  }

  private buildEndpoint(model: FluxModel): string {
    return `/v1/flux-2-${model}`;
  }

  private buildImagePrompt(title: string, keywords: readonly string[]): string {
    const mainKeyword = keywords[0] || title.split(' ')[0] || 'product';
    return `Professional blog featured image: ${mainKeyword}, modern clean design, shot on Sony A7IV, 85mm lens, f/2.8, natural lighting, sharp focus, vibrant colors, cinematic composition, high quality professional photography style`;
  }

  private calculateDimensions(options: ImageGenerationOptions): Dimensions {
    if (options.width && options.height) {
      return {
        width: this.roundToMultipleOf16(options.width),
        height: this.roundToMultipleOf16(options.height),
      };
    }

    const aspectRatio = options.aspectRatio || ImageGenerator.DEFAULT_ASPECT_RATIO;
    const dimensions = this.getDimensionsForAspectRatio(aspectRatio);

    if (dimensions.width > ImageGenerator.MAX_DIMENSION || dimensions.height > ImageGenerator.MAX_DIMENSION) {
      return this.scaleDimensions(dimensions);
    }

    return dimensions;
  }

  private getDimensionsForAspectRatio(aspectRatio: AspectRatio): Dimensions {
    return ImageGenerator.ASPECT_RATIO_DIMENSIONS[aspectRatio] || ImageGenerator.ASPECT_RATIO_DIMENSIONS[ImageGenerator.DEFAULT_ASPECT_RATIO];
  }

  private scaleDimensions(dimensions: Dimensions): Dimensions {
    const scale = Math.min(
      ImageGenerator.MAX_DIMENSION / dimensions.width,
      ImageGenerator.MAX_DIMENSION / dimensions.height,
    );
    return {
      width: this.roundToMultipleOf16(dimensions.width * scale),
      height: this.roundToMultipleOf16(dimensions.height * scale),
    };
  }

  private roundToMultipleOf16(value: number): number {
    return Math.round(value / ImageGenerator.DIMENSION_MULTIPLE) * ImageGenerator.DIMENSION_MULTIPLE;
  }

  private async retryRequest<T>(fn: () => Promise<T>): Promise<T> {
    return retry(fn, {
      ...ImageGenerator.DEFAULT_RETRY_OPTIONS,
      onRetry: (attempt, error) => {
        structuredLog('warn', ImageGenerator.SERVICE_NAME, 'Retrying request', {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isNotFoundError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'response' in error) {
      const axiosError = error as AxiosError;
      return axiosError.response?.status === ImageGenerator.NOT_FOUND_STATUS;
    }
    return false;
  }
}
