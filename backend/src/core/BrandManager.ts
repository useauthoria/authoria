import { ShopifyAPI } from '../integrations/ShopifyClient.ts';
import OpenAI from 'openai';
import { RateLimiter } from '../utils/rate-limiter.ts';
import { retry } from '../utils/error-handling.ts';

export interface AudiencePersona {
  readonly name: string;
  readonly type: 'primary' | 'secondary' | 'tertiary';
  readonly demographics: {
    readonly ageRange: string;
    readonly gender?: string;
    readonly location?: string;
    readonly income?: string;
    readonly education?: string;
  };
  readonly psychographics: {
    readonly interests: readonly string[];
    readonly values: readonly string[];
    readonly lifestyle: readonly string[];
    readonly motivations: readonly string[];
  };
  readonly painPoints: readonly string[];
  readonly buyingBehavior: {
    readonly preferredChannels: readonly string[];
    readonly decisionFactors: readonly string[];
    readonly priceSensitivity: 'low' | 'medium' | 'high';
    readonly frequency: string;
  };
  readonly contentPreferences: readonly string[];
}

export interface BrandDNA {
  readonly brandName: string;
  readonly brandValues: readonly string[];
  readonly targetAudiences: ReadonlyArray<AudiencePersona>;
  readonly productCategories: readonly string[];
  readonly priceRange: string;
  readonly toneKeywords: readonly string[];
  readonly messagingThemes: readonly string[];
  readonly uniqueSellingPoints: readonly string[];
  readonly brandMission?: string;
  readonly brandVision?: string;
  readonly brandPersonality?: readonly string[];
  readonly brandArchetype?: string;
}

export interface ToneMatrix {
  readonly [key: string]: number;
}

export interface BrandConsistencyScore {
  readonly overallScore: number;
  readonly voiceConsistency: number;
  readonly messagingConsistency: number;
  readonly toneConsistency: number;
  readonly inconsistencies: ReadonlyArray<{
    readonly type: 'voice' | 'messaging' | 'tone';
    readonly location: string;
    readonly description: string;
    readonly severity: 'low' | 'medium' | 'high';
  }>;
  readonly recommendations: readonly string[];
}

export interface BrandAnalysis {
  readonly brandDNA: BrandDNA;
  readonly toneMatrix: ToneMatrix;
  readonly consistencyScore?: BrandConsistencyScore;
}

export interface ToneAnalysisOptions {
  readonly customDimensions?: readonly string[];
  readonly industry?: string;
  readonly includeDefaultDimensions?: boolean;
}

export interface SafetyIssue {
  readonly type: string;
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly message: string;
  readonly location?: string;
  readonly recommendation?: string;
}

export interface SafetyCheck {
  readonly passed: boolean;
  readonly issues: ReadonlyArray<SafetyIssue>;
  readonly score: number;
  readonly recommendations: readonly string[];
  readonly checks: {
    readonly toneConsistency?: { readonly passed: boolean; readonly score: number };
    readonly duplicateContent?: { readonly passed: boolean; readonly similarity: number };
    readonly factChecking?: { readonly passed: boolean; readonly unverifiedClaims: number };
    readonly plagiarism?: { readonly passed: boolean; readonly similarityScore: number };
    readonly brandAlignment?: { readonly passed: boolean; readonly score: number };
    readonly legalCompliance?: { readonly passed: boolean; readonly risks: readonly string[] };
    readonly sentiment?: { readonly passed: boolean; readonly score: number; readonly emotionalTone: string };
    readonly bias?: { readonly passed: boolean; readonly detectedBias: readonly string[] };
    readonly seo?: { readonly passed: boolean; readonly score: number; readonly issues: readonly string[] };
    readonly structure?: { readonly passed: boolean; readonly issues: readonly string[] };
    readonly readability?: { readonly passed: boolean; readonly score: number };
    readonly forbiddenWords?: { readonly passed: boolean; readonly found: readonly string[] };
  };
}

export interface SafetyCheckOptions {
  readonly brandDNA?: BrandDNA;
  readonly toneMatrix?: ToneMatrix;
  readonly existingContent?: readonly string[];
  readonly checkForbiddenWords?: boolean;
  readonly checkTone?: boolean;
  readonly checkDuplicates?: boolean;
  readonly checkFacts?: boolean;
  readonly checkPlagiarism?: boolean;
  readonly checkBrandAlignment?: boolean;
  readonly checkLegal?: boolean;
  readonly checkSentiment?: boolean;
  readonly checkBias?: boolean;
  readonly checkSEO?: boolean;
  readonly checkStructure?: boolean;
  readonly strictMode?: boolean;
}

interface StoreAssets {
  readonly shop?: { readonly name?: string; readonly description?: string } | null;
  readonly products?: ReadonlyArray<{ readonly title?: string; readonly body_html?: string; readonly product_type?: string; readonly tags?: string }> | null;
  readonly collections?: ReadonlyArray<{ readonly body_html?: string; readonly title?: string }> | null;
  readonly pages?: ReadonlyArray<{ readonly body_html?: string; readonly title?: string }> | null;
  readonly blogArticles?: ReadonlyArray<{ readonly title?: string; readonly body_html?: string }> | null;
}

interface ContentItem {
  readonly type: 'product' | 'page' | 'article';
  readonly title: string;
  readonly content: string;
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
  readonly personas?: ReadonlyArray<AudiencePersona>;
}

interface ConsistencyResponse {
  readonly overallScore?: number;
  readonly voiceConsistency?: number;
  readonly messagingConsistency?: number;
  readonly toneConsistency?: number;
  readonly inconsistencies?: ReadonlyArray<{
    readonly type: string;
    readonly location: string;
    readonly description: string;
    readonly severity: string;
  }>;
  readonly recommendations?: readonly string[];
}

interface OpenAIResponse {
  readonly output_text?: string;
}

interface PromptConfig {
  readonly model: string;
  readonly reasoning: { readonly effort: 'low' | 'medium' | 'high' };
  readonly maxOutputTokens?: number;
  readonly responseFormat?: { readonly type: 'json_object' };
  readonly promptCacheKey: string;
  readonly promptCacheRetention: string;
}

interface CheckWeights {
  readonly toneConsistency: number;
  readonly duplicateContent: number;
  readonly factChecking: number;
  readonly plagiarism: number;
  readonly brandAlignment: number;
  readonly legalCompliance: number;
  readonly sentiment: number;
  readonly bias: number;
  readonly seo: number;
  readonly structure: number;
  readonly readability: number;
  readonly forbiddenWords: number;
}

interface SEOCheckResult {
  readonly score: number;
  readonly issues: readonly string[];
  readonly issuesList: ReadonlyArray<SafetyIssue>;
  readonly recommendations: readonly string[];
}

interface StructureCheckResult {
  readonly issues: ReadonlyArray<SafetyIssue>;
  readonly recommendations: readonly string[];
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

interface TextAnalysis {
  readonly wordCount: number;
  readonly sentences: readonly string[];
  readonly paragraphs: readonly string[];
}

type LogLevel = 'info' | 'warn' | 'error';

type InconsistencyType = 'voice' | 'messaging' | 'tone';
type SeverityLevel = 'low' | 'medium' | 'high';

interface ShopData {
  readonly name?: string;
  readonly description?: string;
}

interface ShopifyProduct {
  readonly title?: string;
  readonly body_html?: string;
  readonly product_type?: string;
  readonly tags?: string;
}

interface ShopifyCollection {
  readonly body_html?: string;
  readonly title?: string;
}

interface ShopifyPage {
  readonly body_html?: string;
  readonly title?: string;
}

interface ShopifyBlogArticle {
  readonly title?: string;
  readonly body_html?: string;
}

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

const countSyllables = (word: string): number => {
  const normalized = word.toLowerCase().replace(/[^a-z]/g, '');
  if (normalized.length <= 3) return 1;

  let processed = normalized.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  processed = processed.replace(/^y/, '');
  const matches = processed.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 1;
};

const extractTextContent = (content: string): string => {
  return content.replace(/<[^>]*>/g, ' ');
};

const analyzeTextStructure = (textContent: string): TextAnalysis => {
  const words = textContent.split(/\s+/).filter((w) => w.length > 0);
  const sentences = textContent.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const paragraphs = textContent.split(/\n\n+/).filter((p) => p.trim().length > 0);

  return {
    wordCount: words.length,
    sentences,
    paragraphs,
  };
};

const calculateReadability = (content: string): number => {
  const textContent = extractTextContent(content);
  const sentences = textContent.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const words = textContent.split(/\s+/).filter((w) => w.length > 0);
  const syllables = words.reduce((sum, word) => sum + countSyllables(word), 0);

  if (sentences.length === 0 || words.length === 0) return 0;

  const avgSentenceLength = words.length / sentences.length;
  const avgSyllablesPerWord = syllables / words.length;
  const score = 206.835 - 1.015 * avgSentenceLength - 84.6 * avgSyllablesPerWord;

  return Math.max(0, Math.min(100, score));
};

const truncateText = (text: string, maxLength: number): string => {
  return text.length > maxLength ? text.substring(0, maxLength) : text;
};

const isInconsistencyType = (type: string): type is InconsistencyType => {
  return type === 'voice' || type === 'messaging' || type === 'tone';
};

const isSeverityLevel = (severity: string): severity is SeverityLevel => {
  return severity === 'low' || severity === 'medium' || severity === 'high';
};

const parseJSONResponse = <T>(text: string | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const extractShopData = (shop: unknown): ShopData | undefined => {
  if (!shop || typeof shop !== 'object') return undefined;
  const s = shop as Record<string, unknown>;
  return {
    name: typeof s.name === 'string' ? s.name : undefined,
    description: typeof s.description === 'string' ? s.description : undefined,
  };
};

const extractProducts = (products: unknown): ReadonlyArray<ShopifyProduct> => {
  if (!Array.isArray(products)) return [];
  return products.filter((p): p is ShopifyProduct => 
    p !== null && typeof p === 'object'
  );
};

const extractCollections = (collections: unknown): ReadonlyArray<ShopifyCollection> => {
  if (!Array.isArray(collections)) return [];
  return collections.filter((c): c is ShopifyCollection => 
    c !== null && typeof c === 'object'
  );
};

const extractPages = (pages: unknown): ReadonlyArray<ShopifyPage> => {
  if (!Array.isArray(pages)) return [];
  return pages.filter((p): p is ShopifyPage => 
    p !== null && typeof p === 'object'
  );
};

const extractBlogArticles = (articles: unknown): ReadonlyArray<ShopifyBlogArticle> => {
  if (!Array.isArray(articles)) return [];
  return articles.filter((a): a is ShopifyBlogArticle => 
    a !== null && typeof a === 'object'
  );
};

export class BrandIntelligence {
  private readonly shopifyAPI: ShopifyAPI;
  private readonly openai: OpenAI;
  private readonly limiter: RateLimiter;
  private readonly responseCache: Map<string, CacheEntry<OpenAIResponse>>;
  private readonly inflight: Map<string, Promise<OpenAIResponse>>;
  private cacheCleanupInterval?: number;

  private static readonly DEFAULT_TONE_DIMENSIONS: readonly string[] = [
    'expert',
    'conversational',
    'aspirational',
    'friendly',
    'professional',
    'casual',
    'authoritative',
    'empathetic',
  ] as const;

  private static readonly MAX_TEXT_LENGTH = 50000;
  private static readonly MAX_PERSONA_TEXT_LENGTH = 40000;
  private static readonly MAX_CONTENT_ITEMS = 50;
  private static readonly CONTENT_PREVIEW_LENGTH = 200;
  private static readonly MIN_WORD_LENGTH = 4;
  private static readonly MAX_PERSONAS = 3;
  private static readonly DEFAULT_CONSISTENCY_SCORE = 75;
  private static readonly OPENAI_CACHE_TTL_MS = 10 * 60 * 1000;
  private static readonly OPENAI_MAX_WAIT_MS = 60_000;
  private static readonly CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly SERVICE_NAME = 'BrandIntelligence';

  private static readonly INDUSTRY_TONE_MAP: Readonly<Record<string, readonly string[]>> = {
    fashion: ['trendy', 'sophisticated', 'elegant', 'bold'],
    technology: ['innovative', 'cutting-edge', 'precise', 'forward-thinking'],
    healthcare: ['compassionate', 'trustworthy', 'empathetic', 'professional'],
    finance: ['trustworthy', 'authoritative', 'precise', 'reliable'],
    food: ['warm', 'inviting', 'authentic', 'passionate'],
    beauty: ['aspirational', 'glamorous', 'confident', 'transformative'],
    fitness: ['motivational', 'energetic', 'empowering', 'determined'],
    education: ['inspiring', 'clear', 'supportive', 'knowledgeable'],
    luxury: ['exclusive', 'refined', 'sophisticated', 'prestigious'],
    b2b: ['professional', 'authoritative', 'solution-focused', 'trustworthy'],
  } as const;

  private static readonly COMMON_THEMES: readonly string[] = [
    'quality',
    'sustainable',
    'premium',
    'affordable',
    'innovative',
  ] as const;

  private static readonly DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffMultiplier: 2,
    retryableErrors: ['rate limit', 'timeout', 'server_error'] as const,
  } as const;

  constructor(shopifyAPI: ShopifyAPI, openaiApiKey: string) {
    this.shopifyAPI = shopifyAPI;
    this.openai = new OpenAI({ apiKey: openaiApiKey });
    this.limiter = new RateLimiter({
      maxRequests: 10,
      windowMs: 1000,
      burst: 2,
      algorithm: 'token-bucket',
      keyPrefix: 'openai-brand',
      concurrency: 10,
    });
    this.responseCache = new Map();
    this.inflight = new Map();
    this.startCacheCleanup();
  }

  private startCacheCleanup(): void {
    if (typeof globalThis !== 'undefined' && 'setInterval' in globalThis) {
      this.cacheCleanupInterval = setInterval(() => {
        cleanupExpiredCache(this.responseCache);
      }, BrandIntelligence.CACHE_CLEANUP_INTERVAL_MS) as unknown as number;
    }
  }

  destroy(): void {
    if (this.cacheCleanupInterval !== undefined && typeof globalThis !== 'undefined' && 'clearInterval' in globalThis) {
      clearInterval(this.cacheCleanupInterval);
    }
    this.responseCache.clear();
    this.inflight.clear();
  }

  async analyzeBrand(
    shopDomain: string,
    accessToken: string,
    textSamples?: readonly string[],
    toneOptions?: ToneAnalysisOptions,
  ): Promise<BrandAnalysis> {
    const brandDNAPromise = this.scanStore(shopDomain, accessToken);
    const textSamplesPromise = textSamples && textSamples.length > 0
      ? Promise.resolve(textSamples)
      : this.extractTextSamples(shopDomain, accessToken);

    const [brandDNA, finalTextSamples] = await Promise.all([brandDNAPromise, textSamplesPromise]);
    const [toneMatrix, consistencyScore] = await Promise.all([
      this.analyzeTone(finalTextSamples, toneOptions),
      this.calculateConsistencyScore(shopDomain, accessToken, brandDNA, finalTextSamples),
    ]);

    return {
      brandDNA,
      toneMatrix,
      consistencyScore,
    };
  }

  async scanStore(shopDomain: string, accessToken: string): Promise<BrandDNA> {
    const [shop, products, collections, pages, blogArticles] = await Promise.all([
      this.shopifyAPI.getShop(shopDomain, accessToken),
      this.shopifyAPI.getProducts(shopDomain, accessToken),
      this.shopifyAPI.getCollections(shopDomain, accessToken),
      this.shopifyAPI.getPages(shopDomain, accessToken),
      this.shopifyAPI.getBlogArticles(shopDomain, accessToken),
    ]);

    const shopData = extractShopData(shop);
    const productsArray = extractProducts(products);
    const collectionsArray = extractCollections(collections);
    const pagesArray = extractPages(pages);
    const articlesArray = extractBlogArticles(blogArticles);

    const assets: StoreAssets = {
      shop: shopData,
      products: productsArray,
      collections: collectionsArray,
      pages: pagesArray,
      blogArticles: articlesArray,
    };

    const textAssets = this.extractTextAssets(assets);
    const [brandDNA, personas] = await Promise.all([
      this.analyzeBrandDNA(textAssets, shopData),
      this.generateAudiencePersonas(textAssets, textAssets),
    ]);

    return {
      ...brandDNA,
      targetAudiences: personas,
    };
  }

  async analyzeTone(
    textSamples: readonly string[],
    options?: ToneAnalysisOptions,
  ): Promise<ToneMatrix> {
    const combinedText = textSamples.join('\n\n');
    const dimensionsToAnalyze = this.buildToneDimensions(options);
    const staticPrefix = this.buildToneAnalysisStaticPrefix(dimensionsToAnalyze, options?.industry);
    const variableContent = truncateText(combinedText, BrandIntelligence.MAX_TEXT_LENGTH);
    const prompt = staticPrefix + variableContent;

    try {
      const response = await this.callOpenAI({
        model: 'gpt-5-mini',
        reasoning: { effort: 'medium' },
        responseFormat: { type: 'json_object' },
        promptCacheKey: `tone-analysis-${options?.industry || 'default'}`,
        promptCacheRetention: '24h',
      }, prompt);

      const result = parseJSONResponse<ToneAnalysisResponse>(response.output_text, {});
      return this.normalizeToneMatrix(result, dimensionsToAnalyze);
    } catch (error) {
      structuredLog('error', BrandIntelligence.SERVICE_NAME, 'Tone analysis failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.getDefaultToneMatrix(dimensionsToAnalyze);
    }
  }

  private extractTextAssets(assets: StoreAssets): string {
    const texts: string[] = [];

    if (assets.shop?.description) {
      texts.push(assets.shop.description);
    }

    assets.products?.forEach((product) => {
      if (product.title) texts.push(product.title);
      if (product.body_html) texts.push(product.body_html);
      if (product.product_type) texts.push(product.product_type);
      if (product.tags) texts.push(product.tags);
    });

    assets.collections?.forEach((collection) => {
      if (collection.body_html) texts.push(collection.body_html);
      if (collection.title) texts.push(collection.title);
    });

    assets.pages?.forEach((page) => {
      if (page.body_html) texts.push(page.body_html);
      if (page.title) texts.push(page.title);
    });

    assets.blogArticles?.forEach((article) => {
      if (article.title) texts.push(article.title);
      if (article.body_html) texts.push(article.body_html);
    });

    return texts.join(' ');
  }

  private async extractTextSamples(shopDomain: string, accessToken: string): Promise<readonly string[]> {
    const products = await this.shopifyAPI.getProducts(shopDomain, accessToken);
    const productsArray = extractProducts(products);
    return productsArray
      .map((p) => `${p.title || ''} ${p.body_html || ''}`.trim())
      .filter((text) => text.length > 0)
      .slice(0, 50);
  }

  private async analyzeBrandDNA(textAssets: string, shopData?: ShopData): Promise<BrandDNA> {
    const staticPrefix = this.buildBrandDNAStaticPrefix();
    const variableContent = truncateText(textAssets, BrandIntelligence.MAX_TEXT_LENGTH);
    const prompt = staticPrefix + variableContent;

    try {
      const response = await this.callOpenAI({
        model: 'gpt-5-mini',
        reasoning: { effort: 'high' },
        responseFormat: { type: 'json_object' },
        promptCacheKey: 'brand-dna-extraction',
        promptCacheRetention: '24h',
      }, prompt);

      const result = parseJSONResponse<BrandDNAResponse>(response.output_text, {});
      const brandName = shopData?.name || result.brandName || 'Store Brand';

      return {
        brandName,
        brandValues: result.brandValues || [],
        targetAudiences: [],
        productCategories: result.productCategories || [],
        priceRange: result.priceRange || 'medium',
        toneKeywords: result.toneKeywords || [],
        messagingThemes: result.messagingThemes || [],
        uniqueSellingPoints: result.uniqueSellingPoints || [],
        brandMission: result.brandMission,
        brandVision: result.brandVision,
        brandPersonality: result.brandPersonality,
        brandArchetype: result.brandArchetype,
      };
    } catch (error) {
      structuredLog('error', BrandIntelligence.SERVICE_NAME, 'Brand DNA analysis failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.fallbackBrandDNAExtraction(textAssets, shopData);
    }
  }

  private fallbackBrandDNAExtraction(textAssets: string, shopData?: ShopData): BrandDNA {
    const words = textAssets.toLowerCase().split(/\s+/);
    const wordFreq = this.calculateWordFrequency(words);
    const themes = this.extractThemes(textAssets);
    const categories = this.extractCategories(textAssets);

    return {
      brandName: shopData?.name || 'Store Brand',
      brandValues: themes.slice(0, 5),
      targetAudiences: [],
      productCategories: categories,
      priceRange: this.inferPriceRange(textAssets),
      toneKeywords: Object.keys(wordFreq).slice(0, 10),
      messagingThemes: themes,
      uniqueSellingPoints: this.extractUSPs(textAssets),
    };
  }

  private calculateWordFrequency(words: readonly string[]): Readonly<Record<string, number>> {
    const freq: Record<string, number> = {};
    words.forEach((word) => {
      if (word.length > BrandIntelligence.MIN_WORD_LENGTH) {
        freq[word] = (freq[word] || 0) + 1;
      }
    });
    return freq;
  }

  private extractThemes(text: string): readonly string[] {
    return BrandIntelligence.COMMON_THEMES.filter((theme) =>
      text.toLowerCase().includes(theme),
    );
  }

  private extractCategories(_text: string): readonly string[] {
    return ['Electronics', 'Fashion', 'Home'];
  }

  private inferPriceRange(text: string): string {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('luxury') || lowerText.includes('premium')) return 'high';
    if (lowerText.includes('budget') || lowerText.includes('affordable')) return 'low';
    return 'medium';
  }

  private extractUSPs(_text: string): readonly string[] {
    return ['Quality products', 'Fast shipping', 'Great customer service'];
  }

  private buildToneDimensions(options?: ToneAnalysisOptions): readonly string[] {
    let dimensions: string[] = [];

    if (options?.includeDefaultDimensions !== false) {
      dimensions = [...BrandIntelligence.DEFAULT_TONE_DIMENSIONS];
    }

    if (options?.customDimensions && options.customDimensions.length > 0) {
      dimensions = [...dimensions, ...options.customDimensions];
    }

    if (options?.industry) {
      const industryDimensions = this.getIndustryToneDimensions(options.industry);
      dimensions = [...dimensions, ...industryDimensions];
    }

    return [...new Set(dimensions)];
  }

  private getIndustryToneDimensions(industry: string): readonly string[] {
    return BrandIntelligence.INDUSTRY_TONE_MAP[industry.toLowerCase()] || [];
  }

  private buildToneAnalysisStaticPrefix(dimensions: readonly string[], industry?: string): string {
    let prefix = `You are a tone analysis expert. Return only valid JSON with tone weights.
Analyze the tone of the following brand content and return a weighted tone matrix.
Consider these tone dimensions: ${dimensions.join(', ')}.
Return a JSON object with values between 0 and 1 that sum to approximately 1.0.
Each dimension should be a key in the JSON object with its weight as the value.

`;

    if (industry) {
      prefix += `Industry context: ${industry}. Consider industry-specific tone expectations.\n\n`;
    }

    return prefix + 'Content: ';
  }

  private normalizeToneMatrix(matrix: ToneAnalysisResponse, expectedDimensions: readonly string[]): ToneMatrix {
    const normalizedMatrix: Record<string, number> = {};

    expectedDimensions.forEach((dim) => {
      normalizedMatrix[dim] = 0;
    });

    Object.keys(matrix).forEach((key) => {
      const value = matrix[key];
      if (typeof value === 'number') {
        normalizedMatrix[key] = value;
      }
    });

    const total = Object.values(normalizedMatrix).reduce((sum, val) => sum + val, 0);

    if (total === 0) {
      const equalWeight = 1 / expectedDimensions.length;
      expectedDimensions.forEach((dim) => {
        normalizedMatrix[dim] = equalWeight;
      });
      return normalizedMatrix;
    }

    Object.keys(normalizedMatrix).forEach((key) => {
      normalizedMatrix[key] = normalizedMatrix[key] / total;
    });

    return normalizedMatrix;
  }

  private getDefaultToneMatrix(dimensions: readonly string[]): ToneMatrix {
    const matrix: Record<string, number> = {};
    const equalWeight = 1 / dimensions.length;
    dimensions.forEach((dim) => {
      matrix[dim] = equalWeight;
    });
    return matrix;
  }

  private async generateAudiencePersonas(
    textAssets: string,
    brandDNAText: string,
  ): Promise<ReadonlyArray<AudiencePersona>> {
    const staticPrefix = this.buildPersonaStaticPrefix(brandDNAText);
    const variableContent = truncateText(textAssets, BrandIntelligence.MAX_PERSONA_TEXT_LENGTH);
    const prompt = staticPrefix + variableContent;

    try {
      const response = await this.callOpenAI({
        model: 'gpt-5-mini',
        reasoning: { effort: 'high' },
        responseFormat: { type: 'json_object' },
        promptCacheKey: 'audience-persona-generation',
        promptCacheRetention: '24h',
      }, prompt);

      const result = parseJSONResponse<PersonaResponse>(response.output_text, { personas: [] });
      const personas = result.personas || [];

      if (Array.isArray(personas) && personas.length > 0) {
        return personas.slice(0, BrandIntelligence.MAX_PERSONAS);
      }

      return [this.createFallbackPersona()];
    } catch (error) {
      structuredLog('error', BrandIntelligence.SERVICE_NAME, 'Persona generation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [this.createFallbackPersona()];
    }
  }

  private buildPersonaStaticPrefix(brandContext: string): string {
    const contextSummary = truncateText(brandContext, 500);
    return `You are a brand intelligence expert specializing in audience analysis.
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
Brand context: ${contextSummary}

Content to analyze: `;
  }

  private createFallbackPersona(): AudiencePersona {
    return {
      name: 'Primary Customer',
      type: 'primary',
      demographics: {
        ageRange: '25-45',
      },
      psychographics: {
        interests: [],
        values: [],
        lifestyle: [],
        motivations: [],
      },
      painPoints: [],
      buyingBehavior: {
        preferredChannels: ['online'],
        decisionFactors: [],
        priceSensitivity: 'medium',
        frequency: 'monthly',
      },
      contentPreferences: [],
    };
  }

  private async calculateConsistencyScore(
    shopDomain: string,
    accessToken: string,
    brandDNA: BrandDNA,
    textSamples: readonly string[],
  ): Promise<BrandConsistencyScore> {
    const [products, pages, blogArticles] = await Promise.all([
      this.shopifyAPI.getProducts(shopDomain, accessToken),
      this.shopifyAPI.getPages(shopDomain, accessToken),
      this.shopifyAPI.getBlogArticles(shopDomain, accessToken),
    ]);

    const productsArray = extractProducts(products);
    const pagesArray = extractPages(pages);
    const articlesArray = extractBlogArticles(blogArticles);

    const allContent = this.buildContentItems(productsArray, pagesArray, articlesArray);
    const toneMatrix = await this.analyzeTone(textSamples);
    const staticPrefix = this.buildConsistencyStaticPrefix(brandDNA, toneMatrix);
    const contentSummary = this.buildContentSummary(allContent);
    const prompt = staticPrefix + contentSummary;

    try {
      const response = await this.callOpenAI({
        model: 'gpt-5-mini',
        reasoning: { effort: 'medium' },
        responseFormat: { type: 'json_object' },
        promptCacheKey: 'brand-consistency-analysis',
        promptCacheRetention: '24h',
      }, prompt);

      const result = parseJSONResponse<ConsistencyResponse>(response.output_text, {});

      return {
        overallScore: result.overallScore ?? BrandIntelligence.DEFAULT_CONSISTENCY_SCORE,
        voiceConsistency: result.voiceConsistency ?? BrandIntelligence.DEFAULT_CONSISTENCY_SCORE,
        messagingConsistency: result.messagingConsistency ?? BrandIntelligence.DEFAULT_CONSISTENCY_SCORE,
        toneConsistency: result.toneConsistency ?? BrandIntelligence.DEFAULT_CONSISTENCY_SCORE,
        inconsistencies: this.mapInconsistencies(result.inconsistencies),
        recommendations: result.recommendations || [],
      };
    } catch (error) {
      structuredLog('error', BrandIntelligence.SERVICE_NAME, 'Consistency check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.createDefaultConsistencyScore();
    }
  }

  private buildContentItems(
    products: ReadonlyArray<ShopifyProduct>,
    pages: ReadonlyArray<ShopifyPage>,
    blogArticles: ReadonlyArray<ShopifyBlogArticle>,
  ): ReadonlyArray<ContentItem> {
    const productItems: ContentItem[] = products.map((p) => ({
      type: 'product' as const,
      title: p.title || '',
      content: p.body_html || '',
    }));

    const pageItems: ContentItem[] = pages.map((p) => ({
      type: 'page' as const,
      title: p.title || '',
      content: p.body_html || '',
    }));

    const articleItems: ContentItem[] = blogArticles.map((a) => ({
      type: 'article' as const,
      title: a.title || '',
      content: a.body_html || '',
    }));

    return [...productItems, ...pageItems, ...articleItems];
  }

  private buildContentSummary(content: ReadonlyArray<ContentItem>): string {
    return content
      .slice(0, BrandIntelligence.MAX_CONTENT_ITEMS)
      .map((c) => `[${c.type}] ${c.title}: ${truncateText(c.content, BrandIntelligence.CONTENT_PREVIEW_LENGTH)}`)
      .join('\n\n');
  }

  private buildConsistencyStaticPrefix(brandDNA: BrandDNA, toneMatrix: ToneMatrix): string {
    return `You are a brand consistency expert. Analyze the brand content for consistency.
Brand DNA:
- Brand Values: ${brandDNA.brandValues.join(', ')}
- Messaging Themes: ${brandDNA.messagingThemes.join(', ')}
- Tone Matrix: ${JSON.stringify(toneMatrix)}

Analyze the following content pieces and identify inconsistencies.
Return a JSON object with:
{
  "overallScore": 0-100,
  "voiceConsistency": 0-100,
  "messagingConsistency": 0-100,
  "toneConsistency": 0-100,
  "inconsistencies": [
    {
      "type": "voice|messaging|tone",
      "location": "content piece identifier",
      "description": "description of inconsistency",
      "severity": "low|medium|high"
    }
  ],
  "recommendations": ["array of improvement recommendations"]
}

Content to analyze: `;
  }

  private mapInconsistencies(
    inconsistencies?: ReadonlyArray<{
      readonly type: string;
      readonly location: string;
      readonly description: string;
      readonly severity: string;
    }>,
  ): ReadonlyArray<{
    readonly type: InconsistencyType;
    readonly location: string;
    readonly description: string;
    readonly severity: SeverityLevel;
  }> {
    if (!inconsistencies) return [];

    return inconsistencies
      .filter((inc) => isInconsistencyType(inc.type))
      .filter((inc) => isSeverityLevel(inc.severity))
      .map((inc) => ({
        type: inc.type as InconsistencyType,
        location: inc.location,
        description: inc.description,
        severity: inc.severity as SeverityLevel,
      }));
  }

  private createDefaultConsistencyScore(): BrandConsistencyScore {
    return {
      overallScore: BrandIntelligence.DEFAULT_CONSISTENCY_SCORE,
      voiceConsistency: BrandIntelligence.DEFAULT_CONSISTENCY_SCORE,
      messagingConsistency: BrandIntelligence.DEFAULT_CONSISTENCY_SCORE,
      toneConsistency: BrandIntelligence.DEFAULT_CONSISTENCY_SCORE,
      inconsistencies: [],
      recommendations: ['Unable to calculate detailed consistency score. Review content manually.'],
    };
  }

  private buildBrandDNAStaticPrefix(): string {
    return `You are a brand intelligence expert. Analyze the following brand content and extract comprehensive brand DNA.
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

Content to analyze: `;
  }

  private async callOpenAI(config: PromptConfig, input: string): Promise<OpenAIResponse> {
    const normalizedInput = truncateText(input, BrandIntelligence.MAX_TEXT_LENGTH);
    const cacheKey = `${config.model}:${config.promptCacheKey}:${hashString(normalizedInput)}`;
    const cached = getCache(this.responseCache, cacheKey);
    if (cached) {
      return cached;
    }

    const inflight = this.inflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const promise = (async (): Promise<OpenAIResponse> => {
      const allowed = await this.limiter.waitForToken(config.model, BrandIntelligence.OPENAI_MAX_WAIT_MS);
      if (!allowed) {
        throw new Error('OpenAI rate limit wait exceeded');
      }

      const start = nowMs();
      const result = await retry(
        async () => {
          const requestBody = {
            model: config.model,
            reasoning: config.reasoning,
            messages: [{ role: 'user' as const, content: normalizedInput }],
            max_tokens: config.maxOutputTokens,
            response_format: config.responseFormat,
          };

          const response = await this.openai.responses.create(requestBody);
          return { output_text: (response as { output_text?: string }).output_text } as OpenAIResponse;
        },
        {
          ...BrandIntelligence.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, error) => {
            structuredLog('warn', BrandIntelligence.SERVICE_NAME, 'OpenAI retry', {
              attempt,
              model: config.model,
              promptCacheKey: config.promptCacheKey,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        },
      );

      setCache(this.responseCache, cacheKey, result, BrandIntelligence.OPENAI_CACHE_TTL_MS);
      structuredLog('info', BrandIntelligence.SERVICE_NAME, 'OpenAI call ok', {
        model: config.model,
        promptCacheKey: config.promptCacheKey,
        latencyMs: nowMs() - start,
      });
      return result;
    })().catch((error) => {
      structuredLog('error', BrandIntelligence.SERVICE_NAME, 'OpenAI call failed', {
        model: config.model,
        promptCacheKey: config.promptCacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }).finally(() => {
      this.inflight.delete(cacheKey);
    });

    this.inflight.set(cacheKey, promise);
    return promise;
  }
}

export class BrandSafety {
  private readonly openai: OpenAI;
  private readonly forbiddenWords: Set<string>;
  private readonly brandDNA?: BrandDNA;
  private readonly toneMatrix?: ToneMatrix;
  private readonly limiter: RateLimiter;
  private readonly responseCache: Map<string, CacheEntry<unknown>>;

  private static readonly CHECK_WEIGHTS: CheckWeights = {
    toneConsistency: 10,
    duplicateContent: 15,
    factChecking: 15,
    plagiarism: 20,
    brandAlignment: 10,
    legalCompliance: 15,
    sentiment: 5,
    bias: 10,
    seo: 5,
    structure: 5,
    readability: 5,
    forbiddenWords: 10,
  } as const;

  private static readonly MIN_READABILITY_SCORE = 60;
  private static readonly MIN_SEO_SCORE = 70;
  private static readonly MIN_PASSING_SCORE = 70;
  private static readonly MAX_SENTENCE_LENGTH = 20;
  private static readonly MIN_WORD_COUNT = 300;
  private static readonly MAX_PARAGRAPH_LENGTH = 150;
  private static readonly OPENAI_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly SERVICE_NAME = 'BrandSafety';

  constructor(
    apiKey: string,
    options?: {
      readonly forbiddenWords?: readonly string[];
      readonly brandDNA?: BrandDNA;
      readonly toneMatrix?: ToneMatrix;
    },
  ) {
    this.openai = new OpenAI({ apiKey });
    this.forbiddenWords = new Set(
      options?.forbiddenWords?.map((word) => word.toLowerCase()) || [],
    );
    this.brandDNA = options?.brandDNA;
    this.toneMatrix = options?.toneMatrix;
    this.limiter = new RateLimiter({
      maxRequests: 5,
      windowMs: 1000,
      burst: 1,
      algorithm: 'token-bucket',
      keyPrefix: 'openai-safety',
      concurrency: 5,
    });
    this.responseCache = new Map();
  }

  async checkContent(
    content: string,
    options?: SafetyCheckOptions,
  ): Promise<SafetyCheck> {
    const defaultOptions = this.buildDefaultOptions(options);
    const allIssues: SafetyIssue[] = [];
    const recommendations: string[] = [];
    const checkResults: SafetyCheck['checks'] = {};
    let totalScore = 100;

    const seoPromise = defaultOptions.checkSEO
      ? this.checkSEOQuality(content)
      : Promise.resolve(null);

    const structurePromise = defaultOptions.checkStructure
      ? Promise.resolve(this.checkContentStructure(content))
      : Promise.resolve(null);

    const [seoCheck, structureCheck] = await Promise.all([seoPromise, structurePromise]);

    if (seoCheck) {
      checkResults.seo = {
        passed: seoCheck.score >= BrandSafety.MIN_SEO_SCORE,
        score: seoCheck.score,
        issues: seoCheck.issues,
      };
      if (seoCheck.score < BrandSafety.MIN_SEO_SCORE) {
        allIssues.push(...seoCheck.issuesList);
        totalScore -= BrandSafety.CHECK_WEIGHTS.seo * (1 - seoCheck.score / 100);
        recommendations.push(...seoCheck.recommendations);
      }
    }

    if (structureCheck) {
      checkResults.structure = {
        passed: structureCheck.issues.length === 0,
        issues: structureCheck.issues.map((i) => i.message),
      };
      if (structureCheck.issues.length > 0) {
        allIssues.push(...structureCheck.issues);
        totalScore -= BrandSafety.CHECK_WEIGHTS.structure * (structureCheck.issues.length / 5);
        recommendations.push(...structureCheck.recommendations);
      }
    }

    const readability = calculateReadability(content);
    checkResults.readability = {
      passed: readability >= BrandSafety.MIN_READABILITY_SCORE,
      score: readability,
    };
    if (readability < BrandSafety.MIN_READABILITY_SCORE) {
      allIssues.push({
        type: 'readability',
        severity: readability < 40 ? 'high' : 'medium',
        message: `Content readability score is ${readability.toFixed(1)}. Target: ${BrandSafety.MIN_READABILITY_SCORE}+`,
        recommendation: 'Simplify sentence structure, use shorter words, and break up long paragraphs.',
      });
      totalScore -= BrandSafety.CHECK_WEIGHTS.readability * (1 - readability / 100);
      recommendations.push('Improve readability by using shorter sentences and simpler words.');
    }

    const passed = this.determinePassed(allIssues, totalScore, defaultOptions.strictMode);
    const uniqueRecommendations = [...new Set(recommendations)];

    return {
      passed,
      issues: allIssues,
      score: Math.max(0, Math.min(100, Math.round(totalScore))),
      recommendations: uniqueRecommendations,
      checks: checkResults,
    };
  }

  private async checkSEOQuality(content: string): Promise<SEOCheckResult> {
    const issues: string[] = [];
    const issuesList: SafetyIssue[] = [];
    let score = 100;

    const textContent = extractTextContent(content);
    const analysis = analyzeTextStructure(textContent);

    if (analysis.wordCount < BrandSafety.MIN_WORD_COUNT) {
      issues.push('Content is too short for SEO (minimum 300 words recommended)');
      issuesList.push({
        type: 'seoWordCount',
        severity: 'medium',
        message: 'Content word count is below SEO best practices',
        recommendation: 'Expand content to at least 300-500 words for better SEO.',
      });
      score -= 10;
    }

    const headingIssues = this.checkHeadingStructure(content);
    issues.push(...headingIssues.issues);
    issuesList.push(...headingIssues.issuesList);
    score -= headingIssues.scorePenalty;

    const paragraphIssues = this.checkParagraphLength(analysis.paragraphs);
    if (paragraphIssues.length > 0) {
      issues.push('Some paragraphs are too long (max 150 words recommended)');
      issuesList.push(...paragraphIssues);
      score -= 5;
    }

    const sentenceIssues = this.checkSentenceLength(analysis.wordCount, analysis.sentences.length);
    if (sentenceIssues) {
      issues.push('Average sentence length is too long (recommend 15-20 words)');
      issuesList.push(sentenceIssues);
      score -= 5;
    }

    const recommendations = [
      'Include target keywords naturally throughout content.',
      'Use descriptive meta descriptions.',
      'Add internal and external links where appropriate.',
      'Optimize images with alt text.',
      'Use schema markup for structured data.',
    ];

    return { score, issues, issuesList, recommendations };
  }

  private checkContentStructure(content: string): StructureCheckResult {
    const issues: SafetyIssue[] = [];
    const recommendations: string[] = [];

    const headingIssues = this.validateHeadingHierarchy(content);
    issues.push(...headingIssues);

    const listIssues = this.checkListPresence(content);
    if (listIssues) {
      issues.push(listIssues);
    }

    const imageIssues = this.checkImageAltText(content);
    issues.push(...imageIssues);

    const linkIssues = this.checkLinkPresence(content);
    if (linkIssues) {
      issues.push(linkIssues);
    }

    if (issues.length === 0) {
      recommendations.push('Content structure is well-organized.');
    }

    return { issues, recommendations };
  }

  private buildDefaultOptions(
    options?: SafetyCheckOptions,
  ): Required<Omit<SafetyCheckOptions, 'brandDNA' | 'toneMatrix' | 'existingContent'>> & Pick<SafetyCheckOptions, 'brandDNA' | 'toneMatrix' | 'existingContent'> {
    return {
      checkForbiddenWords: false,
      checkTone: false,
      checkDuplicates: false,
      checkFacts: false,
      checkPlagiarism: false,
      checkBrandAlignment: false,
      checkLegal: false,
      checkSentiment: false,
      checkBias: false,
      checkSEO: true,
      checkStructure: true,
      strictMode: false,
      ...options,
    };
  }

  private determinePassed(
    issues: ReadonlyArray<SafetyIssue>,
    totalScore: number,
    strictMode?: boolean,
  ): boolean {
    if (strictMode) {
      return issues.filter((i) => i.severity === 'critical' || i.severity === 'high').length === 0;
    }
    return totalScore >= BrandSafety.MIN_PASSING_SCORE && issues.filter((i) => i.severity === 'critical').length === 0;
  }

  private checkHeadingStructure(content: string): {
    readonly issues: readonly string[];
    readonly issuesList: ReadonlyArray<SafetyIssue>;
    readonly scorePenalty: number;
  } {
    const issues: string[] = [];
    const issuesList: SafetyIssue[] = [];
    let scorePenalty = 0;

    const h1Matches = (content.match(/<h1[^>]*>/gi) || []).length;
    const h2Matches = (content.match(/<h2[^>]*>/gi) || []).length;

    if (h1Matches === 0) {
      issues.push('Missing H1 heading');
      issuesList.push({
        type: 'seoHeadings',
        severity: 'medium',
        message: 'Content should include an H1 heading for SEO',
        recommendation: 'Add an H1 heading that includes your primary keyword.',
      });
      scorePenalty += 5;
    }

    if (h2Matches < 2) {
      issues.push('Too few H2 headings (recommend at least 2-3)');
      issuesList.push({
        type: 'seoHeadings',
        severity: 'low',
        message: 'Add more H2 headings to structure content',
        recommendation: 'Use H2 headings to organize content sections.',
      });
      scorePenalty += 5;
    }

    return { issues, issuesList, scorePenalty };
  }

  private checkParagraphLength(paragraphs: readonly string[]): ReadonlyArray<SafetyIssue> {
    const longParagraphs = paragraphs.filter((p) => p.split(/\s+/).length > BrandSafety.MAX_PARAGRAPH_LENGTH);
    if (longParagraphs.length === 0) return [];

    return [{
      type: 'seoStructure',
      severity: 'low',
      message: 'Break up long paragraphs for better readability and SEO',
      recommendation: 'Keep paragraphs to 3-5 sentences for better readability.',
    }];
  }

  private checkSentenceLength(wordCount: number, sentenceCount: number): SafetyIssue | null {
    if (sentenceCount === 0) return null;

    const avgSentenceLength = wordCount / sentenceCount;
    if (avgSentenceLength <= BrandSafety.MAX_SENTENCE_LENGTH) return null;

    return {
      type: 'seoReadability',
      severity: 'low',
      message: 'Simplify sentence structure',
      recommendation: 'Use shorter, clearer sentences.',
    };
  }

  private validateHeadingHierarchy(content: string): ReadonlyArray<SafetyIssue> {
    const headings = content.match(/<h([1-6])[^>]*>/gi) || [];
    if (headings.length === 0) return [];

    const issues: SafetyIssue[] = [];
    let lastLevel = 0;

    headings.forEach((heading) => {
      const levelMatch = heading.match(/<h(\d)/i);
      const level = levelMatch ? parseInt(levelMatch[1] || '0', 10) : 0;
      if (lastLevel > 0 && level > lastLevel + 1) {
        issues.push({
          type: 'structureHierarchy',
          severity: 'low',
          message: `Heading hierarchy skipped (H${lastLevel} to H${level})`,
          recommendation: 'Maintain proper heading hierarchy (H1 → H2 → H3).',
        });
      }
      lastLevel = level;
    });

    return issues;
  }

  private checkListPresence(content: string): SafetyIssue | null {
    const hasLists = /<[uo]l[^>]*>/i.test(content);
    if (hasLists || content.length <= 1000) return null;

    return {
      type: 'structureLists',
      severity: 'low',
      message: 'Long content without lists - consider using bullet points',
      recommendation: 'Break up long text with bullet points or numbered lists.',
    };
  }

  private checkImageAltText(content: string): ReadonlyArray<SafetyIssue> {
    const hasImages = /<img[^>]*>/i.test(content);
    if (!hasImages) return [];

    const imagesWithoutAlt = (content.match(/<img[^>]*>/gi) || []).filter(
      (img) => !/alt\s*=/i.test(img),
    );

    if (imagesWithoutAlt.length === 0) return [];

    return [{
      type: 'structureImages',
      severity: 'medium',
      message: `${imagesWithoutAlt.length} image(s) missing alt text`,
      recommendation: 'Add descriptive alt text to all images for accessibility and SEO.',
    }];
  }

  private checkLinkPresence(content: string): SafetyIssue | null {
    const hasLinks = /<a[^>]*>/i.test(content);
    if (hasLinks || content.length <= 1500) return null;

    return {
      type: 'structureLinks',
      severity: 'low',
      message: 'Long content without links - consider adding internal/external links',
      recommendation: 'Add relevant links to improve user experience and SEO.',
    };
  }
}
