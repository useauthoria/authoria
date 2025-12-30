import axios, { AxiosInstance, AxiosError } from 'axios';
import { retry } from '../utils/error-handling.ts';

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

interface PollResponse {
  readonly status: 'Ready' | 'Failed' | 'Processing' | 'Pending';
  readonly result?: {
    readonly sample: string;
  };
  readonly error?: string;
}

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

interface RetryOptions {
  readonly maxAttempts: number;
  readonly initialDelay: number;
  readonly backoffMultiplier: number;
  readonly retryableErrors: readonly string[];
  readonly onRetry?: (attempt: number, error: unknown) => void;
}

export class ImageGenerator {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly axios: AxiosInstance;
  private static readonly BASE_URL = 'https://api.bfl.ai';
  private static readonly MAX_RETRIES = 60;
  private static readonly POLL_INTERVAL = 500;
  private static readonly DEFAULT_RETRY_OPTIONS: RetryOptions = {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffMultiplier: 2,
    retryableErrors: ['rate limit', 'timeout', 'network'],
  };
  private static readonly FORCED_MODEL: FluxModel = 'pro';
  private static readonly DIMENSION_MULTIPLE = 16;
  private static readonly MAX_DIMENSION = 2048;
  private static readonly DEFAULT_ASPECT_RATIO: AspectRatio = '16:9';
  private static readonly DEFAULT_OUTPUT_FORMAT = 'jpeg' as const;
  private static readonly NOT_FOUND_STATUS = 404;

  private static readonly ASPECT_RATIO_DIMENSIONS: Readonly<Record<AspectRatio, Dimensions>> = {
    '16:9': { width: 1360, height: 768 },
    '1:1': { width: 1024, height: 1024 },
    '9:16': { width: 1080, height: 1920 },
    '4:3': { width: 1280, height: 960 },
    '3:4': { width: 960, height: 1280 },
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = ImageGenerator.BASE_URL;
    this.axios = axios.create({
      baseURL: this.baseUrl,
      headers: {
        accept: 'application/json',
        'x-key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  async generateImage(options: ImageGenerationOptions): Promise<GenerationResult> {
    try {
      const { width, height } = this.calculateDimensions(options);
      const payload = this.buildPayload(options, width, height);
      const endpoint = this.buildEndpoint(ImageGenerator.FORCED_MODEL);

      const submitResponse = await this.retryRequest<{ data: SubmitResponse }>(() =>
        this.axios.post(endpoint, payload),
      );

      const pollingUrl = submitResponse.data.polling_url;
      const cost = submitResponse.data.cost || 0;
      const inputMp = submitResponse.data.input_mp || 0;
      const outputMp = submitResponse.data.output_mp || 0;

      const imageUrl = await this.pollForResult(pollingUrl);

      return {
        imageUrl,
        cost,
        inputMp,
        outputMp,
      };
    } catch (error) {
      // Enhanced error handling with more context
      const message = error instanceof Error ? error.message : 'Unknown error';
      const errorDetails: Record<string, unknown> = {
        message,
        model: ImageGenerator.FORCED_MODEL,
        aspectRatio: options.aspectRatio,
      };

      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as { response?: { status?: number; data?: unknown } };
        if (axiosError.response) {
          errorDetails.status = axiosError.response.status;
          errorDetails.responseData = axiosError.response.data;
        }
      }

      throw new Error(
        `Failed to generate image with FLUX API: ${message}. ` +
        `Details: ${JSON.stringify(errorDetails)}`,
      );
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

  private async pollForResult(pollingUrl: string): Promise<string> {
    let attempts = 0;

    while (attempts < ImageGenerator.MAX_RETRIES) {
      try {
        const response = await this.retryRequest<{ data: PollResponse }>(() =>
          this.axios.get(pollingUrl),
        );
        const status = response.data.status;

        if (status === 'Ready') {
          return response.data.result?.sample || '';
        }

        if (status === 'Failed') {
          throw new Error(response.data.error || 'Generation failed');
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
        throw error;
      }
    }

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
    const mainKeyword = keywords[0] || title.split(' ')[0];
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
    return retry(fn, ImageGenerator.DEFAULT_RETRY_OPTIONS);
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
