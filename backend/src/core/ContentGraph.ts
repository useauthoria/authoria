import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { RateLimiter } from '../utils/rate-limiter.ts';
import { retry } from '../utils/error-handling.ts';

export type RelationshipType =
  | 'semantic'
  | 'product_mention'
  | 'topic_cluster'
  | 'keyword_overlap'
  | 'category'
  | 'complementary'
  | 'related_product'
  | 'internal_link';

export interface InternalLink {
  readonly target_id: string;
  readonly anchor_text: string;
  readonly position?: number;
  readonly context?: string;
  readonly relationship_type: RelationshipType;
  readonly strength: number;
}

export interface ContentRelationship {
  readonly targetId: string;
  readonly targetType: string;
  readonly relationshipType: RelationshipType;
  readonly strength: number;
  readonly context: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface ContentItem {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly type: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface DatabasePost {
  readonly id: string;
  readonly title: string;
  readonly content?: string | null;
  readonly keywords?: readonly string[] | null;
  readonly primary_keyword?: string | null;
  readonly structured_data?: unknown;
  readonly excerpt?: string | null;
  readonly internal_links?: unknown;
}

interface DatabaseRelationship {
  readonly target_id: string;
  readonly target_type: string;
  readonly relationship_type: string;
  readonly strength: number | string;
  readonly metadata?: {
    readonly context?: string;
    readonly [key: string]: unknown;
  } | null;
}

interface AnchorTextResponse {
  readonly anchorText?: string;
  readonly reasoning?: string;
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

interface PostForAnchor {
  readonly title: string;
  readonly excerpt?: string | null;
  readonly content?: string | null;
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

const isValidRelationshipType = (type: string): type is RelationshipType => {
  const validTypes: readonly RelationshipType[] = [
    'semantic',
    'product_mention',
    'topic_cluster',
    'keyword_overlap',
    'category',
    'complementary',
    'related_product',
    'internal_link',
  ];
  return validTypes.includes(type as RelationshipType);
};

const parseStrength = (strength: number | string): number => {
  if (typeof strength === 'number') {
    return isNaN(strength) ? 0 : strength;
  }
  const parsed = parseFloat(strength);
  return isNaN(parsed) ? 0 : parsed;
};

const validateStoreId = (storeId: string): void => {
  if (!storeId || typeof storeId !== 'string' || storeId.trim().length === 0) {
    throw new Error('Invalid storeId: must be a non-empty string');
  }
};

const validateContentId = (contentId: string): void => {
  if (!contentId || typeof contentId !== 'string' || contentId.trim().length === 0) {
    throw new Error('Invalid contentId: must be a non-empty string');
  }
};

const validateLimit = (limit: number): void => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Invalid limit: must be an integer between 1 and 100');
  }
};

export class ContentGraph {
  private readonly supabase: SupabaseClient;
  private readonly openai: OpenAI;
  private readonly limiter: RateLimiter;
  private readonly responseCache: Map<string, CacheEntry<OpenAIResponse>>;
  private readonly inflight: Map<string, Promise<OpenAIResponse>>;
  private cacheCleanupInterval?: number;

  private static readonly MAX_SOURCE_CONTEXT = 500;
  private static readonly DEFAULT_RELATED_LIMIT = 5;
  private static readonly MAX_INTERNAL_LINKS = 5;
  private static readonly MAX_CONTENT_LENGTH = 50000;
  private static readonly OPENAI_CACHE_TTL_MS = 10 * 60 * 1000;
  private static readonly OPENAI_MAX_WAIT_MS = 60_000;
  private static readonly CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly SERVICE_NAME = 'ContentGraph';
  private static readonly DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffMultiplier: 2,
    retryableErrors: ['rate limit', 'timeout', 'server_error'] as const,
  } as const;

  constructor(
    supabaseOrUrl: SupabaseClient | string,
    supabaseKeyOrOpenaiKey: string,
    openaiKey?: string,
  ) {
    if (typeof supabaseOrUrl === 'string') {
      if (!openaiKey) {
        throw new Error('ContentGraph constructor requires openaiKey when supabaseUrl is provided');
      }
      this.supabase = createClient(supabaseOrUrl, supabaseKeyOrOpenaiKey);
      this.openai = new OpenAI({ apiKey: openaiKey });
    } else {
      this.supabase = supabaseOrUrl;
      this.openai = new OpenAI({ apiKey: supabaseKeyOrOpenaiKey });
    }
    this.limiter = new RateLimiter({
      maxRequests: 10,
      windowMs: 1000,
      burst: 2,
      algorithm: 'token-bucket',
      keyPrefix: 'openai-content-graph',
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
      }, ContentGraph.CACHE_CLEANUP_INTERVAL_MS) as unknown as number;
    }
  }

  destroy(): void {
    if (this.cacheCleanupInterval !== undefined && typeof globalThis !== 'undefined' && 'clearInterval' in globalThis) {
      clearInterval(this.cacheCleanupInterval);
    }
    this.responseCache.clear();
    this.inflight.clear();
  }

  async getRelatedContent(
    storeId: string,
    contentId: string,
    contentType: string,
    limit: number = ContentGraph.DEFAULT_RELATED_LIMIT,
    relationshipTypes?: readonly RelationshipType[],
  ): Promise<ReadonlyArray<ContentRelationship>> {
    validateStoreId(storeId);
    validateContentId(contentId);
    validateLimit(limit);

    if (relationshipTypes && relationshipTypes.length > 0) {
      const invalidTypes = relationshipTypes.filter((t) => !isValidRelationshipType(t));
      if (invalidTypes.length > 0) {
        throw new Error(`Invalid relationship types: ${invalidTypes.join(', ')}`);
      }
    }

    let query = this.supabase
      .from('content_graph')
      .select('target_id, target_type, relationship_type, strength, metadata')
      .eq('store_id', storeId)
      .eq('source_type', contentType)
      .eq('source_id', contentId)
      .order('strength', { ascending: false })
      .limit(limit);

    if (relationshipTypes && relationshipTypes.length > 0) {
      query = query.in('relationship_type', [...relationshipTypes]);
    }

    const { data: related, error } = await query;

    if (error) {
      structuredLog('error', ContentGraph.SERVICE_NAME, 'Failed to fetch related content', {
        storeId,
        contentId,
        contentType,
        error: error.message,
      });
      throw new Error(`Failed to fetch related content: ${error.message}`);
    }

    if (!related || !Array.isArray(related)) return [];

    return related
      .filter((rel): rel is DatabaseRelationship => 
        rel !== null && typeof rel === 'object' && typeof rel.target_id === 'string'
      )
      .map((rel) => {
        const relationshipType = isValidRelationshipType(rel.relationship_type)
          ? rel.relationship_type
          : 'semantic';

        return {
          targetId: rel.target_id,
          targetType: rel.target_type,
          relationshipType,
          strength: parseStrength(rel.strength),
          context: rel.metadata?.context || '',
          metadata: rel.metadata || undefined,
        };
      });
  }

  async rebuildInternalLinks(storeId: string, postId: string): Promise<ReadonlyArray<InternalLink>> {
    validateStoreId(storeId);
    validateContentId(postId);

    const [related, sourcePostContent] = await Promise.all([
      this.getRelatedContent(storeId, postId, 'post', 10),
      this.getPostContent(storeId, postId),
    ]);

    if (!sourcePostContent || related.length === 0) {
      return [];
    }

    const linksToGenerate = related.slice(0, ContentGraph.MAX_INTERNAL_LINKS);
    const links = await Promise.all(
      linksToGenerate.map(async (rel, index) => {
        const anchorText = await this.generateAnchorText(
          sourcePostContent.content,
          rel.targetId,
          rel.relationshipType,
          rel.context,
        );

        return {
          target_id: rel.targetId,
          anchor_text: anchorText,
          position: index,
          context: rel.context,
          relationship_type: rel.relationshipType,
          strength: rel.strength,
        };
      }),
    );

    const { error } = await this.supabase
      .from('blog_posts')
      .update({ internal_links: links })
      .eq('id', postId)
      .eq('store_id', storeId);

    if (error) {
      structuredLog('error', ContentGraph.SERVICE_NAME, 'Failed to update internal links', {
        storeId,
        postId,
        error: error.message,
      });
      throw new Error(`Failed to update internal links: ${error.message}`);
    }

    return links;
  }

  private async getPostContent(storeId: string, contentId: string): Promise<ContentItem | null> {
    const { data: post, error } = await this.supabase
      .from('blog_posts')
      .select('id, title, content, keywords, primary_keyword, structured_data')
      .eq('id', contentId)
      .eq('store_id', storeId)
      .single();

    if (error) {
      structuredLog('warn', ContentGraph.SERVICE_NAME, 'Failed to fetch post content', {
        storeId,
        contentId,
        error: error.message,
      });
      return null;
    }

    if (!post) return null;

    return {
      id: post.id,
      title: post.title,
      content: post.content || '',
      type: 'post',
      metadata: {
        keywords: post.keywords || [],
        primaryKeyword: post.primary_keyword,
        structuredData: post.structured_data,
      },
    };
  }

  private async generateAnchorText(
    sourceContent: string,
    targetId: string,
    relationshipType: RelationshipType,
    context: string,
  ): Promise<string> {
    if (!sourceContent || sourceContent.trim().length === 0) {
      return 'Related article';
    }

    const targetPost = await this.getPostForAnchor(targetId);

    if (!targetPost || !targetPost.title) {
      return 'Related article';
    }

    const staticPrefix = this.buildAnchorTextStaticPrefix(relationshipType, context, targetPost);
    const variableContent = truncateText(sourceContent, ContentGraph.MAX_SOURCE_CONTEXT);
    const prompt = staticPrefix + variableContent;

    if (prompt.length > ContentGraph.MAX_CONTENT_LENGTH) {
      structuredLog('warn', ContentGraph.SERVICE_NAME, 'Prompt too long, truncating', {
        originalLength: prompt.length,
        maxLength: ContentGraph.MAX_CONTENT_LENGTH,
      });
    }

    try {
      const response = await this.callOpenAI({
        model: 'gpt-5-nano',
        reasoning: { effort: 'low' },
        text: { verbosity: 'low' },
        responseFormat: { type: 'json_object' },
        promptCacheKey: 'anchor-text-generation',
        promptCacheRetention: '24h',
      }, truncateText(prompt, ContentGraph.MAX_CONTENT_LENGTH));

      const result = parseJSONResponse<AnchorTextResponse>(response.output_text, {});
      return result.anchorText || targetPost.title || 'Related article';
    } catch (error) {
      structuredLog('error', ContentGraph.SERVICE_NAME, 'Failed to generate anchor text', {
        targetId,
        relationshipType,
        error: error instanceof Error ? error.message : String(error),
      });
      return targetPost.title || 'Related article';
    }
  }

  private async getPostForAnchor(postId: string): Promise<PostForAnchor | null> {
    const { data: post, error } = await this.supabase
      .from('blog_posts')
      .select('title, content, excerpt')
      .eq('id', postId)
      .single();

    if (error) {
      structuredLog('warn', ContentGraph.SERVICE_NAME, 'Failed to fetch post for anchor', {
        postId,
        error: error.message,
      });
      return null;
    }

    return post;
  }

  private buildAnchorTextStaticPrefix(
    relationshipType: RelationshipType,
    context: string,
    targetPost: PostForAnchor,
  ): string {
    const excerpt = targetPost.excerpt || truncateText(targetPost.content || '', 200);
    return `You are an SEO and content linking expert. Generate natural, contextual anchor text for an internal link.
The anchor text should be:
- Natural and contextual (not generic like "click here")
- SEO-friendly (relevant to target content)
- 2-5 words typically
- Matches the tone and style of the source content
- Uses relevant phrases from the target content when appropriate

Relationship context: ${context}
Relationship type: ${relationshipType}

Target content:
Title: ${targetPost.title}
Excerpt: ${excerpt}

Source content context: `;
  }

  private async callOpenAI(config: PromptConfig, input: string): Promise<OpenAIResponse> {
    const normalizedInput = truncateText(input, ContentGraph.MAX_CONTENT_LENGTH);
    const cacheKey = `${config.model}:${config.promptCacheKey}:${normalizedInput.substring(0, 100)}`;
    const cached = getCache(this.responseCache, cacheKey);
    if (cached) {
      return cached;
    }

    const inflight = this.inflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const promise = (async (): Promise<OpenAIResponse> => {
      const allowed = await this.limiter.waitForToken(config.model, ContentGraph.OPENAI_MAX_WAIT_MS);
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
          ...ContentGraph.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, error) => {
            structuredLog('warn', ContentGraph.SERVICE_NAME, 'OpenAI retry', {
              attempt,
              model: config.model,
              promptCacheKey: config.promptCacheKey,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        },
      );

      setCache(this.responseCache, cacheKey, result, ContentGraph.OPENAI_CACHE_TTL_MS);
      structuredLog('info', ContentGraph.SERVICE_NAME, 'OpenAI call ok', {
        model: config.model,
        promptCacheKey: config.promptCacheKey,
        latencyMs: nowMs() - start,
      });
      return result;
    })().catch((error) => {
      structuredLog('error', ContentGraph.SERVICE_NAME, 'OpenAI call failed', {
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
