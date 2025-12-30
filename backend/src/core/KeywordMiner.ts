import OpenAI from 'openai';

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

export class KeywordMiner {
  private readonly openai: OpenAI;
  private static readonly VALID_INTENTS: ReadonlyArray<KeywordIntent> = [
    'informational',
    'commercial',
    'navigational',
    'transactional',
  ];
  private static readonly VALID_PRIORITIES: ReadonlyArray<'high' | 'medium' | 'low'> = [
    'high',
    'medium',
    'low',
  ];
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

  private static readonly TRANSACTIONAL_PATTERN = /\b(buy|purchase|order|price|cost|cheap|discount|deal|sale|for sale)\b/;
  private static readonly COMMERCIAL_PATTERN = /\b(best|top|review|compare|vs|versus|alternative|recommend)\b/;
  private static readonly NAVIGATIONAL_PATTERN = /\b(login|sign in|official|website|homepage)\b/;
  private static readonly QUESTION_PATTERN = /^(what|how|why|when|where|who|which|is|are|can|should|will)\b/;

  constructor(apiKey: string) {
    this.openai = new OpenAI({ apiKey });
  }

  async mineKeywords(topic: string, productContext?: readonly string[]): Promise<KeywordCluster> {
    const primaryKeyword = await this.extractPrimaryKeyword(topic, productContext);
    const longTailKeywords = await this.generateLongTailKeywords(primaryKeyword.keyword, productContext);

    return {
      primaryKeyword,
      longTailKeywords,
      semanticVariations: [],
      paaQuestions: [],
      lsiKeywords: [],
      topicClusters: new Map(),
    };
  }

  private async extractPrimaryKeyword(
    topic: string,
    productContext?: readonly string[],
  ): Promise<Keyword> {
    const staticPrefix = this.buildPrimaryKeywordPromptStaticPrefix();
    const variableContent = this.buildPrimaryKeywordVariableContent(topic, productContext);
    const prompt = staticPrefix + variableContent;

    try {
      const response = await this.callOpenAI({
        model: 'gpt-5-mini',
        reasoning: { effort: 'medium' },
        text: { verbosity: 'medium' },
        responseFormat: { type: 'json_object' },
        promptCacheKey: 'primary-keyword-extractor',
        promptCacheRetention: '24h',
      }, prompt);

      const result = JSON.parse(response.output_text || '{}') as PrimaryKeywordResponse;
      return this.mapPrimaryKeyword(result, topic);
    } catch {
      return this.getFallbackPrimaryKeyword(topic);
    }
  }

  private async generateLongTailKeywords(
    primaryKeyword: string,
    productContext?: readonly string[],
  ): Promise<ReadonlyArray<Keyword>> {
    const staticPrefix = this.buildLongTailPromptStaticPrefix();
    const variableContent = this.buildLongTailVariableContent(primaryKeyword, productContext);
    const prompt = staticPrefix + variableContent;

    try {
      const response = await this.callOpenAI({
        model: 'gpt-5-mini',
        reasoning: { effort: 'medium' },
        text: { verbosity: 'medium' },
        responseFormat: { type: 'json_object' },
        promptCacheKey: 'long-tail-keywords-generator',
        promptCacheRetention: '24h',
      }, prompt);

      const result = JSON.parse(response.output_text || '{}') as KeywordsResponse;
      const keywords = result.keywords || result.longTail || [];

      return this.mapKeywords(keywords);
    } catch {
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
    const words = topic.toLowerCase().split(/\s+/);
    const fallbackKeyword = words.length <= KeywordMiner.MAX_KEYWORD_LENGTH
      ? topic.toLowerCase()
      : words.slice(0, KeywordMiner.MAX_KEYWORD_LENGTH).join(' ');

    return {
      keyword: result.keyword || fallbackKeyword,
      intent: this.validateIntent(result.intent),
      relevanceScore: this.clampRelevanceScore(result.relevanceScore ?? KeywordMiner.PRIMARY_FALLBACK_RELEVANCE),
      priority: this.validatePriority(result.priority),
    };
  }

  private getFallbackPrimaryKeyword(topic: string): Keyword {
    const words = topic.toLowerCase().split(/\s+/);
    const fallbackKeyword = words.length <= KeywordMiner.MAX_KEYWORD_LENGTH
      ? topic.toLowerCase()
      : words.slice(0, KeywordMiner.MAX_KEYWORD_LENGTH).join(' ');

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
    return keywords.map((kw) => {
      if (typeof kw === 'string') {
        return {
          keyword: kw,
          intent: this.inferIntent(kw),
          relevanceScore: defaultRelevance,
          priority: KeywordMiner.DEFAULT_PRIORITY,
        };
      }

      return {
        keyword: kw.keyword || '',
        intent: this.validateIntent(kw.intent),
        relevanceScore: this.clampRelevanceScore(kw.relevanceScore ?? defaultRelevance),
        priority: this.validatePriority(kw.priority),
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
    return Math.max(KeywordMiner.MIN_RELEVANCE_SCORE, Math.min(KeywordMiner.MAX_RELEVANCE_SCORE, score));
  }

  private async callOpenAI(config: PromptConfig, input: string): Promise<OpenAIResponse> {
    return await this.openai.responses.create({
      model: config.model,
      reasoning: config.reasoning,
      text: config.text,
      input,
      response_format: config.responseFormat,
      prompt_cache_key: config.promptCacheKey,
      prompt_cache_retention: config.promptCacheRetention,
    }) as OpenAIResponse;
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
    return `${topic}
${productContext ? `\nProduct Context: ${productContext.join(', ')}` : ''}`;
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
    return `${primaryKeyword}
${productContext ? `\nProduct context: ${productContext.join(', ')}` : ''}`;
  }

}
