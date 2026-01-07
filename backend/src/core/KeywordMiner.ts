import OpenAI from 'openai';
import { RateLimiter } from '../utils/rate-limiter.ts';
import { retry } from '../utils/error-handling.ts';

export type KeywordIntent = 'informational' | 'commercial' | 'navigational' | 'transactional';

export interface Keyword {
  readonly keyword: string;
  readonly intent: KeywordIntent;
  readonly relevanceScore: number;
  readonly priority: 'high' | 'medium' | 'low';
  readonly category?: string;
}

export interface KeywordCluster {
  readonly primaryKeyword: Keyword;
  readonly longTailKeywords: ReadonlyArray<Keyword>;
  readonly semanticVariations: ReadonlyArray<Keyword>;
  readonly paaQuestions: ReadonlyArray<Keyword>;
  readonly lsiKeywords: ReadonlyArray<Keyword>;
  readonly topicClusters: ReadonlyMap<string, ReadonlyArray<Keyword>>;
}

interface PrimaryKeywordResponse {
  readonly keyword?: string;
  readonly intent?: string;
  readonly relevanceScore?: number;
  readonly priority?: string;
}

interface KeywordItem {
  readonly keyword?: string;
  readonly intent?: string;
  readonly relevanceScore?: number;
  readonly priority?: string;
  readonly category?: string;
}

interface KeywordsResponse {
  readonly keywords?: ReadonlyArray<KeywordItem | string>;
  readonly longTail?: ReadonlyArray<KeywordItem | string>;
}

interface OpenAIResponse {
  readonly output_text?: string;
}

interface PromptConfig {
  readonly model: string;
  readonly reasoning: { readonly effort: 'none' | 'low' | 'medium' | 'high' };
  readonly text: { readonly verbosity: 'low' | 'medium' | 'high' };
  readonly responseFormat?: { readonly type: 'json_object' };
  readonly promptCacheKey: string;
  readonly promptCacheRetention: string;
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

const truncateText = (text: string, maxLength: number): string => {
  return text.length > maxLength ? text.substring(0, maxLength) : text;
};

const parseJSONResponse = <T>(text: string | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const extractKeywordFromTopic = (topic: string, maxWords: number): string => {
  const words = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  return words.length <= maxWords
    ? topic.toLowerCase().trim()
    : words.slice(0, maxWords).join(' ').trim();
};

const validateTopic = (topic: string): void => {
  if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
    throw new Error('Invalid topic: must be a non-empty string');
  }
  if (topic.length > 500) {
    throw new Error('Invalid topic: exceeds maximum length of 500 characters');
  }
};

const validateProductContext = (productContext: readonly string[] | undefined): void => {
  if (productContext === undefined) return;
  if (!Array.isArray(productContext)) {
    throw new Error('Invalid productContext: must be an array');
  }
  if (productContext.length > 50) {
    throw new Error('Invalid productContext: exceeds maximum length of 50 items');
  }
  for (const item of productContext) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error('Invalid productContext: all items must be non-empty strings');
    }
    if (item.length > 200) {
      throw new Error('Invalid productContext: item exceeds maximum length of 200 characters');
    }
  }
};

export class KeywordMiner {
  private readonly openai: OpenAI;
  private readonly limiter: RateLimiter;
  private readonly responseCache: Map<string, CacheEntry<KeywordCluster>>;
  private readonly inflight: Map<string, Promise<KeywordCluster>>;
  private cacheCleanupInterval?: number;

  private static readonly VALID_INTENTS: ReadonlyArray<KeywordIntent> = [
    'informational',
    'commercial',
    'navigational',
    'transactional',
  ] as const;
  private static readonly VALID_PRIORITIES: ReadonlyArray<'high' | 'medium' | 'low'> = [
    'high',
    'medium',
    'low',
  ] as const;
  private static readonly DEFAULT_INTENT: KeywordIntent = 'informational';
  private static readonly DEFAULT_PRIORITY = 'medium' as const;
  private static readonly DEFAULT_RELEVANCE_SCORE = 0.7;
  private static readonly DEFAULT_RELEVANCE_SCORE_HIGH = 0.8;
  private static readonly MIN_RELEVANCE_SCORE = 0;
  private static readonly MAX_RELEVANCE_SCORE = 1;
  private static readonly MIN_KEYWORD_LENGTH = 2;
  private static readonly MAX_KEYWORD_LENGTH = 4;
  private static readonly FALLBACK_RELEVANCE = 0.7;
  private static readonly PRIMARY_FALLBACK_RELEVANCE = 0.8;
  private static readonly MAX_CONTENT_LENGTH = 50000;
  private static readonly CACHE_TTL_MS = 30 * 60 * 1000;
  private static readonly CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly OPENAI_MAX_WAIT_MS = 60_000;
  private static readonly SERVICE_NAME = 'KeywordMiner';
  private static readonly DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffMultiplier: 2,
    retryableErrors: ['rate limit', 'timeout', 'server_error'] as const,
  } as const;

  private static readonly TRANSACTIONAL_PATTERN = /\b(buy|purchase|order|price|cost|cheap|discount|deal|sale|for sale)\b/;
  private static readonly COMMERCIAL_PATTERN = /\b(best|top|review|compare|vs|versus|alternative|recommend)\b/;
  private static readonly NAVIGATIONAL_PATTERN = /\b(login|sign in|official|website|homepage)\b/;
  private static readonly QUESTION_PATTERN = /^(what|how|why|when|where|who|which|is|are|can|should|will)\b/;

  constructor(apiKey: string) {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new Error('API key is required');
    }
    this.openai = new OpenAI({ apiKey });
    this.limiter = new RateLimiter({
      maxRequests: 10,
      windowMs: 1000,
      burst: 2,
      algorithm: 'token-bucket',
      keyPrefix: 'openai-keyword-miner',
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
      }, KeywordMiner.CACHE_CLEANUP_INTERVAL_MS) as unknown as number;
    }
  }

  destroy(): void {
    if (this.cacheCleanupInterval !== undefined && typeof globalThis !== 'undefined' && 'clearInterval' in globalThis) {
      clearInterval(this.cacheCleanupInterval);
    }
    this.responseCache.clear();
    this.inflight.clear();
  }

  async mineKeywords(topic: string, productContext?: readonly string[]): Promise<KeywordCluster> {
    const startTime = Date.now();
    validateTopic(topic);
    validateProductContext(productContext);

    const cacheKey = `keywords:${hashString(topic)}:${productContext ? hashString(productContext.join('|')) : ''}`;
    const cached = getCache(this.responseCache, cacheKey);
    if (cached) {
      structuredLog('info', KeywordMiner.SERVICE_NAME, 'Cache hit', { cacheKey });
      return cached;
    }

    const inflight = this.inflight.get(cacheKey);
    if (inflight) {
      structuredLog('info', KeywordMiner.SERVICE_NAME, 'Deduplicating request', { cacheKey });
      return inflight;
    }

    const promise = this.executeMining(topic, productContext, cacheKey, startTime);
    this.inflight.set(cacheKey, promise);
    return promise.finally(() => {
      this.inflight.delete(cacheKey);
    });
  }

  private async executeMining(
    topic: string,
    productContext: readonly string[] | undefined,
    cacheKey: string,
    startTime: number,
  ): Promise<KeywordCluster> {
    try {
      const allowed = await this.limiter.waitForToken('keyword-miner', KeywordMiner.OPENAI_MAX_WAIT_MS);
      if (!allowed) {
        throw new Error('Rate limit wait exceeded');
      }

      const primaryKeyword = await this.extractPrimaryKeyword(topic, productContext);
      const longTailKeywords = await this.generateLongTailKeywords(primaryKeyword.keyword, productContext);

      const result: KeywordCluster = {
        primaryKeyword,
        longTailKeywords,
        semanticVariations: [],
        paaQuestions: [],
        lsiKeywords: [],
        topicClusters: new Map(),
      };

      setCache(this.responseCache, cacheKey, result, KeywordMiner.CACHE_TTL_MS);

      const duration = Date.now() - startTime;
      structuredLog('info', KeywordMiner.SERVICE_NAME, 'Keywords mined', {
        topic: truncateText(topic, 100),
        primaryKeyword: primaryKeyword.keyword,
        longTailCount: longTailKeywords.length,
        durationMs: duration,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', KeywordMiner.SERVICE_NAME, 'Keyword mining failed', {
        topic: truncateText(topic, 100),
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      throw error;
    }
  }

  private async extractPrimaryKeyword(
    topic: string,
    productContext?: readonly string[],
  ): Promise<Keyword> {
    const staticPrefix = this.buildPrimaryKeywordPromptStaticPrefix();
    const variableContent = this.buildPrimaryKeywordVariableContent(topic, productContext);
    const prompt = truncateText(staticPrefix + variableContent, KeywordMiner.MAX_CONTENT_LENGTH);

    try {
      const response = await this.callOpenAI({
        model: 'gpt-5-mini',
        reasoning: { effort: 'medium' },
        text: { verbosity: 'medium' },
        responseFormat: { type: 'json_object' },
        promptCacheKey: 'primary-keyword-extractor',
        promptCacheRetention: '24h',
      }, prompt);

      const result = parseJSONResponse<PrimaryKeywordResponse>(response.output_text, {});
      return this.mapPrimaryKeyword(result, topic);
    } catch (error) {
      structuredLog('warn', KeywordMiner.SERVICE_NAME, 'Primary keyword extraction failed, using fallback', {
        topic: truncateText(topic, 100),
        error: error instanceof Error ? error.message : String(error),
      });
      return this.getFallbackPrimaryKeyword(topic);
    }
  }

  private async generateLongTailKeywords(
    primaryKeyword: string,
    productContext?: readonly string[],
  ): Promise<ReadonlyArray<Keyword>> {
    const staticPrefix = this.buildLongTailPromptStaticPrefix();
    const variableContent = this.buildLongTailVariableContent(primaryKeyword, productContext);
    const prompt = truncateText(staticPrefix + variableContent, KeywordMiner.MAX_CONTENT_LENGTH);

    try {
      const response = await this.callOpenAI({
        model: 'gpt-5-mini',
        reasoning: { effort: 'medium' },
        text: { verbosity: 'medium' },
        responseFormat: { type: 'json_object' },
        promptCacheKey: 'long-tail-keywords-generator',
        promptCacheRetention: '24h',
      }, prompt);

      const result = parseJSONResponse<KeywordsResponse>(response.output_text, {});
      const keywords = result.keywords || result.longTail || [];

      return this.mapKeywords(keywords);
    } catch (error) {
      structuredLog('warn', KeywordMiner.SERVICE_NAME, 'Long-tail keyword generation failed, using fallback', {
        primaryKeyword: truncateText(primaryKeyword, 100),
        error: error instanceof Error ? error.message : String(error),
      });
      return this.getFallbackLongTailKeywords(primaryKeyword);
    }
  }

  private validateIntent(intent: unknown): KeywordIntent {
    if (typeof intent === 'string' && KeywordMiner.VALID_INTENTS.includes(intent as KeywordIntent)) {
      return intent as KeywordIntent;
    }
    return KeywordMiner.DEFAULT_INTENT;
  }

  private validatePriority(priority: unknown): 'high' | 'medium' | 'low' {
    if (typeof priority === 'string' && KeywordMiner.VALID_PRIORITIES.includes(priority as 'high' | 'medium' | 'low')) {
      return priority as 'high' | 'medium' | 'low';
    }
    return KeywordMiner.DEFAULT_PRIORITY;
  }

  private inferIntent(keyword: string): KeywordIntent {
    const lower = keyword.toLowerCase();

    if (KeywordMiner.TRANSACTIONAL_PATTERN.test(lower)) {
      return 'transactional';
    }

    if (KeywordMiner.COMMERCIAL_PATTERN.test(lower)) {
      return 'commercial';
    }

    if (KeywordMiner.NAVIGATIONAL_PATTERN.test(lower)) {
      return 'navigational';
    }

    if (KeywordMiner.QUESTION_PATTERN.test(lower)) {
      return 'informational';
    }

    return KeywordMiner.DEFAULT_INTENT;
  }

  private mapPrimaryKeyword(result: PrimaryKeywordResponse, topic: string): Keyword {
    const fallbackKeyword = extractKeywordFromTopic(topic, KeywordMiner.MAX_KEYWORD_LENGTH);

    return {
      keyword: result.keyword || fallbackKeyword,
      intent: this.validateIntent(result.intent),
      relevanceScore: this.clampRelevanceScore(result.relevanceScore ?? KeywordMiner.PRIMARY_FALLBACK_RELEVANCE),
      priority: this.validatePriority(result.priority),
    };
  }

  private getFallbackPrimaryKeyword(topic: string): Keyword {
    const fallbackKeyword = extractKeywordFromTopic(topic, KeywordMiner.MAX_KEYWORD_LENGTH);

    return {
      keyword: fallbackKeyword,
      intent: KeywordMiner.DEFAULT_INTENT,
      relevanceScore: KeywordMiner.FALLBACK_RELEVANCE,
      priority: KeywordMiner.DEFAULT_PRIORITY,
    };
  }

  private mapKeywords(
    keywords: ReadonlyArray<KeywordItem | string>,
    defaultRelevance: number = KeywordMiner.DEFAULT_RELEVANCE_SCORE,
  ): ReadonlyArray<Keyword> {
    return keywords
      .filter((kw) => {
        if (typeof kw === 'string') {
          return kw.trim().length > 0;
        }
        return kw.keyword && kw.keyword.trim().length > 0;
      })
      .map((kw) => {
        if (typeof kw === 'string') {
          return {
            keyword: kw.trim(),
            intent: this.inferIntent(kw),
            relevanceScore: defaultRelevance,
            priority: KeywordMiner.DEFAULT_PRIORITY,
          };
        }

        return {
          keyword: (kw.keyword || '').trim(),
          intent: this.validateIntent(kw.intent),
          relevanceScore: this.clampRelevanceScore(kw.relevanceScore ?? defaultRelevance),
          priority: this.validatePriority(kw.priority),
          category: kw.category,
        };
      });
  }

  private getFallbackLongTailKeywords(primaryKeyword: string): ReadonlyArray<Keyword> {
    return [
      {
        keyword: `best ${primaryKeyword}`,
        intent: 'commercial' as KeywordIntent,
        relevanceScore: KeywordMiner.DEFAULT_RELEVANCE_SCORE_HIGH,
        priority: 'high' as const,
      },
      {
        keyword: `how to ${primaryKeyword}`,
        intent: KeywordMiner.DEFAULT_INTENT,
        relevanceScore: KeywordMiner.DEFAULT_RELEVANCE_SCORE_HIGH,
        priority: 'high' as const,
      },
      {
        keyword: `${primaryKeyword} guide`,
        intent: KeywordMiner.DEFAULT_INTENT,
        relevanceScore: KeywordMiner.FALLBACK_RELEVANCE,
        priority: KeywordMiner.DEFAULT_PRIORITY,
      },
      {
        keyword: `${primaryKeyword} tips`,
        intent: KeywordMiner.DEFAULT_INTENT,
        relevanceScore: KeywordMiner.FALLBACK_RELEVANCE,
        priority: KeywordMiner.DEFAULT_PRIORITY,
      },
    ];
  }

  private clampRelevanceScore(score: number): number {
    if (typeof score !== 'number' || isNaN(score)) {
      return KeywordMiner.DEFAULT_RELEVANCE_SCORE;
    }
    return Math.max(KeywordMiner.MIN_RELEVANCE_SCORE, Math.min(KeywordMiner.MAX_RELEVANCE_SCORE, score));
  }

  private async callOpenAI(config: PromptConfig, input: string): Promise<OpenAIResponse> {
    const normalizedInput = truncateText(input, KeywordMiner.MAX_CONTENT_LENGTH);

    const allowed = await this.limiter.waitForToken(config.model, KeywordMiner.OPENAI_MAX_WAIT_MS);
    if (!allowed) {
      throw new Error('OpenAI rate limit wait exceeded');
    }

    const start = nowMs();
    const result = await retry(
      async () => {
        const requestBody = {
          model: config.model,
          reasoning: config.reasoning,
          text: config.text,
          input: normalizedInput,
          response_format: config.responseFormat,
          prompt_cache_key: config.promptCacheKey,
          prompt_cache_retention: config.promptCacheRetention,
        };

        const response = await this.openai.responses.create(requestBody);
        return { output_text: (response as { output_text?: string }).output_text } as OpenAIResponse;
      },
      {
        ...KeywordMiner.DEFAULT_RETRY_OPTIONS,
        onRetry: (attempt, error) => {
          structuredLog('warn', KeywordMiner.SERVICE_NAME, 'OpenAI retry', {
            attempt,
            model: config.model,
            promptCacheKey: config.promptCacheKey,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      },
    );

    structuredLog('info', KeywordMiner.SERVICE_NAME, 'OpenAI call ok', {
      model: config.model,
      promptCacheKey: config.promptCacheKey,
      latencyMs: nowMs() - start,
    });

    return result;
  }

  private buildPrimaryKeywordPromptStaticPrefix(): string {
    return `You are an expert SEO keyword researcher specializing in primary keyword identification and search intent analysis.

## Role
Expert SEO keyword strategist with deep expertise in:
- Search volume analysis
- Keyword competitiveness assessment
- Search intent classification
- Keyword value optimization
- Content strategy alignment

## Task
Analyze the topic and identify the BEST primary keyword for SEO content.

## Primary Keyword Criteria
The primary keyword must be:
- The most searched and valuable search term related to this topic
- Not too generic (avoid single words unless highly specific)
- Not too long (typically 2-4 words optimal)
- The main search intent behind the topic
- Highly relevant to the core topic
- Balanced between search volume and competitiveness

## Output Format
Return ONLY valid JSON:
{
  "keyword": "the primary keyword string",
  "intent": "informational|commercial|navigational|transactional",
  "relevanceScore": 0.0-1.0,
  "priority": "high|medium|low"
}

## Constraints
- relevanceScore: 0.0-1.0 (how relevant to the topic)
- priority: Based on search volume potential and competitiveness

Topic: `;
  }

  private buildPrimaryKeywordVariableContent(topic: string, productContext?: readonly string[]): string {
    const contextStr = productContext && productContext.length > 0
      ? `\nProduct Context: ${productContext.slice(0, 10).join(', ')}`
      : '';
    return `${truncateText(topic, 400)}${contextStr}`;
  }

  private buildLongTailPromptStaticPrefix(): string {
    return `You are an expert SEO keyword researcher specializing in long-tail keyword discovery and optimization.

## Role
Expert SEO long-tail keyword strategist with deep expertise in:
- Long-tail keyword identification
- Search intent diversification
- Niche keyword opportunities
- Conversion-focused keyword research

## Task
Generate 10-15 high-quality long-tail keyword variations (3-6 words each) that cover diverse search patterns.

## Long-Tail Keyword Types
Include diverse types:
- Question-based: how, what, why, when, where, which
- Comparison: vs, versus, better than, compared to
- How-to and tutorial: step-by-step, guide, tutorial
- Buyer-intent: best, top, review, buy, purchase
- Location-based: if geographically relevant
- Product-specific: if product context provided

## Analysis Requirements
For each keyword, analyze:
- Search intent (informational, commercial, navigational, transactional)
- Relevance to the primary keyword (0-1 score)
- Priority based on search volume potential and competitiveness

## Output Format
Return ONLY valid JSON:
{
  "keywords": [
    {
      "keyword": "the long-tail keyword string",
      "intent": "informational|commercial|navigational|transactional",
      "relevanceScore": 0.0-1.0,
      "priority": "high|medium|low"
    }
  ]
}

## Constraints
- relevanceScore: 0.0-1.0 (how relevant to primary keyword)
- priority: Based on search volume potential and competitiveness

Primary keyword: `;
  }

  private buildLongTailVariableContent(primaryKeyword: string, productContext?: readonly string[]): string {
    const contextStr = productContext && productContext.length > 0
      ? `\nProduct context: ${productContext.slice(0, 10).join(', ')}`
      : '';
    return `${truncateText(primaryKeyword, 200)}${contextStr}`;
  }
}
