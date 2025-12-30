import type { SupabaseClient } from '@supabase/supabase-js';
import { ShopifyAPI } from '../integrations/ShopifyClient';
import OpenAI from 'openai';

export interface ProductMention {
  readonly productId: string;
  readonly productTitle: string;
  readonly productHandle: string;
  readonly variantId?: string;
  readonly variantTitle?: string;
  readonly context: string;
  readonly position: number;
  readonly linkText: string;
  readonly relevanceScore: number;
  readonly isInStock: boolean;
  readonly availability?: 'in_stock' | 'low_stock' | 'out_of_stock';
}

export interface ProductRelevanceScore {
  readonly productId: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly matchingKeywords: readonly string[];
  readonly semanticSimilarity: number;
}

export interface InsertionPoint {
  readonly position: number;
  readonly context: string;
  readonly topic: string;
  readonly confidence: number;
  readonly sentenceBefore?: string;
  readonly sentenceAfter?: string;
}

export interface ProductVariant {
  readonly id: string;
  readonly title: string;
  readonly price: string;
  readonly sku?: string;
  readonly inventoryQuantity?: number;
  readonly available: boolean;
  readonly option1?: string;
  readonly option2?: string;
  readonly option3?: string;
}

interface Product {
  readonly id: string | number;
  readonly title: string;
  readonly handle: string;
  readonly description?: string;
  readonly body_html?: string;
  readonly product_type?: string;
  readonly tags?: readonly string[];
  readonly price?: string | number;
  readonly variants_price_min?: string | number;
  readonly variants?: ReadonlyArray<ProductVariantData>;
  readonly images?: ReadonlyArray<unknown>;
  readonly collections?: ReadonlyArray<unknown>;
  readonly published_at?: string | null;
}

interface ProductVariantData {
  readonly id?: string | number;
  readonly title?: string;
  readonly price?: string | number;
  readonly sku?: string;
  readonly inventory_quantity?: number;
  readonly available?: boolean;
  readonly option1?: string;
  readonly option2?: string;
  readonly option3?: string;
}

interface DatabaseProductRow {
  readonly shopify_product_id: string | number;
  readonly title: string;
  readonly handle: string;
  readonly description?: string;
  readonly product_type?: string;
  readonly tags?: readonly string[] | null;
  readonly price?: string | number;
  readonly variants?: ReadonlyArray<ProductVariantData> | null;
  readonly images?: ReadonlyArray<unknown> | null;
  readonly collections?: ReadonlyArray<unknown> | null;
  readonly is_published?: boolean;
}

interface OpenAIRelevanceResponse {
  readonly reasons?: readonly string[];
}

interface OpenAIInsertionResponse {
  readonly insertionPoints?: ReadonlyArray<{
    readonly position?: number;
    readonly context?: string;
    readonly topic?: string;
    readonly sentenceBefore?: string;
    readonly sentenceAfter?: string;
    readonly confidence?: number;
  }>;
}

interface OpenAIResponse {
  readonly output_text?: string;
}

interface EmbeddingResponse {
  readonly data: ReadonlyArray<{
    readonly embedding: readonly number[];
  }>;
}

interface InjectionResult {
  readonly content: string;
  readonly mentions: readonly ProductMention[];
}

export class ProductContextEngine {
  private readonly shopifyAPI: ShopifyAPI;
  private readonly supabase?: SupabaseClient;
  private readonly openai?: OpenAI;
  private readonly products: Map<string, Product>;
  private readonly embeddingCache: Map<string, readonly number[]>;
  private static readonly EMBEDDING_MODEL = 'text-embedding-3-small';
  private static readonly EMBEDDING_DIMENSION = 1536;
  private static readonly CONTENT_LENGTH_LIMIT = 8000;
  private static readonly CONTENT_EXCERPT_LENGTH = 1000;
  private static readonly PRODUCT_DESCRIPTION_LIMIT = 500;
  private static readonly PRODUCT_TEXT_LIMIT = 2000;
  private static readonly PRODUCT_SUMMARY_DESCRIPTION_LIMIT = 300;
  private static readonly INSERTION_CONTEXT_LIMIT = 500;
  private static readonly MIN_RELEVANCE_THRESHOLD = 0.3;
  private static readonly MIN_CONFIDENCE_THRESHOLD = 0.4;
  private static readonly KEYWORD_SCORE_WEIGHT = 0.3;
  private static readonly SEMANTIC_SCORE_WEIGHT = 0.7;
  private static readonly MAX_SCORE = 1.0;
  private static readonly LOW_STOCK_THRESHOLD = 10;
  private static readonly DEFAULT_SCORE = 0.5;
  private static readonly DEFAULT_CONFIDENCE = 0.6;
  private static readonly BASIC_CONFIDENCE = 0.4;
  private static readonly MIN_SEMANTIC_SIMILARITY = 0.3;
  private static readonly CACHE_KEY_PREFIX = 'embedding:';
  private static readonly CACHE_KEY_LENGTH = 100;

  private static readonly MENTION_TEMPLATES: readonly string[] = [
    'Check out our {title}',
    'Learn more about {title}',
    'Discover {title}',
    'Explore {title}',
  ];

  private static readonly RELEVANCE_PROMPT_PREFIX = `You are an expert SEO specialist specializing in product-content relevance analysis and semantic matching.

## Role
Expert product relevance analyst with deep expertise in:
- Semantic content matching
- Product-content alignment
- User intent fulfillment
- Contextual relevance scoring

## Task
Analyze why this product might be relevant to this blog post content.

## Product
Product: `;

  private static readonly INSERTION_PROMPT_PREFIX = `You are an expert content strategist specializing in natural product mention placement and content integration.

## Role
Expert content integration strategist with deep expertise in:
- Natural content flow
- Product mention optimization
- User experience optimization
- SEO-friendly content integration

## Task
Analyze this blog post content and identify `;

  private static readonly MENTION_PROMPT_PREFIX = `You are an expert content writer specializing in natural product integration and contextual mentions.

## Role
Expert product mention writer with deep expertise in:
- Natural content integration
- Contextual product mentions
- User experience optimization
- Non-intrusive product placement

## Task
Generate a natural, contextual product mention for this blog post.

## Product
Product: `;

  constructor(
    shopifyAPI: ShopifyAPI,
    supabase?: SupabaseClient,
    openaiKey?: string,
  ) {
    this.shopifyAPI = shopifyAPI;
    this.supabase = supabase;
    this.products = new Map();
    this.embeddingCache = new Map();
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
    }
  }

  async injectProductMentions(
    content: string,
    title: string,
    keywords: readonly string[] = [],
    maxMentions: number = 3,
    storeId?: string,
  ): Promise<InjectionResult> {
    const availableProducts = await this.getAvailableProducts(storeId);
    if (availableProducts.length === 0) {
      return { content, mentions: [] };
    }

    const scoredProducts = await this.scoreProductRelevance(
      content,
      title,
      keywords,
      availableProducts,
    );

    const selectedProducts = this.selectTopProducts(scoredProducts, maxMentions);
    if (selectedProducts.length === 0) {
      return { content, mentions: [] };
    }

    const insertionPoints = await this.findSmartInsertionPoints(content, selectedProducts.length);
    return this.injectMentionsAtPoints(content, selectedProducts, availableProducts, insertionPoints);
  }

  private async getAvailableProducts(storeId?: string): Promise<ReadonlyArray<Product>> {
    if (storeId && this.supabase) {
      const cachedProducts = await this.getCachedProducts(storeId);
      if (cachedProducts && cachedProducts.length > 0) {
        return this.mapCachedProducts(cachedProducts);
      }
    }

    return this.filterAvailableProducts(Array.from(this.products.values()));
  }

  private async getCachedProducts(storeId: string): Promise<ReadonlyArray<DatabaseProductRow> | null> {
    const { data } = await this.supabase!
      .from('products_cache')
      .select('*')
      .eq('store_id', storeId)
      .eq('is_published', true);

    return data as ReadonlyArray<DatabaseProductRow> | null;
  }

  private mapCachedProducts(cachedProducts: ReadonlyArray<DatabaseProductRow>): ReadonlyArray<Product> {
    return cachedProducts
      .filter((p) => this.isProductAvailable(p))
      .map((p) => ({
        id: p.shopify_product_id,
        title: p.title,
        handle: p.handle,
        description: p.description,
        product_type: p.product_type || undefined,
        tags: p.tags || undefined,
        price: p.price,
        variants: p.variants || undefined,
        images: p.images || undefined,
        collections: p.collections || undefined,
      }));
  }

  private isProductAvailable(product: DatabaseProductRow): boolean {
    if (!product.variants || !Array.isArray(product.variants)) {
      return true;
    }

    return product.variants.some(
      (v) => (v.inventory_quantity && v.inventory_quantity > 0) || v.available === true,
    );
  }

  private filterAvailableProducts(products: ReadonlyArray<Product>): ReadonlyArray<Product> {
    return products.filter((product) => {
      if (!product.variants || !Array.isArray(product.variants)) {
        return true;
      }

      return product.variants.some(
        (v) => (v.inventory_quantity && v.inventory_quantity > 0) || v.available !== false,
      );
    });
  }

  private async scoreProductRelevance(
    content: string,
    title: string,
    keywords: readonly string[],
    products: ReadonlyArray<Product>,
  ): Promise<ReadonlyArray<ProductRelevanceScore>> {
    if (!this.openai || products.length === 0) {
      return this.getDefaultScores(products);
    }

    const contentText = `${title}\n\n${content.substring(0, ProductContextEngine.CONTENT_LENGTH_LIMIT)}`;
    const contentEmbedding = await this.createEmbedding(contentText);

    const scores = await Promise.all(
      products.map(async (product) => {
        const productText = this.buildProductText(product);
        const productEmbedding = await this.createEmbedding(productText);
        const semanticSimilarity = this.cosineSimilarity(contentEmbedding, productEmbedding);
        const matchingKeywords = this.findMatchingKeywords(keywords, product);
        const relevanceReasons = await this.generateRelevanceReasons(
          content,
          title,
          product,
          semanticSimilarity,
          matchingKeywords,
        );

        return this.calculateProductScore(
          product,
          semanticSimilarity,
          matchingKeywords,
          relevanceReasons,
        );
      }),
    );

    return scores;
  }

  private getDefaultScores(products: ReadonlyArray<Product>): ReadonlyArray<ProductRelevanceScore> {
    return products.map((p) => ({
      productId: p.id.toString(),
      score: ProductContextEngine.DEFAULT_SCORE,
      reasons: [],
      matchingKeywords: [],
      semanticSimilarity: ProductContextEngine.DEFAULT_SCORE,
    }));
  }

  private findMatchingKeywords(keywords: readonly string[], product: Product): readonly string[] {
    return keywords.filter((keyword) => {
      const lowerKeyword = keyword.toLowerCase();
      return (
        product.title.toLowerCase().includes(lowerKeyword) ||
        product.product_type?.toLowerCase().includes(lowerKeyword) ||
        (product.tags || []).some((tag) => tag.toLowerCase().includes(lowerKeyword)) ||
        (product.description || '').toLowerCase().includes(lowerKeyword)
      );
    });
  }

  private calculateProductScore(
    product: Product,
    semanticSimilarity: number,
    matchingKeywords: readonly string[],
    relevanceReasons: readonly string[],
  ): ProductRelevanceScore {
    let keywordScore = 0;
    if (matchingKeywords.length > 0) {
      keywordScore = Math.min(matchingKeywords.length * 0.15, ProductContextEngine.KEYWORD_SCORE_WEIGHT);
    }

    const semanticScore = semanticSimilarity * ProductContextEngine.SEMANTIC_SCORE_WEIGHT;
    
    let availabilityBonus = 0;
    if (product.variants && Array.isArray(product.variants)) {
      const hasStock = product.variants.some(
        (v) => (v.inventory_quantity && v.inventory_quantity > 0) || v.available === true,
      );
      if (hasStock) {
        availabilityBonus = 0.1;
      }
    }

    const titleMatchBonus = this.calculateTitleMatchBonus(product.title, matchingKeywords);
    
    const finalScore = Math.min(
      keywordScore + semanticScore + availabilityBonus + titleMatchBonus,
      ProductContextEngine.MAX_SCORE,
    );

    return {
      productId: product.id.toString(),
      score: finalScore,
      reasons: relevanceReasons,
      matchingKeywords,
      semanticSimilarity,
    };
  }

  private calculateTitleMatchBonus(title: string, matchingKeywords: readonly string[]): number {
    if (matchingKeywords.length === 0) return 0;
    
    const titleLower = title.toLowerCase();
    const exactMatches = matchingKeywords.filter((kw) => titleLower.includes(kw.toLowerCase()));
    
    return Math.min(exactMatches.length * 0.05, 0.15);
  }

  private async generateRelevanceReasons(
    content: string,
    title: string,
    product: Product,
    semanticSimilarity: number,
    matchingKeywords: readonly string[],
  ): Promise<readonly string[]> {
    if (!this.openai || semanticSimilarity < ProductContextEngine.MIN_SEMANTIC_SIMILARITY) {
      return [];
    }

    const prompt = this.buildRelevancePrompt(content, title, product, semanticSimilarity, matchingKeywords);

    try {
      const response = await this.callOpenAI(prompt, 'product-relevance-reasons', true);
      const result = JSON.parse(response.output_text || '{}') as OpenAIRelevanceResponse;
      return result.reasons || [];
    } catch {
      return [];
    }
  }

  private async findSmartInsertionPoints(
    content: string,
    count: number,
  ): Promise<ReadonlyArray<InsertionPoint>> {
    if (!this.openai) {
      return this.findBasicInsertionPoints(content, count);
    }

    const prompt = this.buildInsertionPrompt(content, count);

    try {
      const response = await this.callOpenAI(prompt, 'product-insertion-points', true);
      const result = JSON.parse(response.output_text || '{}') as OpenAIInsertionResponse;
      const points = this.mapInsertionPoints(result.insertionPoints || [], content);

      if (points.length < count) {
        const basicPoints = this.findBasicInsertionPoints(content, count - points.length);
        return [...points, ...basicPoints].slice(0, count).sort((a, b) => a.position - b.position);
      }

      return points.slice(0, count).sort((a, b) => a.position - b.position);
    } catch {
      return this.findBasicInsertionPoints(content, count);
    }
  }

  private findBasicInsertionPoints(content: string, count: number): ReadonlyArray<InsertionPoint> {
    const points: InsertionPoint[] = [];
    const paragraphMatches = Array.from(content.matchAll(/\n\n/g));

    for (const match of paragraphMatches) {
      if (points.length >= count) break;
      const position = (match.index || 0) + match[0].length;
      points.push({
        position,
        context: 'Paragraph break',
        topic: 'general',
        confidence: ProductContextEngine.DEFAULT_CONFIDENCE,
      });
    }

    while (points.length < count) {
      const spacing = Math.floor(content.length / (count + 1));
      const position = spacing * (points.length + 1);
      points.push({
        position,
        context: 'Even distribution',
        topic: 'general',
        confidence: ProductContextEngine.BASIC_CONFIDENCE,
      });
    }

    return points.slice(0, count).sort((a, b) => a.position - b.position);
  }

  private mapInsertionPoints(
    points: ReadonlyArray<{
      readonly position?: number;
      readonly context?: string;
      readonly topic?: string;
      readonly sentenceBefore?: string;
      readonly sentenceAfter?: string;
      readonly confidence?: number;
    }>,
    content: string,
  ): ReadonlyArray<InsertionPoint> {
    return points
      .filter(
        (p) =>
          p.position !== undefined &&
          p.position >= 0 &&
          p.position <= content.length &&
          (p.confidence || 0) > ProductContextEngine.MIN_CONFIDENCE_THRESHOLD,
      )
      .map((p) => ({
        position: p.position!,
        context: p.context || '',
        topic: p.topic || p.context || '',
        confidence: p.confidence || ProductContextEngine.DEFAULT_CONFIDENCE,
        sentenceBefore: p.sentenceBefore,
        sentenceAfter: p.sentenceAfter,
      }));
  }

  private selectTopProducts(
    scoredProducts: ReadonlyArray<ProductRelevanceScore>,
    maxMentions: number,
  ): ReadonlyArray<ProductRelevanceScore> {
    return scoredProducts
      .filter((p) => p.score > ProductContextEngine.MIN_RELEVANCE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxMentions);
  }

  private async injectMentionsAtPoints(
    content: string,
    selectedProducts: ReadonlyArray<ProductRelevanceScore>,
    availableProducts: ReadonlyArray<Product>,
    insertionPoints: ReadonlyArray<InsertionPoint>,
  ): Promise<InjectionResult> {
    const mentions: ProductMention[] = [];
    let modifiedContent = content;
    let positionOffset = 0;

    for (let index = 0; index < selectedProducts.length && index < insertionPoints.length; index++) {
      const scoredProduct = selectedProducts[index];
      const product = availableProducts.find((p) => p.id.toString() === scoredProduct.productId);
      if (!product) continue;

      const insertionPoint = insertionPoints[index];
      const adjustedPosition = insertionPoint.position + positionOffset;
      const selectedVariant = this.selectBestVariant(product);
      const mention = await this.createProductMention(
        product,
        selectedVariant,
        adjustedPosition,
        insertionPoint.context,
        scoredProduct.score,
      );

      mentions.push(mention);

      const before = modifiedContent.substring(0, adjustedPosition);
      const after = modifiedContent.substring(adjustedPosition);
      const mentionText = this.formatMentionText(mention, insertionPoint.context);

      modifiedContent = `${before}${mentionText} ${after}`;
      positionOffset += mentionText.length + 1;
    }

    return { content: modifiedContent, mentions };
  }

  private async createProductMention(
    product: Product,
    variant: ProductVariant | null,
    position: number,
    context: string,
    relevanceScore: number,
  ): Promise<ProductMention> {
    const inventoryStatus = this.getInventoryStatus(product, variant);
    const isInStock = inventoryStatus === 'in_stock' || inventoryStatus === 'low_stock';
    const mentionContext = await this.generateContextualMention(
      product,
      variant,
      context,
      relevanceScore,
    );
    const linkText = variant ? `${product.title} - ${variant.title}` : product.title;

    return {
      productId: product.id.toString(),
      productTitle: product.title,
      productHandle: product.handle,
      variantId: variant?.id,
      variantTitle: variant?.title,
      context: mentionContext,
      position,
      linkText,
      relevanceScore,
      isInStock,
      availability: inventoryStatus,
    };
  }

  private async generateContextualMention(
    product: Product,
    variant: ProductVariant | null,
    insertionContext: string,
    relevanceScore: number,
  ): Promise<string> {
    if (!this.openai) {
      return this.getRandomMentionTemplate(product.title);
    }

    const prompt = this.buildMentionPrompt(product, variant, insertionContext, relevanceScore);

    try {
      const response = await this.callOpenAI(prompt, 'product-mention-generation');
      return response.output_text?.trim() || this.getDefaultMention(product.title);
    } catch {
      return this.getDefaultMention(product.title);
    }
  }

  private selectBestVariant(product: Product): ProductVariant | null {
    if (!product.variants || !Array.isArray(product.variants) || product.variants.length === 0) {
      return null;
    }

    if (product.variants.length === 1) {
      return this.mapVariantToProductVariant(product.variants[0], product.title);
    }

    const inStockVariants = product.variants.filter(
      (v) => (v.inventory_quantity && v.inventory_quantity > 0) || v.available === true,
    );

    if (inStockVariants.length > 0) {
      return this.mapVariantToProductVariant(inStockVariants[0], product.title, true);
    }

    return this.mapVariantToProductVariant(product.variants[0], product.title, false);
  }

  private mapVariantToProductVariant(
    variant: ProductVariantData,
    productTitle: string,
    available: boolean = true,
  ): ProductVariant {
    return {
      id: variant.id?.toString() || '',
      title: variant.title || productTitle,
      price: variant.price?.toString() || '0',
      sku: variant.sku,
      inventoryQuantity: variant.inventory_quantity,
      available: available && variant.available !== false,
      option1: variant.option1,
      option2: variant.option2,
      option3: variant.option3,
    };
  }

  private getInventoryStatus(
    product: Product,
    variant: ProductVariant | null,
  ): 'in_stock' | 'low_stock' | 'out_of_stock' {
    if (variant) {
      const quantity = variant.inventoryQuantity || 0;
      if (quantity === 0 && !variant.available) {
        return 'out_of_stock';
      }
      if (quantity > 0 && quantity < ProductContextEngine.LOW_STOCK_THRESHOLD) {
        return 'low_stock';
      }
      return 'in_stock';
    }

    if (product.variants && Array.isArray(product.variants)) {
      const totalQuantity = product.variants.reduce(
        (sum, v) => sum + (v.inventory_quantity || 0),
        0,
      );
      if (totalQuantity === 0) {
        return 'out_of_stock';
      }
      if (totalQuantity < ProductContextEngine.LOW_STOCK_THRESHOLD) {
        return 'low_stock';
      }
    }

    return 'in_stock';
  }

  private formatMentionText(mention: ProductMention, context: string): string {
    let linkUrl = `/products/${mention.productHandle}`;
    if (mention.variantId) {
      linkUrl += `?variant=${mention.variantId}`;
    }

    let mentionText = mention.context;

    if (mention.availability === 'out_of_stock') {
      mentionText += ' (Currently out of stock)';
    } else if (mention.availability === 'low_stock') {
      mentionText += ' (Limited availability)';
    }

    return `${mentionText} [${mention.linkText}](${linkUrl})`;
  }

  private async createEmbedding(text: string): Promise<readonly number[]> {
    const cacheKey = `${ProductContextEngine.CACHE_KEY_PREFIX}${text.substring(0, ProductContextEngine.CACHE_KEY_LENGTH)}`;
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    if (!this.openai) {
      return new Array(ProductContextEngine.EMBEDDING_DIMENSION).fill(0);
    }

    try {
      const response = await this.openai.embeddings.create({
        model: ProductContextEngine.EMBEDDING_MODEL,
        input: text.substring(0, ProductContextEngine.CONTENT_LENGTH_LIMIT),
      }) as unknown as EmbeddingResponse;

      const embedding = response.data[0]?.embedding || [];
      this.embeddingCache.set(cacheKey, embedding);
      return embedding;
    } catch {
      return new Array(ProductContextEngine.EMBEDDING_DIMENSION).fill(0);
    }
  }

  private cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length) return 0;

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

  private buildProductText(product: Product): string {
    const parts = [
      product.title,
      product.product_type || '',
      product.description || '',
      (product.tags || []).join(' '),
    ].filter(Boolean);

    return parts.join(' ').substring(0, ProductContextEngine.PRODUCT_TEXT_LIMIT);
  }

  private buildRelevancePrompt(
    content: string,
    title: string,
    product: Product,
    semanticSimilarity: number,
    matchingKeywords: readonly string[],
  ): string {
    return `${ProductContextEngine.RELEVANCE_PROMPT_PREFIX}${product.title}
${product.description ? `Description: ${product.description.substring(0, ProductContextEngine.PRODUCT_DESCRIPTION_LIMIT)}` : ''}
${product.product_type ? `Type: ${product.product_type}` : ''}

## Blog Post Context
Blog Post Title: ${title}
Content Excerpt: ${content.substring(0, ProductContextEngine.CONTENT_EXCERPT_LENGTH)}

## Analysis Data
Semantic Similarity Score: ${semanticSimilarity.toFixed(2)}
Matching Keywords: ${matchingKeywords.join(', ') || 'None'}

## Requirements
Provide 2-3 brief reasons (one sentence each) why this product is relevant to the content.
Focus on:
- Semantic connections
- Keyword alignment
- User intent fulfillment
- Contextual fit

## Output Format
Return ONLY valid JSON array of strings:
["reason1", "reason2", "reason3"]`;
  }

  private buildInsertionPrompt(content: string, count: number): string {
    return `${ProductContextEngine.INSERTION_PROMPT_PREFIX}${count} optimal insertion points for product mentions.

## Placement Criteria
Product mentions should be placed:
- After relevant topics are discussed (not before context is established)
- At natural paragraph or section transitions
- Where the content naturally relates to products
- Not too close together (spread throughout the article)
- Where they add value to the reader's experience

## Content
Content:
${content}

## Analysis Requirements
For each insertion point, provide:
1. Character position: Exact index in the content
2. Context: What topic/section it's in
3. Sentence before: The sentence immediately before the insertion point
4. Sentence after: The sentence immediately after the insertion point
5. Confidence score: 0-1 for how natural the insertion is

## Output Format
Return ONLY valid JSON array:
[
  {
    "position": 1234,
    "context": "Discussion about X topic",
    "sentenceBefore": "sentence before insertion",
    "sentenceAfter": "sentence after insertion",
    "confidence": 0.85
  }
]`;
  }

  private buildMentionPrompt(
    product: Product,
    variant: ProductVariant | null,
    insertionContext: string,
    relevanceScore: number,
  ): string {
    return `${ProductContextEngine.MENTION_PROMPT_PREFIX}${product.title}
${variant ? `Variant: ${variant.title}` : ''}
${product.description ? `Description: ${product.description.substring(0, ProductContextEngine.PRODUCT_SUMMARY_DESCRIPTION_LIMIT)}` : ''}

## Insertion Context
Insertion Context: ${insertionContext.substring(0, ProductContextEngine.INSERTION_CONTEXT_LIMIT)}
Relevance Score: ${relevanceScore.toFixed(2)}

## Requirements
Generate a brief (10-15 words), natural product mention that:
- Fits the context seamlessly
- Sounds like a natural part of the blog post
- Does NOT sound like an advertisement
- Adds value to the reader's experience
- Maintains content flow and readability

## Output Format
Return ONLY the mention text. No quotes, no markdown, no explanations.`;
  }

  private async callOpenAI(
    prompt: string,
    cacheKey: string,
    useJsonFormat: boolean = false,
  ): Promise<OpenAIResponse> {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }

    return await this.openai.responses.create({
      model: 'gpt-5-mini',
      reasoning: { effort: 'low' },
      text: { verbosity: useJsonFormat ? 'medium' : 'low' },
      input: prompt,
      response_format: useJsonFormat ? { type: 'json_object' } : undefined,
      prompt_cache_key: cacheKey,
      prompt_cache_retention: '24h',
    }) as OpenAIResponse;
  }

  private getDefaultMention(title: string): string {
    return `Learn more about ${title}`;
  }

  private getRandomMentionTemplate(title: string): string {
    const template =
      ProductContextEngine.MENTION_TEMPLATES[
        Math.floor(Math.random() * ProductContextEngine.MENTION_TEMPLATES.length)
      ];
    return template.replace('{title}', title);
  }

}
