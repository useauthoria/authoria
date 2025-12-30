import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

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

export class ContentGraph {
  private readonly supabase: SupabaseClient;
  private readonly openai: OpenAI;
  private readonly embeddingCache: Map<string, readonly number[]>;
  private static readonly MAX_SOURCE_CONTEXT = 500;
  private static readonly DEFAULT_RELATED_LIMIT = 5;
  private static readonly MAX_INTERNAL_LINKS = 5;

  constructor(supabaseUrl: string, supabaseKey: string, openaiKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.openai = new OpenAI({ apiKey: openaiKey });
    this.embeddingCache = new Map();
  }

  async getRelatedContent(
    storeId: string,
    contentId: string,
    contentType: string,
    limit: number = ContentGraph.DEFAULT_RELATED_LIMIT,
    relationshipTypes?: readonly RelationshipType[],
  ): Promise<ReadonlyArray<ContentRelationship>> {
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

    const { data: related } = await query;

    if (!related) return [];

    return related.map((rel: DatabaseRelationship) => ({
      targetId: rel.target_id,
      targetType: rel.target_type,
      relationshipType: rel.relationship_type as RelationshipType,
      strength: this.parseStrength(rel.strength),
      context: rel.metadata?.context || '',
      metadata: rel.metadata,
    }));
  }

  async rebuildInternalLinks(storeId: string, postId: string): Promise<ReadonlyArray<InternalLink>> {
    const related = await this.getRelatedContent(storeId, postId, 'post', 10);
    const sourcePostContent = await this.getPostContent(storeId, postId);
    const sourcePost = sourcePostContent ? { content: sourcePostContent.content } : null;

    if (!sourcePost || related.length === 0) {
      return [];
    }

    const links = await Promise.all(
      related.slice(0, ContentGraph.MAX_INTERNAL_LINKS).map(async (rel, index) => {
        const anchorText = await this.generateAnchorText(
          sourcePost.content,
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

    await this.supabase
      .from('blog_posts')
      .update({ internal_links: links })
      .eq('id', postId);

    return links;
  }
  private async getPostContent(storeId: string, contentId: string): Promise<ContentItem | null> {
    const { data: post } = await this.supabase
      .from('blog_posts')
      .select('id, title, content, keywords, primary_keyword, structured_data')
      .eq('id', contentId)
      .eq('store_id', storeId)
      .single();

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
    const targetPost = await this.getPostForAnchor(targetId);

    if (!targetPost) {
      return 'Related article';
    }

    const staticPrefix = this.buildAnchorTextStaticPrefix(relationshipType, context, targetPost);
    const variableContent = sourceContent.substring(0, ContentGraph.MAX_SOURCE_CONTEXT);
    const prompt = staticPrefix + variableContent;

    try {
      const response = await this.callOpenAI({
        model: 'gpt-5-nano',
        reasoning: { effort: 'low' },
        text: { verbosity: 'low' },
        responseFormat: { type: 'json_object' },
        promptCacheKey: 'anchor-text-generation',
        promptCacheRetention: '24h',
      }, prompt);

      const result = JSON.parse(response.output_text || '{}') as AnchorTextResponse;
      return result.anchorText || targetPost.title || 'Related article';
    } catch {
      return targetPost.title || 'Related article';
    }
  }

  private async getPostForAnchor(postId: string): Promise<{ readonly title: string; readonly excerpt?: string | null; readonly content?: string | null } | null> {
    const { data: post } = await this.supabase
      .from('blog_posts')
      .select('title, content, excerpt')
      .eq('id', postId)
      .single();

    return post;
  }

  private buildAnchorTextStaticPrefix(
    relationshipType: RelationshipType,
    context: string,
    targetPost: { readonly title: string; readonly excerpt?: string | null; readonly content?: string | null },
  ): string {
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
Excerpt: ${targetPost.excerpt || targetPost.content?.substring(0, 200) || ''}

Source content context: `;
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

  private parseStrength(strength: number | string): number {
    return typeof strength === 'string' ? parseFloat(strength) : strength;
  }
}
