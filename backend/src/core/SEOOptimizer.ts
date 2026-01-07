import type { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { ContentGraph } from './ContentGraph.ts';
import type { BrandDNA } from './BrandManager.ts';
import { retry } from '../utils/error-handling.ts';
import { RateLimiter } from '../utils/rate-limiter.ts';

export interface StructuredData {
  readonly '@context': string;
  readonly '@type': string;
  readonly [key: string]: unknown;
}

type MutableStructuredData = {
  '@context': string;
  '@type': string;
  [key: string]: unknown;
};

export interface SEORecommendation {
  readonly priority: 'high' | 'medium' | 'low';
  readonly category: string;
  readonly issue: string;
  readonly recommendation: string;
  readonly impact: string;
  readonly estimatedImprovement?: number;
}

export interface SEOHealthScore {
  readonly overall: number;
  readonly breakdown: {
    readonly onPage: number;
    readonly technical: number;
    readonly content: number;
    readonly structuredData: number;
    readonly mobile: number;
    readonly performance: number;
    readonly eAt: number;
  };
  readonly recommendations: readonly SEORecommendation[];
  readonly issues: ReadonlyArray<{
    readonly type: string;
    readonly severity: 'error' | 'warning' | 'info';
    readonly message: string;
  }>;
}

export interface KeywordAnalysis {
  readonly semanticDensity: number;
  readonly lsiKeywords: readonly string[];
  readonly keywordProximity: number;
  readonly keywordProminence: number;
  readonly keywordDistribution: ReadonlyArray<{
    readonly keyword: string;
    readonly count: number;
    readonly positions: readonly number[];
    readonly prominence: number;
  }>;
}

interface PostInput {
  readonly id?: string;
  readonly title: string;
  readonly content: string;
  readonly excerpt: string;
  readonly publishedAt: string;
  readonly modifiedAt?: string;
  readonly author: string;
  readonly imageUrl?: string;
  readonly keywords: readonly string[];
  readonly handle?: string;
  readonly shopDomain?: string;
  readonly blogHandle?: string;
  readonly storeName?: string;
  readonly articleSection?: string;
  readonly wordCount?: number;
  readonly timeRequired?: string;
  readonly locale?: string;
  readonly locales?: readonly string[];
}

interface SEOHealthPostInput {
  readonly id?: string;
  readonly title: string;
  readonly content: string;
  readonly seoTitle: string;
  readonly seoDescription: string;
  readonly keywords: readonly string[];
  readonly wordCount: number;
  readonly images?: ReadonlyArray<{ readonly url: string; readonly alt?: string }>;
  readonly handle?: string;
  readonly shopDomain?: string;
  readonly locale?: string;
  readonly publishedAt?: string;
  readonly author?: string;
  readonly brandDNA?: BrandDNA;
}

interface SEOHealthOptions {
  readonly includeTechnical?: boolean;
  readonly includePerformance?: boolean;
  readonly includeEAt?: boolean;
}

interface OpenAIResponse {
  readonly output_text?: string;
}

interface OpenAILSIResponse {
  readonly keywords?: readonly string[];
  readonly lsiKeywords?: readonly string[];
}

interface EmbeddingResponse {
  readonly data: ReadonlyArray<{
    readonly embedding: readonly number[];
  }>;
}

interface EmbeddingCacheEntry {
  readonly embedding: readonly number[];
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

const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength);
};

const parseJSONResponse = <T>(jsonString: string, fallback: T): T => {
  try {
    const parsed = JSON.parse(jsonString) as unknown;
    return parsed as T;
  } catch {
    return fallback;
  }
};

const validateContent = (content: string): void => {
  if (!content || typeof content !== 'string') {
    throw new Error('Invalid content: must be a non-empty string');
  }
  if (content.length > 10000000) {
    throw new Error('Invalid content: exceeds maximum length of 10MB');
  }
};

const validateTitle = (title: string): void => {
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    throw new Error('Invalid title: must be a non-empty string');
  }
  if (title.length > 500) {
    throw new Error('Invalid title: exceeds maximum length of 500 characters');
  }
};

const validateKeywords = (keywords: readonly string[]): void => {
  if (!Array.isArray(keywords)) {
    throw new Error('Invalid keywords: must be an array');
  }
  if (keywords.length > 100) {
    throw new Error('Invalid keywords: exceeds maximum count of 100');
  }
  for (const keyword of keywords) {
    if (typeof keyword !== 'string' || keyword.length > 200) {
      throw new Error('Invalid keyword: must be a string with max length 200');
    }
  }
};

const validateWordCount = (wordCount: number): void => {
  if (!Number.isInteger(wordCount) || wordCount < 0 || wordCount > 1000000) {
    throw new Error('Invalid wordCount: must be an integer between 0 and 1000000');
  }
};

export class SEOOptimizer {
  private readonly openai: OpenAI;
  private readonly supabase?: SupabaseClient;
  private readonly contentGraph?: ContentGraph;
  private readonly shopDomain?: string;
  private readonly embeddingCache: Map<string, EmbeddingCacheEntry>;
  private readonly limiter: RateLimiter;
  private readonly inflightRequests: Map<string, Promise<unknown>>;
  private cacheCleanupInterval?: number;

  private static readonly SERVICE_NAME = 'SEOOptimizer';
  private static readonly EMBEDDING_MODEL = 'text-embedding-3-small';
  private static readonly EMBEDDING_DIMENSION = 1536;
  private static readonly EMBEDDING_TEXT_LIMIT = 8000;
  private static readonly EMBEDDING_CACHE_KEY_LENGTH = 100;
  private static readonly EMBEDDING_CACHE_MAX_SIZE = 1000;
  private static readonly EMBEDDING_CACHE_TTL_MS = 30 * 60 * 1000;
  private static readonly CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly CACHE_KEY_PREFIX = 'embedding:';
  private static readonly DEFAULT_DOMAIN = 'example.myshopify.com';
  private static readonly DEFAULT_BLOG_HANDLE = 'blog';
  private static readonly SCHEMA_CONTEXT = 'https://schema.org';
  private static readonly DEFAULT_STORE_NAME = 'Store';
  private static readonly DEFAULT_AUTHOR = 'Authoria';
  private static readonly MAX_IMAGE_COUNT_WARNING = 5;
  private static readonly MIN_WORD_COUNT_SHORT = 500;
  private static readonly MIN_WORD_COUNT_MEDIUM = 1000;
  private static readonly MIN_WORD_COUNT_GOOD = 1500;
  private static readonly IDEAL_TITLE_MIN = 50;
  private static readonly IDEAL_TITLE_MAX = 60;
  private static readonly IDEAL_DESCRIPTION_MIN = 150;
  private static readonly IDEAL_DESCRIPTION_MAX = 160;
  private static readonly MIN_HEADING_COUNT = 3;
  private static readonly MAX_HEADING_COUNT = 8;
  private static readonly MIN_INTERNAL_LINKS = 3;
  private static readonly MAX_INTERNAL_LINKS = 5;
  private static readonly MIN_EXTERNAL_LINKS = 1;
  private static readonly MAX_EXTERNAL_LINKS = 3;
  private static readonly LONG_PARAGRAPH_THRESHOLD = 300;
  private static readonly KEYWORD_DENSITY_MIN = 0.5;
  private static readonly KEYWORD_DENSITY_MAX = 2.0;
  private static readonly KEYWORD_PROXIMITY_DISTANCE = 500;
  private static readonly KEYWORD_PROMINENCE_FIRST_WORDS = 100;
  private static readonly KEYWORD_PROMINENCE_DECAY = 2000;
  private static readonly KEYWORD_PROMINENCE_MIN = 0.3;
  private static readonly KEYWORD_PROMINENCE_TITLE_BOOST = 0.2;
  private static readonly KEYWORD_PROMINENCE_FIRST_BOOST = 0.3;
  private static readonly KEYWORD_PROMINENCE_HEADING_BOOST = 0.3;
  private static readonly KEYWORD_PROMINENCE_TITLE_WEIGHT = 0.4;
  private static readonly SEMANTIC_DENSITY_SCALE = 2.0;
  private static readonly MAX_SEMANTIC_DENSITY = 1.0;
  private static readonly LSI_KEYWORD_COUNT_MIN = 8;
  private static readonly LSI_KEYWORD_COUNT_MAX = 10;
  private static readonly LSI_KEYWORD_CACHE_LENGTH = 20;
  private static readonly ON_PAGE_WEIGHT = 0.25;
  private static readonly TECHNICAL_WEIGHT = 0.15;
  private static readonly CONTENT_WEIGHT = 0.20;
  private static readonly STRUCTURED_DATA_WEIGHT = 0.15;
  private static readonly MOBILE_WEIGHT = 0.10;
  private static readonly PERFORMANCE_WEIGHT = 0.10;
  private static readonly EAT_WEIGHT = 0.05;
  private static readonly MAX_SCORE = 100;
  private static readonly TITLE_SCORE_PERFECT = 15;
  private static readonly TITLE_SCORE_SHORT = 10;
  private static readonly TITLE_SCORE_LONG = 8;
  private static readonly DESCRIPTION_SCORE_PERFECT = 15;
  private static readonly DESCRIPTION_SCORE_SHORT = 10;
  private static readonly DESCRIPTION_SCORE_LONG = 8;
  private static readonly CONTENT_LENGTH_SCORE_EXCELLENT = 20;
  private static readonly CONTENT_LENGTH_SCORE_GOOD = 15;
  private static readonly CONTENT_LENGTH_SCORE_MEDIUM = 10;
  private static readonly CONTENT_LENGTH_SCORE_SHORT = 5;
  private static readonly KEYWORD_SCORE_GOOD = 15;
  private static readonly KEYWORD_SCORE_OK = 10;
  private static readonly KEYWORD_TITLE_SCORE = 10;
  private static readonly KEYWORD_DESCRIPTION_SCORE = 10;
  private static readonly HEADING_SCORE_GOOD = 10;
  private static readonly IMAGE_SCORE = 5;
  private static readonly TECHNICAL_BASE_SCORE = 100;
  private static readonly TECHNICAL_HANDLE_PENALTY = 10;
  private static readonly TECHNICAL_HREFLANG_PENALTY = 5;
  private static readonly CONTENT_BASE_SCORE = 100;
  private static readonly CONTENT_NO_LINKS_PENALTY = 15;
  private static readonly CONTENT_FEW_LINKS_PENALTY = 5;
  private static readonly CONTENT_NO_EXTERNAL_PENALTY = 10;
  private static readonly STRUCTURED_DATA_BASE = 50;
  private static readonly STRUCTURED_DATA_FAQ_BONUS = 25;
  private static readonly STRUCTURED_DATA_HOWTO_BONUS = 25;
  private static readonly MOBILE_BASE_SCORE = 100;
  private static readonly MOBILE_PARAGRAPH_PENALTY = 5;
  private static readonly PERFORMANCE_BASE_SCORE = 100;
  private static readonly PERFORMANCE_IMAGE_PENALTY = 10;
  private static readonly EAT_BASE_SCORE = 100;
  private static readonly EAT_AUTHOR_PENALTY = 20;
  private static readonly EAT_BRAND_PENALTY = 10;
  private static readonly OPENAI_MAX_WAIT_MS = 60000;
  private static readonly DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffMultiplier: 2,
    retryableErrors: ['rate limit', 'timeout', 'server_error'] as const,
  } as const;

  private static readonly PRIORITY_ORDER: Readonly<Record<'high' | 'medium' | 'low', number>> = {
    high: 3,
    medium: 2,
    low: 1,
  } as const;

  constructor(
    apiKey: string,
    supabase?: SupabaseClient,
    contentGraph?: ContentGraph,
    shopDomain?: string,
  ) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new Error('Invalid OpenAI API key');
    }
    this.openai = new OpenAI({ apiKey });
    this.supabase = supabase;
    this.contentGraph = contentGraph;
    this.shopDomain = shopDomain;
    this.embeddingCache = new Map();
    this.inflightRequests = new Map();
    this.limiter = new RateLimiter({
      maxRequests: 50,
      windowMs: 60000,
      burst: 50,
      algorithm: 'token-bucket',
    });
    this.startCacheCleanup();
  }

  destroy(): void {
    if (this.cacheCleanupInterval !== undefined) {
      clearInterval(this.cacheCleanupInterval);
      this.cacheCleanupInterval = undefined;
    }
    this.embeddingCache.clear();
    this.inflightRequests.clear();
  }

  private startCacheCleanup(): void {
    this.cacheCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.embeddingCache.entries()) {
        if (entry.expiresAt < now) {
          this.embeddingCache.delete(key);
        }
      }
    }, SEOOptimizer.CACHE_CLEANUP_INTERVAL_MS) as unknown as number;
  }

  generateBlogPostingSchema(post: PostInput): StructuredData {
    validateTitle(post.title);
    validateContent(post.content);
    if (post.excerpt && typeof post.excerpt !== 'string') {
      throw new Error('Invalid excerpt: must be a string');
    }
    validateKeywords(post.keywords);

    const url = this.generateBlogUrl(post.handle, post.shopDomain, post.blogHandle);
    const schema: MutableStructuredData = {
      '@context': SEOOptimizer.SCHEMA_CONTEXT,
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.excerpt,
      datePublished: post.publishedAt,
      dateModified: post.modifiedAt || post.publishedAt,
      author: {
        '@type': 'Person',
        name: post.author,
      },
      publisher: {
        '@type': 'Organization',
        name: post.storeName || SEOOptimizer.DEFAULT_STORE_NAME,
        ...(post.shopDomain && { url: `https://${post.shopDomain}` }),
      },
      mainEntityOfPage: {
        '@type': 'WebPage',
        '@id': url,
        url,
      },
      keywords: post.keywords.join(', '),
    };

    if (post.imageUrl) {
      schema.image = {
        '@type': 'ImageObject',
        url: post.imageUrl,
      };
    }

    return schema;
  }

  async generateStructuredData(input: {
    readonly title: string;
    readonly content: string;
    readonly excerpt: string;
    readonly keywords: readonly string[];
  }): Promise<StructuredData> {
    validateTitle(input.title);
    validateContent(input.content);
    if (!input.excerpt || typeof input.excerpt !== 'string') {
      throw new Error('Invalid excerpt: must be a non-empty string');
    }
    validateKeywords(input.keywords);

    return this.generateBlogPostingSchema({
      title: input.title,
      content: input.content,
      excerpt: input.excerpt,
      publishedAt: new Date().toISOString(),
      author: SEOOptimizer.DEFAULT_AUTHOR,
      keywords: input.keywords,
      shopDomain: this.shopDomain,
    });
  }

  async analyzeKeywords(
    content: string,
    title: string,
    primaryKeywords: readonly string[],
  ): Promise<KeywordAnalysis> {
    const startTime = Date.now();
    validateContent(content);
    validateTitle(title);
    validateKeywords(primaryKeywords);

    if (!this.openai || primaryKeywords.length === 0) {
      return this.getDefaultKeywordAnalysis();
    }

    try {
      const [lsiKeywords, semanticDensity, distribution, proximity, prominence] = await Promise.all([
        this.generateLSIKeywords(primaryKeywords[0], content),
        this.calculateSemanticDensity(content, primaryKeywords),
        Promise.resolve(this.calculateKeywordDistribution(content, title, primaryKeywords)),
        Promise.resolve(this.calculateKeywordProximity(content, primaryKeywords)),
        Promise.resolve(this.calculateKeywordProminence(content, title, primaryKeywords)),
      ]);

      const duration = Date.now() - startTime;
      structuredLog('info', SEOOptimizer.SERVICE_NAME, 'Keywords analyzed', {
        keywordsCount: primaryKeywords.length,
        durationMs: duration,
      });

      return {
        semanticDensity,
        lsiKeywords,
        keywordProximity: proximity,
        keywordProminence: prominence,
        keywordDistribution: distribution,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', SEOOptimizer.SERVICE_NAME, 'Keyword analysis failed', {
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      return this.getDefaultKeywordAnalysis();
    }
  }

  async calculateSEOHealthScore(
    post: SEOHealthPostInput,
    options?: SEOHealthOptions,
  ): Promise<SEOHealthScore> {
    const startTime = Date.now();
    validateTitle(post.title);
    validateContent(post.content);
    validateTitle(post.seoTitle);
    if (!post.seoDescription || typeof post.seoDescription !== 'string') {
      throw new Error('Invalid seoDescription: must be a non-empty string');
    }
    validateKeywords(post.keywords);
    validateWordCount(post.wordCount);

    const recommendations: SEORecommendation[] = [];
    const issues: Array<{
      type: string;
      severity: 'error' | 'warning' | 'info';
      message: string;
    }> = [];

    const [onPageScore, technicalScore, contentScore, structuredDataScore, mobileScore, performanceScore, eAtScore] = await Promise.all([
      Promise.resolve(this.calculateOnPageScore(post, recommendations, issues)),
      options?.includeTechnical
        ? this.calculateTechnicalScore(post, recommendations, issues)
        : Promise.resolve(SEOOptimizer.MAX_SCORE),
      Promise.resolve(this.calculateContentScore(post, recommendations, issues)),
      this.calculateStructuredDataScore(post, recommendations, issues),
      Promise.resolve(this.calculateMobileScore(post, recommendations, issues)),
      options?.includePerformance
        ? this.calculatePerformanceScore(post, recommendations, issues)
        : Promise.resolve(SEOOptimizer.MAX_SCORE),
      options?.includeEAt
        ? this.calculateEAtScore(post, recommendations, issues)
        : Promise.resolve(SEOOptimizer.MAX_SCORE),
    ]);

    const overall =
      onPageScore * SEOOptimizer.ON_PAGE_WEIGHT +
      technicalScore * SEOOptimizer.TECHNICAL_WEIGHT +
      contentScore * SEOOptimizer.CONTENT_WEIGHT +
      structuredDataScore * SEOOptimizer.STRUCTURED_DATA_WEIGHT +
      mobileScore * SEOOptimizer.MOBILE_WEIGHT +
      performanceScore * SEOOptimizer.PERFORMANCE_WEIGHT +
      eAtScore * SEOOptimizer.EAT_WEIGHT;

    const duration = Date.now() - startTime;
    structuredLog('info', SEOOptimizer.SERVICE_NAME, 'SEO health score calculated', {
      overall: Math.round(overall),
      durationMs: duration,
    });

    return {
      overall: Math.round(overall),
      breakdown: {
        onPage: Math.round(onPageScore),
        technical: Math.round(technicalScore),
        content: Math.round(contentScore),
        structuredData: Math.round(structuredDataScore),
        mobile: Math.round(mobileScore),
        performance: Math.round(performanceScore),
        eAt: Math.round(eAtScore),
      },
      recommendations: recommendations.sort((a, b) => {
        return SEOOptimizer.PRIORITY_ORDER[b.priority] - SEOOptimizer.PRIORITY_ORDER[a.priority];
      }),
      issues,
    };
  }

  private generateBlogUrl(handle: string | undefined, shopDomain?: string, blogHandle?: string): string {
    const domain = shopDomain || this.shopDomain || SEOOptimizer.DEFAULT_DOMAIN;
    const blog = blogHandle || SEOOptimizer.DEFAULT_BLOG_HANDLE;
    const slug = handle || '';
    return `https://${domain}/${blog}/${slug}`;
  }

  private async generateLSIKeywords(primaryKeyword: string, content: string): Promise<readonly string[]> {
    const prompt = this.buildLSIKeywordsPrompt(primaryKeyword);

    try {
      const response = await this.callOpenAI(prompt, this.buildLSICacheKey(primaryKeyword), true);
      const result = parseJSONResponse<OpenAILSIResponse>(response.output_text || '{}', { keywords: [] });
      return result.keywords || result.lsiKeywords || [];
    } catch (error) {
      structuredLog('warn', SEOOptimizer.SERVICE_NAME, 'Failed to generate LSI keywords', {
        primaryKeyword,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async calculateSemanticDensity(
    content: string,
    keywords: readonly string[],
  ): Promise<number> {
    if (!this.openai || keywords.length === 0) {
      return 0;
    }

    const [contentEmbedding, keywordEmbedding] = await Promise.all([
      this.createEmbedding(content),
      this.createEmbedding(keywords.join(' ')),
    ]);

    const similarity = this.cosineSimilarity(contentEmbedding, keywordEmbedding);
    return Math.min(similarity * SEOOptimizer.SEMANTIC_DENSITY_SCALE, SEOOptimizer.MAX_SEMANTIC_DENSITY);
  }

  private calculateKeywordDistribution(
    content: string,
    title: string,
    keywords: readonly string[],
  ): ReadonlyArray<{
    readonly keyword: string;
    readonly count: number;
    readonly positions: readonly number[];
    readonly prominence: number;
  }> {
    return keywords.map((keyword) => {
      const keywordLower = keyword.toLowerCase();
      const contentLower = content.toLowerCase();
      const titleLower = title.toLowerCase();

      const positions = this.findAllPositions(contentLower, keywordLower);
      const prominenceScore = this.calculateProminenceScore(content, positions);
      const titleBoost = titleLower.includes(keywordLower) ? SEOOptimizer.KEYWORD_PROMINENCE_TITLE_BOOST : 0;

      return {
        keyword,
        count: positions.length,
        positions,
        prominence: Math.min(prominenceScore + titleBoost, SEOOptimizer.MAX_SEMANTIC_DENSITY),
      };
    });
  }

  private findAllPositions(content: string, keyword: string): readonly number[] {
    const positions: number[] = [];
    let index = content.indexOf(keyword);

    while (index !== -1) {
      positions.push(index);
      index = content.indexOf(keyword, index + 1);
    }

    return positions;
  }

  private calculateProminenceScore(content: string, positions: readonly number[]): number {
    if (positions.length === 0) {
      return 0;
    }

    const scores = positions.map((pos) => {
      const wordCount = content.substring(0, pos).split(/\s+/).length;
      return wordCount < SEOOptimizer.KEYWORD_PROMINENCE_FIRST_WORDS
        ? SEOOptimizer.MAX_SEMANTIC_DENSITY
        : Math.max(
            SEOOptimizer.KEYWORD_PROMINENCE_MIN,
            SEOOptimizer.MAX_SEMANTIC_DENSITY - wordCount / SEOOptimizer.KEYWORD_PROMINENCE_DECAY,
          );
    });

    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  private calculateKeywordProximity(content: string, keywords: readonly string[]): number {
    if (keywords.length < 2) {
      return SEOOptimizer.MAX_SEMANTIC_DENSITY;
    }

    const contentLower = content.toLowerCase();
    const positions = keywords.map((keyword) => this.findAllPositions(contentLower, keyword.toLowerCase()));

    let totalProximity = 0;
    let pairCount = 0;

    for (let i = 0; i < positions.length - 1; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        for (const pos1 of positions[i]) {
          for (const pos2 of positions[j]) {
            const distance = Math.abs(pos1 - pos2);
            const proximity = Math.max(
              0,
              SEOOptimizer.MAX_SEMANTIC_DENSITY - distance / SEOOptimizer.KEYWORD_PROXIMITY_DISTANCE,
            );
            totalProximity += proximity;
            pairCount++;
          }
        }
      }
    }

    return pairCount > 0 ? totalProximity / pairCount : 0;
  }

  private calculateKeywordProminence(
    content: string,
    title: string,
    keywords: readonly string[],
  ): number {
    const titleLower = title.toLowerCase();
    const contentLower = content.toLowerCase();
    let totalProminence = 0;

    for (const keyword of keywords) {
      const keywordLower = keyword.toLowerCase();

      if (titleLower.includes(keywordLower)) {
        totalProminence += SEOOptimizer.KEYWORD_PROMINENCE_TITLE_WEIGHT;
      }

      const first100Words = content.split(/\s+/).slice(0, SEOOptimizer.KEYWORD_PROMINENCE_FIRST_WORDS).join(' ').toLowerCase();
      if (first100Words.includes(keywordLower)) {
        totalProminence += SEOOptimizer.KEYWORD_PROMINENCE_FIRST_BOOST;
      }

      const headings = content.match(/^#+\s+.+$/gm) || [];
      const headingText = headings.join(' ').toLowerCase();
      if (headingText.includes(keywordLower)) {
        totalProminence += SEOOptimizer.KEYWORD_PROMINENCE_HEADING_BOOST;
      }
    }

    return Math.min(totalProminence / keywords.length, SEOOptimizer.MAX_SEMANTIC_DENSITY);
  }

  private calculateOnPageScore(
    post: SEOHealthPostInput,
    recommendations: SEORecommendation[],
    issues: Array<{ type: string; severity: 'error' | 'warning' | 'info'; message: string }>,
  ): number {
    let score = 0;

    score += this.scoreTitle(post.seoTitle, recommendations);
    score += this.scoreDescription(post.seoDescription, recommendations);
    score += this.scoreContentLength(post.wordCount, recommendations);
    score += this.scoreKeywordUsage(post.content, post.keywords, recommendations);
    score += this.scoreKeywordsInTitle(post.title, post.keywords, recommendations);
    score += this.scoreKeywordsInDescription(post.seoDescription, post.keywords, recommendations);
    score += this.scoreHeadings(post.content, recommendations);
    score += SEOOptimizer.IMAGE_SCORE;

    return Math.min(SEOOptimizer.MAX_SCORE, score);
  }

  private scoreTitle(title: string, recommendations: SEORecommendation[]): number {
    if (title.length >= SEOOptimizer.IDEAL_TITLE_MIN && title.length <= SEOOptimizer.IDEAL_TITLE_MAX) {
      return SEOOptimizer.TITLE_SCORE_PERFECT;
    }

    if (title.length > 0 && title.length < SEOOptimizer.IDEAL_TITLE_MIN) {
      recommendations.push(this.createTitleRecommendation('short', title.length));
      return SEOOptimizer.TITLE_SCORE_SHORT;
    }

    if (title.length > SEOOptimizer.IDEAL_TITLE_MAX) {
      recommendations.push(this.createTitleRecommendation('long', title.length));
      return SEOOptimizer.TITLE_SCORE_LONG;
    }

    return 0;
  }

  private scoreDescription(description: string, recommendations: SEORecommendation[]): number {
    if (
      description.length >= SEOOptimizer.IDEAL_DESCRIPTION_MIN &&
      description.length <= SEOOptimizer.IDEAL_DESCRIPTION_MAX
    ) {
      return SEOOptimizer.DESCRIPTION_SCORE_PERFECT;
    }

    if (description.length > 0 && description.length < SEOOptimizer.IDEAL_DESCRIPTION_MIN) {
      recommendations.push(this.createDescriptionRecommendation('short', description.length));
      return SEOOptimizer.DESCRIPTION_SCORE_SHORT;
    }

    if (description.length > SEOOptimizer.IDEAL_DESCRIPTION_MAX) {
      recommendations.push(this.createDescriptionRecommendation('long', description.length));
      return SEOOptimizer.DESCRIPTION_SCORE_LONG;
    }

    return 0;
  }

  private scoreContentLength(wordCount: number, recommendations: SEORecommendation[]): number {
    if (wordCount >= SEOOptimizer.MIN_WORD_COUNT_GOOD) {
      return SEOOptimizer.CONTENT_LENGTH_SCORE_EXCELLENT;
    }

    if (wordCount >= SEOOptimizer.MIN_WORD_COUNT_MEDIUM) {
      recommendations.push(this.createContentLengthRecommendation('medium', wordCount));
      return SEOOptimizer.CONTENT_LENGTH_SCORE_GOOD;
    }

    if (wordCount >= SEOOptimizer.MIN_WORD_COUNT_SHORT) {
      recommendations.push(this.createContentLengthRecommendation('short', wordCount));
      return SEOOptimizer.CONTENT_LENGTH_SCORE_MEDIUM;
    }

    recommendations.push(this.createContentLengthRecommendation('very_short', wordCount));
    return SEOOptimizer.CONTENT_LENGTH_SCORE_SHORT;
  }

  private scoreKeywordUsage(
    content: string,
    keywords: readonly string[],
    recommendations: SEORecommendation[],
  ): number {
    if (keywords.length === 0) {
      return 0;
    }

    const primaryKeyword = keywords[0];
    const keywordDensity = this.calculateKeywordDensity(content, primaryKeyword);

    if (keywordDensity >= SEOOptimizer.KEYWORD_DENSITY_MIN && keywordDensity <= SEOOptimizer.KEYWORD_DENSITY_MAX) {
      return SEOOptimizer.KEYWORD_SCORE_GOOD;
    }

    if (keywordDensity > 0) {
      if (keywordDensity < SEOOptimizer.KEYWORD_DENSITY_MIN) {
        recommendations.push(this.createKeywordDensityRecommendation('low', primaryKeyword, keywordDensity));
      } else if (keywordDensity > SEOOptimizer.KEYWORD_DENSITY_MAX) {
        recommendations.push(this.createKeywordDensityRecommendation('high', primaryKeyword, keywordDensity));
      }
      return SEOOptimizer.KEYWORD_SCORE_OK;
    }

    return 0;
  }

  private scoreKeywordsInTitle(
    title: string,
    keywords: readonly string[],
    recommendations: SEORecommendation[],
  ): number {
    if (keywords.some((kw) => title.toLowerCase().includes(kw.toLowerCase()))) {
      return SEOOptimizer.KEYWORD_TITLE_SCORE;
    }

    if (keywords.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'Title Optimization',
        issue: 'Primary keyword not in title',
        recommendation: `Include primary keyword "${keywords[0]}" in the title`,
        impact: 'Improved title relevance and ranking',
        estimatedImprovement: 12,
      });
    }

    return 0;
  }

  private scoreKeywordsInDescription(
    description: string,
    keywords: readonly string[],
    recommendations: SEORecommendation[],
  ): number {
    if (keywords.some((kw) => description.toLowerCase().includes(kw.toLowerCase()))) {
      return SEOOptimizer.KEYWORD_DESCRIPTION_SCORE;
    }

    if (keywords.length > 0) {
      recommendations.push({
        priority: 'medium',
        category: 'Meta Description',
        issue: 'Primary keyword not in meta description',
        recommendation: `Include primary keyword "${keywords[0]}" in meta description`,
        impact: 'Better keyword relevance in search snippets',
        estimatedImprovement: 5,
      });
    }

    return 0;
  }

  private scoreHeadings(content: string, recommendations: SEORecommendation[]): number {
    const headingCount = (content.match(/^#+\s/gm) || []).length;

    if (headingCount >= SEOOptimizer.MIN_HEADING_COUNT && headingCount <= SEOOptimizer.MAX_HEADING_COUNT) {
      return SEOOptimizer.HEADING_SCORE_GOOD;
    }

    recommendations.push({
      priority: 'medium',
      category: 'Content Structure',
      issue: headingCount < SEOOptimizer.MIN_HEADING_COUNT ? 'Insufficient headings' : 'Too many headings',
      recommendation:
        headingCount < SEOOptimizer.MIN_HEADING_COUNT
          ? `Add ${SEOOptimizer.MIN_HEADING_COUNT}-${SEOOptimizer.MAX_HEADING_COUNT} headings to improve content structure`
          : `Reduce heading count to ${SEOOptimizer.MIN_HEADING_COUNT}-${SEOOptimizer.MAX_HEADING_COUNT} for better structure`,
      impact: 'Improved content organization and SEO',
      estimatedImprovement: 5,
    });

    return 0;
  }

  private async calculateTechnicalScore(
    post: SEOHealthPostInput,
    recommendations: SEORecommendation[],
    issues: Array<{ type: string; severity: 'error' | 'warning' | 'info'; message: string }>,
  ): Promise<number> {
    let score = SEOOptimizer.TECHNICAL_BASE_SCORE;

    if (!post.handle) {
      score -= SEOOptimizer.TECHNICAL_HANDLE_PENALTY;
      recommendations.push({
        priority: 'high',
        category: 'Technical SEO',
        issue: 'Missing URL handle',
        recommendation: 'Ensure post has a unique URL handle',
        impact: 'Required for canonical URL implementation',
        estimatedImprovement: 8,
      });
    }

    if (post.locale && post.locale !== 'en') {
      score -= SEOOptimizer.TECHNICAL_HREFLANG_PENALTY;
      recommendations.push({
        priority: 'medium',
        category: 'Technical SEO',
        issue: 'Hreflang tags may be missing',
        recommendation: 'Implement hreflang tags for multi-language content',
        impact: 'Better international SEO and indexing',
        estimatedImprovement: 5,
      });
    }

    return Math.max(0, score);
  }

  private calculateContentScore(
    post: SEOHealthPostInput,
    recommendations: SEORecommendation[],
    issues: Array<{ type: string; severity: 'error' | 'warning' | 'info'; message: string }>,
  ): number {
    let score = SEOOptimizer.CONTENT_BASE_SCORE;

    const internalLinkCount = (post.content.match(/\[([^\]]+)\]\([^)]+\)/g) || []).length;
    if (internalLinkCount === 0) {
      score -= SEOOptimizer.CONTENT_NO_LINKS_PENALTY;
      recommendations.push({
        priority: 'high',
        category: 'Content Quality',
        issue: 'No internal links found',
        recommendation: `Add ${SEOOptimizer.MIN_INTERNAL_LINKS}-${SEOOptimizer.MAX_INTERNAL_LINKS} internal links to related content`,
        impact: 'Improved site structure and SEO',
        estimatedImprovement: 10,
      });
    } else if (internalLinkCount < SEOOptimizer.MIN_INTERNAL_LINKS) {
      score -= SEOOptimizer.CONTENT_FEW_LINKS_PENALTY;
      recommendations.push({
        priority: 'medium',
        category: 'Content Quality',
        issue: 'Few internal links',
        recommendation: `Add more internal links to related content (${SEOOptimizer.MIN_INTERNAL_LINKS}-${SEOOptimizer.MAX_INTERNAL_LINKS} recommended)`,
        impact: 'Better content discovery and SEO',
        estimatedImprovement: 5,
      });
    }

    const externalLinkPattern = /https?:\/\/(?!.*shopify\.com|.*myshopify\.com)[^\s)]+/g;
    const externalLinks = (post.content.match(externalLinkPattern) || []).length;
    if (externalLinks === 0) {
      score -= SEOOptimizer.CONTENT_NO_EXTERNAL_PENALTY;
      recommendations.push({
        priority: 'medium',
        category: 'Content Quality',
        issue: 'No external links to authoritative sources',
        recommendation: `Add ${SEOOptimizer.MIN_EXTERNAL_LINKS}-${SEOOptimizer.MAX_EXTERNAL_LINKS} external links to authoritative, relevant sources`,
        impact: 'Improved E-A-T signals and content credibility',
        estimatedImprovement: 5,
      });
    }

    return Math.max(0, score);
  }

  private async calculateStructuredDataScore(
    post: SEOHealthPostInput,
    recommendations: SEORecommendation[],
    issues: Array<{ type: string; severity: 'error' | 'warning' | 'info'; message: string }>,
  ): Promise<number> {
    let score = SEOOptimizer.STRUCTURED_DATA_BASE;

    const howToPattern = /(step\s+\d+|first|next|then|finally|how to)/i;
    if (howToPattern.test(post.content)) {
      score += SEOOptimizer.STRUCTURED_DATA_HOWTO_BONUS;
      recommendations.push({
        priority: 'low',
        category: 'Structured Data',
        issue: 'HowTo schema potential',
        recommendation: 'Consider adding HowTo structured data for step-by-step content',
        impact: 'Potential for HowTo rich results',
        estimatedImprovement: 5,
      });
    }

    return Math.min(SEOOptimizer.MAX_SCORE, score);
  }

  private calculateMobileScore(
    post: SEOHealthPostInput,
    recommendations: SEORecommendation[],
    issues: Array<{ type: string; severity: 'error' | 'warning' | 'info'; message: string }>,
  ): number {
    let score = SEOOptimizer.MOBILE_BASE_SCORE;

    const paragraphs = post.content.split(/\n\n+/);
    const longParagraphs = paragraphs.filter((p) => p.length > SEOOptimizer.LONG_PARAGRAPH_THRESHOLD).length;

    if (longParagraphs > 0) {
      score -= longParagraphs * SEOOptimizer.MOBILE_PARAGRAPH_PENALTY;
      recommendations.push({
        priority: 'medium',
        category: 'Mobile Optimization',
        issue: 'Long paragraphs detected',
        recommendation: `Break up long paragraphs (${SEOOptimizer.LONG_PARAGRAPH_THRESHOLD}+ characters) for better mobile readability`,
        impact: 'Improved mobile user experience',
        estimatedImprovement: 5,
      });
    }

    return Math.max(0, score);
  }

  private async calculatePerformanceScore(
    post: SEOHealthPostInput,
    recommendations: SEORecommendation[],
    issues: Array<{ type: string; severity: 'error' | 'warning' | 'info'; message: string }>,
  ): Promise<number> {
    let score = SEOOptimizer.PERFORMANCE_BASE_SCORE;

    const imageCount = post.images?.length || 0;
    if (imageCount > SEOOptimizer.MAX_IMAGE_COUNT_WARNING) {
      score -= SEOOptimizer.PERFORMANCE_IMAGE_PENALTY;
      recommendations.push({
        priority: 'medium',
        category: 'Performance',
        issue: 'Many images detected',
        recommendation: 'Ensure all images are optimized (WebP format, proper sizing, lazy loading)',
        impact: 'Improved page load speed and Core Web Vitals',
        estimatedImprovement: 8,
      });
    }

    return Math.max(0, score);
  }

  private async calculateEAtScore(
    post: SEOHealthPostInput,
    recommendations: SEORecommendation[],
    issues: Array<{ type: string; severity: 'error' | 'warning' | 'info'; message: string }>,
  ): Promise<number> {
    let score = SEOOptimizer.EAT_BASE_SCORE;

    if (!post.author || post.author === SEOOptimizer.DEFAULT_AUTHOR) {
      score -= SEOOptimizer.EAT_AUTHOR_PENALTY;
      recommendations.push({
        priority: 'high',
        category: 'E-A-T',
        issue: 'Generic or missing author',
        recommendation: 'Use real author names with credentials/bios for better E-A-T signals',
        impact: 'Improved expertise and trustworthiness signals',
        estimatedImprovement: 10,
      });
    }

    if (!post.brandDNA) {
      score -= SEOOptimizer.EAT_BRAND_PENALTY;
      recommendations.push({
        priority: 'medium',
        category: 'E-A-T',
        issue: 'Limited brand information',
        recommendation: 'Ensure brand DNA and authority signals are present',
        impact: 'Better brand authority signals',
        estimatedImprovement: 5,
      });
    }

    return Math.max(0, score);
  }

  private calculateKeywordDensity(content: string, keyword: string): number {
    const words = content.toLowerCase().split(/\s+/);
    const keywordLower = keyword.toLowerCase();
    const totalWords = words.length;

    if (totalWords === 0) {
      return 0;
    }

    const contentLower = content.toLowerCase();
    const occurrences = (contentLower.match(new RegExp(keywordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

    return (occurrences / totalWords) * SEOOptimizer.MAX_SCORE;
  }

  private async createEmbedding(text: string): Promise<readonly number[]> {
    const cacheKey = `${SEOOptimizer.CACHE_KEY_PREFIX}${text.substring(0, SEOOptimizer.EMBEDDING_CACHE_KEY_LENGTH)}`;
    const cached = this.embeddingCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.embedding;
    }

    if (!this.openai) {
      return new Array(SEOOptimizer.EMBEDDING_DIMENSION).fill(0);
    }

    const requestKey = `embedding:${cacheKey}`;
    const inflight = this.inflightRequests.get(requestKey);
    if (inflight) {
      return (await inflight) as readonly number[];
    }

    const embeddingPromise = retry(
      async () => {
        const allowed = await this.limiter.waitForToken('openai-embeddings', SEOOptimizer.OPENAI_MAX_WAIT_MS);
        if (!allowed) {
          throw new Error('OpenAI rate limit wait exceeded');
        }

        const start = Date.now();
        const response = await this.openai.embeddings.create({
          model: SEOOptimizer.EMBEDDING_MODEL,
          input: truncateText(text, SEOOptimizer.EMBEDDING_TEXT_LIMIT),
        }) as unknown as EmbeddingResponse;

        structuredLog('info', SEOOptimizer.SERVICE_NAME, 'Embedding created', {
          latencyMs: Date.now() - start,
        });

        return response.data[0]?.embedding || [];
      },
      {
        ...SEOOptimizer.DEFAULT_RETRY_OPTIONS,
        onRetry: (attempt, err) => {
          structuredLog('warn', SEOOptimizer.SERVICE_NAME, 'Retrying embedding creation', {
            attempt,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      },
    );

    this.inflightRequests.set(requestKey, embeddingPromise);

    try {
      const embedding = await embeddingPromise;
      this.embeddingCache.set(cacheKey, {
        embedding,
        expiresAt: Date.now() + SEOOptimizer.EMBEDDING_CACHE_TTL_MS,
      });
      return embedding;
    } catch (error) {
      structuredLog('error', SEOOptimizer.SERVICE_NAME, 'Failed to create embedding', {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Array(SEOOptimizer.EMBEDDING_DIMENSION).fill(0);
    } finally {
      this.inflightRequests.delete(requestKey);
    }
  }

  private cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  private buildLSIKeywordsPrompt(primaryKeyword: string): string {
    return `You are an expert SEO specialist specializing in Latent Semantic Indexing (LSI) keyword research.

## Role
Expert SEO keyword researcher with deep expertise in:
- Semantic search optimization
- Topic modeling and clustering
- Search engine understanding algorithms
- Content context optimization

## Task
Generate ${SEOOptimizer.LSI_KEYWORD_COUNT_MIN}-${SEOOptimizer.LSI_KEYWORD_COUNT_MAX} LSI keywords related to "${primaryKeyword}".

## LSI Keyword Criteria
LSI keywords are:
- Thematically related to the primary keyword
- Contextually relevant (would appear in same content)
- Supporting terms that expand topic coverage
- Related concepts, entities, or subtopics
- NOT synonyms - they're complementary terms providing context

## Output Format
Return ONLY valid JSON array:
["keyword1", "keyword2", "keyword3", ...]`;
  }

  private buildLSICacheKey(primaryKeyword: string): string {
    return `lsi-keywords-${primaryKeyword.substring(0, SEOOptimizer.LSI_KEYWORD_CACHE_LENGTH)}`;
  }

  private async callOpenAI(
    prompt: string,
    cacheKey: string,
    useJsonFormat: boolean = false,
  ): Promise<OpenAIResponse> {
    const requestKey = `openai:${cacheKey}:${prompt.substring(0, 50)}`;
    const inflight = this.inflightRequests.get(requestKey);
    if (inflight) {
      return (await inflight) as OpenAIResponse;
    }

    const requestPromise = retry(
      async () => {
        const allowed = await this.limiter.waitForToken('openai-responses', SEOOptimizer.OPENAI_MAX_WAIT_MS);
        if (!allowed) {
          throw new Error('OpenAI rate limit wait exceeded');
        }

        const start = Date.now();
        const response = await this.openai.responses.create({
          model: 'gpt-5-mini',
          reasoning: { effort: 'low' },
          text: { verbosity: useJsonFormat ? 'medium' : 'low' },
          input: prompt,
          response_format: useJsonFormat ? { type: 'json_object' } : undefined,
          prompt_cache_key: cacheKey,
          prompt_cache_retention: '24h',
        }) as OpenAIResponse;

        structuredLog('info', SEOOptimizer.SERVICE_NAME, 'OpenAI call completed', {
          cacheKey,
          latencyMs: Date.now() - start,
        });

        return response;
      },
      {
        ...SEOOptimizer.DEFAULT_RETRY_OPTIONS,
        onRetry: (attempt, err) => {
          structuredLog('warn', SEOOptimizer.SERVICE_NAME, 'Retrying OpenAI call', {
            attempt,
            cacheKey,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      },
    );

    this.inflightRequests.set(requestKey, requestPromise);

    try {
      return await requestPromise;
    } finally {
      this.inflightRequests.delete(requestKey);
    }
  }

  private getDefaultKeywordAnalysis(): KeywordAnalysis {
    return {
      semanticDensity: 0,
      lsiKeywords: [],
      keywordProximity: 0,
      keywordProminence: 0,
      keywordDistribution: [],
    };
  }

  private createTitleRecommendation(type: 'short' | 'long', length: number): SEORecommendation {
    if (type === 'short') {
      return {
        priority: 'medium',
        category: 'Title',
        issue: 'Title is too short',
        recommendation: `Extend title to ${SEOOptimizer.IDEAL_TITLE_MIN}-${SEOOptimizer.IDEAL_TITLE_MAX} characters for optimal SEO. Current: ${length} chars.`,
        impact: 'Improved click-through rate and search visibility',
        estimatedImprovement: 5,
      };
    }

    return {
      priority: 'high',
      category: 'Title',
      issue: 'Title is too long',
      recommendation: `Shorten title to ${SEOOptimizer.IDEAL_TITLE_MAX} characters or less. Current: ${length} chars.`,
      impact: 'Title will be truncated in search results',
      estimatedImprovement: 10,
    };
  }

  private createDescriptionRecommendation(
    type: 'short' | 'long',
    length: number,
  ): SEORecommendation {
    if (type === 'short') {
      return {
        priority: 'medium',
        category: 'Meta Description',
        issue: 'Meta description is too short',
        recommendation: `Extend meta description to ${SEOOptimizer.IDEAL_DESCRIPTION_MIN}-${SEOOptimizer.IDEAL_DESCRIPTION_MAX} characters. Current: ${length} chars.`,
        impact: 'Better search snippet appearance',
        estimatedImprovement: 5,
      };
    }

    return {
      priority: 'high',
      category: 'Meta Description',
      issue: 'Meta description is too long',
      recommendation: `Shorten meta description to ${SEOOptimizer.IDEAL_DESCRIPTION_MAX} characters or less. Current: ${length} chars.`,
      impact: 'Description will be truncated in search results',
      estimatedImprovement: 8,
    };
  }

  private createContentLengthRecommendation(
    type: 'medium' | 'short' | 'very_short',
    wordCount: number,
  ): SEORecommendation {
    if (type === 'medium') {
      return {
        priority: 'low',
        category: 'Content Length',
        issue: 'Content could be longer',
        recommendation: `Extend content to ${SEOOptimizer.MIN_WORD_COUNT_GOOD}+ words for better SEO performance`,
        impact: 'Improved ranking potential for competitive keywords',
        estimatedImprovement: 3,
      };
    }

    if (type === 'short') {
      return {
        priority: 'medium',
        category: 'Content Length',
        issue: 'Content is relatively short',
        recommendation: `Extend content to at least ${SEOOptimizer.MIN_WORD_COUNT_MEDIUM} words for better SEO`,
        impact: 'Better topic coverage and ranking potential',
        estimatedImprovement: 8,
      };
    }

    return {
      priority: 'high',
      category: 'Content Length',
      issue: 'Content is too short',
      recommendation: `Extend content to at least ${SEOOptimizer.MIN_WORD_COUNT_SHORT} words minimum, ideally ${SEOOptimizer.MIN_WORD_COUNT_GOOD}+`,
      impact: 'Significantly improved ranking potential',
      estimatedImprovement: 15,
    };
  }

  private createKeywordDensityRecommendation(
    type: 'low' | 'high',
    keyword: string,
    density: number,
  ): SEORecommendation {
    if (type === 'low') {
      return {
        priority: 'medium',
        category: 'Keyword Usage',
        issue: 'Low keyword density',
        recommendation: `Increase usage of primary keyword "${keyword}" naturally throughout content`,
        impact: 'Better keyword relevance signals',
        estimatedImprovement: 5,
      };
    }

    return {
      priority: 'high',
      category: 'Keyword Usage',
      issue: 'Keyword stuffing detected',
      recommendation: `Reduce keyword density. Current: ${density.toFixed(2)}%. Ideal: ${SEOOptimizer.KEYWORD_DENSITY_MIN}-${SEOOptimizer.KEYWORD_DENSITY_MAX}%`,
      impact: 'Avoid keyword stuffing penalties',
      estimatedImprovement: 10,
    };
  }
}
