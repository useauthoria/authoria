import type { SupabaseClient } from '@supabase/supabase-js';
import { BlogComposer } from './BlogComposer';
import type { ToneMatrix, BrandDNA } from './BrandManager';

export interface QueuedArticle {
  readonly id: string;
  readonly store_id: string;
  readonly title: string;
  readonly status: 'queued';
  readonly queue_position: number;
  readonly scheduled_publish_at: string | null;
  readonly created_at: string;
  readonly content?: string;
}

export interface QueueMetrics {
  readonly currentCount: number;
  readonly targetCount: number;
  readonly planName: string;
  readonly needsRefill: boolean;
}

interface DatabasePostRow {
  readonly id: string;
  readonly store_id: string;
  readonly title: string;
  readonly content: string;
  readonly status: string;
  readonly queue_position: number | null;
  readonly scheduled_publish_at: string | null;
  readonly created_at: string;
}

interface PlanRow {
  readonly plan_name: string;
}

interface StoreRow {
  readonly id: string;
  readonly plan_id: string | null;
  readonly brand_dna: unknown;
  readonly tone_matrix: unknown;
  readonly content_preferences: unknown;
}

export class ArticlesQueue {
  private readonly supabase: SupabaseClient;
  private readonly blogComposer?: BlogComposer;

  constructor(
    supabase: SupabaseClient,
    openaiApiKey?: string,
    toneMatrix?: ToneMatrix,
    brandDNA?: BrandDNA,
  ) {
    this.supabase = supabase;
    if (openaiApiKey && toneMatrix && brandDNA) {
      this.blogComposer = new BlogComposer(openaiApiKey, toneMatrix, brandDNA);
    }
  }

  /**
   * Get queue size for a plan
   */
  getQueueSizeForPlan(planName: string | null): number {
    switch (planName) {
      case 'starter':
        return 3;
      case 'publisher':
        return 7;
      case 'authority':
        return 14;
      default:
        return 3; // Default to starter
    }
  }

  /**
   * Get queue metrics for a store
   */
  async getQueueMetrics(storeId: string): Promise<QueueMetrics | null> {
    // Get store's plan and check if store is active
    const { data: store, error: storeError } = await this.supabase
      .from('stores')
      .select('plan_id, is_active, is_paused, trial_ends_at, plan_limits(plan_name)')
      .eq('id', storeId)
      .single();

    if (storeError || !store) {
      return null;
    }

    const storeData = store as unknown as {
      plan_id: string | null;
      is_active: boolean;
      is_paused: boolean;
      trial_ends_at: string | null;
      plan_limits: PlanRow | null;
    };

    // If store is not active or is paused, return metrics indicating no queue needed
    if (!storeData.is_active || storeData.is_paused) {
      return {
        currentCount: 0,
        targetCount: 0,
        planName: 'inactive',
        needsRefill: false,
      };
    }

    // Check if trial has expired
    if (storeData.trial_ends_at) {
      const trialEnd = new Date(storeData.trial_ends_at);
      const now = new Date();
      if (now > trialEnd) {
        return {
          currentCount: 0,
          targetCount: 0,
          planName: 'trial_expired',
          needsRefill: false,
        };
      }
    }

    const planName = storeData.plan_limits?.plan_name || null;
    const targetCount = this.getQueueSizeForPlan(planName);

    // Count current queued articles
    const { count, error: countError } = await this.supabase
      .from('blog_posts')
      .select('*', { count: 'exact', head: true })
      .eq('store_id', storeId)
      .eq('status', 'queued');

    if (countError) {
      return null;
    }

    return {
      currentCount: count || 0,
      targetCount,
      planName: planName || 'unknown',
      needsRefill: (count || 0) < targetCount,
    };
  }

  /**
   * Get all queued articles for a store, ordered by queue_position
   */
  async getQueue(storeId: string): Promise<readonly QueuedArticle[]> {
    const { data, error } = await this.supabase
      .from('blog_posts')
      .select('id, store_id, title, status, queue_position, scheduled_publish_at, created_at, content')
      .eq('store_id', storeId)
      .eq('status', 'queued')
      .order('queue_position', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true });

    if (error || !data) {
      return [];
    }

    return (data as unknown as DatabasePostRow[]).map((row) => ({
      id: row.id,
      store_id: row.store_id,
      title: row.title,
      status: 'queued' as const,
      queue_position: row.queue_position || 0,
      scheduled_publish_at: row.scheduled_publish_at,
      created_at: row.created_at,
      content: row.content || undefined,
    }));
  }

  /**
   * Generate a smart title for a queued article
   */
  async generateQueueTitle(
    storeId: string,
    existingTitles: readonly string[] = [],
  ): Promise<string> {
    // Get store data for context
    const { data: store, error: storeError } = await this.supabase
      .from('stores')
      .select('brand_dna, tone_matrix, content_preferences')
      .eq('id', storeId)
      .single();

    if (storeError || !store || !this.blogComposer) {
      // Fallback: Generate a simple title
      return this.generateFallbackTitle(existingTitles);
    }

    const storeData = store as StoreRow;
    const brandDNA = (storeData.brand_dna || {}) as BrandDNA;
    const toneMatrix = (storeData.tone_matrix || {}) as ToneMatrix;
    const contentPreferences = (storeData.content_preferences || {}) as {
      topic_preferences?: readonly string[];
      keyword_focus?: readonly string[];
      content_angles?: readonly string[];
    };

    // Generate topic ideas based on brand context
    const topic = this.generateTopicFromContext(brandDNA, contentPreferences, existingTitles);

    // Generate keywords if available
    const keywords = contentPreferences.keyword_focus || [];

    // Generate outline (simplified for title generation)
    const outline = await this.generateOutlineForTitle(topic, keywords);

    // Generate title using a simpler approach - we'll create a smart title based on context
    // For now, use the topic directly with variations to ensure uniqueness
    if (existingTitles.includes(topic)) {
      const variations = [
        `Complete Guide to ${topic}`,
        `Ultimate ${topic} Guide`,
        `${topic}: Expert Insights`,
        `Mastering ${topic}`,
        `Everything About ${topic}`,
      ];
      
      for (const variation of variations) {
        if (!existingTitles.includes(variation)) {
          return variation;
        }
      }
      
      // If all variations are taken, add a number
      let counter = 2;
      while (existingTitles.includes(`${topic} ${counter}`)) {
        counter++;
      }
      return `${topic} ${counter}`;
    }
    
    return topic;
  }

  /**
   * Generate a topic from brand context
   */
  private generateTopicFromContext(
    brandDNA: BrandDNA,
    contentPreferences: {
      topic_preferences?: readonly string[];
      keyword_focus?: readonly string[];
      content_angles?: readonly string[];
    },
    existingTitles: readonly string[],
  ): string {
    // Use topic preferences if available
    if (contentPreferences.topic_preferences && contentPreferences.topic_preferences.length > 0) {
      const topics = contentPreferences.topic_preferences.filter(
        (t) => !existingTitles.some((et) => et.toLowerCase().includes(t.toLowerCase())),
      );
      if (topics.length > 0) {
        return topics[Math.floor(Math.random() * topics.length)] || topics[0]!;
      }
    }

    // Use keywords if available
    if (contentPreferences.keyword_focus && contentPreferences.keyword_focus.length > 0) {
      const keywords = contentPreferences.keyword_focus.filter(
        (k) => !existingTitles.some((et) => et.toLowerCase().includes(k.toLowerCase())),
      );
      if (keywords.length > 0) {
        return keywords[Math.floor(Math.random() * keywords.length)] || keywords[0]!;
      }
    }

    // Use brand name if available
    if (brandDNA && typeof brandDNA === 'object' && 'brandName' in brandDNA) {
      const brandName = (brandDNA as { brandName?: string }).brandName;
      if (brandName) {
        return `Complete Guide to ${brandName}`;
      }
    }

    // Fallback to generic topic
    return 'Latest Trends and Insights';
  }

  /**
   * Generate a simplified outline for title generation
   */
  private async generateOutlineForTitle(
    topic: string,
    keywords: readonly string[],
  ): Promise<readonly string[]> {
    // Return a simple default outline for title generation
    return [
      'Introduction',
      'Understanding the Topic',
      'Key Insights',
      'Best Practices',
      'Conclusion',
    ];
  }

  /**
   * Generate fallback title if AI generation fails
   */
  private generateFallbackTitle(existingTitles: readonly string[]): string {
    const baseTitles = [
      'Complete Guide to Success',
      'Expert Tips and Insights',
      'Ultimate Resource Guide',
      'Best Practices Explained',
      'Professional Insights',
      'Industry Trends',
      'Expert Advice',
      'Comprehensive Guide',
    ];

    const available = baseTitles.filter(
      (title) => !existingTitles.some((et) => et.toLowerCase().includes(title.toLowerCase())),
    );

    if (available.length > 0) {
      return available[Math.floor(Math.random() * available.length)] || available[0]!;
    }

    return `Article ${existingTitles.length + 1}`;
  }

  /**
   * Create a new queued article with a generated title
   */
  async createQueuedArticle(storeId: string): Promise<QueuedArticle | null> {
    // Get existing queue to avoid duplicates
    const existingQueue = await this.getQueue(storeId);
    const existingTitles = existingQueue.map((a) => a.title);

    // Generate title
    const title = await this.generateQueueTitle(storeId, existingTitles);

    // Get next queue position
    const maxPosition = existingQueue.reduce((max, article) => {
      return Math.max(max, article.queue_position);
    }, -1);
    const nextPosition = maxPosition + 1;

    // Create the queued article (title only, no content)
    const { data, error } = await this.supabase
      .from('blog_posts')
      .insert({
        store_id: storeId,
        title,
        content: '', // Empty content for queued articles
        status: 'queued',
        queue_position: nextPosition,
      })
      .select('id, store_id, title, status, queue_position, scheduled_publish_at, created_at')
      .single();

    if (error || !data) {
      return null;
    }

    const row = data as unknown as DatabasePostRow;
    return {
      id: row.id,
      store_id: row.store_id,
      title: row.title,
      status: 'queued' as const,
      queue_position: row.queue_position || 0,
      scheduled_publish_at: row.scheduled_publish_at,
      created_at: row.created_at,
    };
  }

  /**
   * Auto-refill queue to target size
   */
  async refillQueue(storeId: string): Promise<number> {
    const metrics = await this.getQueueMetrics(storeId);
    if (!metrics) {
      return 0;
    }

    // Don't refill if store is inactive, paused, or trial expired
    if (metrics.targetCount === 0 || !metrics.needsRefill) {
      return 0;
    }

    const needed = metrics.targetCount - metrics.currentCount;
    if (needed <= 0) {
      return 0;
    }

    let created = 0;

    for (let i = 0; i < needed; i++) {
      const article = await this.createQueuedArticle(storeId);
      if (article) {
        created++;
      }
      // Add small delay to avoid rate limiting
      if (i < needed - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return created;
  }

  /**
   * Reorder queue articles
   */
  async reorderQueue(storeId: string, articleIds: readonly string[]): Promise<boolean> {
    // Update queue positions based on new order
    const updates = articleIds.map((id, index) => ({
      id,
      queue_position: index,
    }));

    for (const update of updates) {
      const { error } = await this.supabase
        .from('blog_posts')
        .update({ queue_position: update.queue_position })
        .eq('id', update.id)
        .eq('store_id', storeId)
        .eq('status', 'queued');

      if (error) {
        console.error('Failed to update queue position:', error);
        return false;
      }
    }

    return true;
  }

  /**
   * Regenerate title for a queued article
   */
  async regenerateTitle(storeId: string, articleId: string): Promise<string | null> {
    // Get existing queue titles to avoid duplicates
    const existingQueue = await this.getQueue(storeId);
    const existingTitles = existingQueue.filter((a) => a.id !== articleId).map((a) => a.title);

    // Generate new title
    const newTitle = await this.generateQueueTitle(storeId, existingTitles);

    // Update article
    const { error } = await this.supabase
      .from('blog_posts')
      .update({ title: newTitle })
      .eq('id', articleId)
      .eq('store_id', storeId)
      .eq('status', 'queued');

    if (error) {
      return null;
    }

    return newTitle;
  }

  /**
   * Remove article from queue (when it's scheduled or deleted)
   */
  async removeFromQueue(storeId: string, articleId: string): Promise<boolean> {
    // The article status will be changed by the caller, we just need to reorder remaining items
    // Get current queue
    const queue = await this.getQueue(storeId);
    const remaining = queue.filter((a) => a.id !== articleId);

    // Reorder remaining items
    if (remaining.length > 0) {
      const articleIds = remaining.map((a) => a.id);
      return await this.reorderQueue(storeId, articleIds);
    }

    return true;
  }
}

