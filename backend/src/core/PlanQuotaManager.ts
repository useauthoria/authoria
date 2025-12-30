import type { SupabaseClient } from '@supabase/supabase-js';

export interface PlanLimits {
  readonly planId: string;
  readonly planName: string;
  readonly articleLimitMonthly: number;
  readonly articleLimitWeekly?: number;
  readonly priceMonthly: number;
  readonly trialDays?: number;
}

export interface EnforcementResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly planLimits?: PlanLimits;
  readonly quotaStatus?: {
    readonly articlesUsed: number;
    readonly articlesAllowed: number;
    readonly articlesRemaining: number;
  };
}

export interface QuotaStatus {
  readonly planName: string;
  readonly priceMonthly: number;
  readonly isTrial: boolean;
  readonly trialEndsAt: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly articlesUsed: number;
  readonly articlesAllowed: number;
  readonly articlesRemaining: number;
  readonly usagePercentage: number;
}

export interface QuotaCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly quotaStatus: QuotaStatus;
}

interface DatabasePlanRow {
  readonly id: string;
  readonly plan_name: string;
  readonly article_limit_monthly: number;
  readonly article_limit_weekly: number | null;
  readonly price_monthly: string | number;
  readonly trial_days: number | null;
}

interface DatabaseStoreRow {
  readonly id: string;
  readonly plan_id: string | null;
  readonly is_active: boolean;
  readonly is_paused: boolean;
  readonly trial_ends_at: string | null;
}

interface DatabaseQuotaStatus {
  readonly plan_name: string;
  readonly price_monthly: string | number;
  readonly is_trial: boolean;
  readonly trial_ends_at: string | null;
  readonly period_start: string;
  readonly period_end: string;
  readonly articles_used: number;
  readonly articles_allowed: number;
  readonly articles_remaining: number;
  readonly usage_percentage: number;
}

export class PlanQuotaManager {
  private readonly supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  async enforcePlanLimits(
    storeId: string,
    operation: 'create_article' | 'publish_article' | 'schedule_article',
  ): Promise<EnforcementResult> {
    // Check if store is active
    const store = await this.getStore(storeId);
    if (!store) {
      return {
        allowed: false,
        reason: 'Store not found',
      };
    }

    if (!store.is_active) {
      return {
        allowed: false,
        reason: 'Store is inactive',
      };
    }

    if (store.is_paused) {
      return {
        allowed: false,
        reason: 'Store is paused',
      };
    }

    // Check if trial has expired
    if (store.trial_ends_at) {
      const trialEnd = new Date(store.trial_ends_at);
      const now = new Date();
      if (now > trialEnd) {
        return {
          allowed: false,
          reason: 'Trial period has expired. Please upgrade to continue.',
        };
      }
    }

    // Get plan limits
    const planLimits = await this.getPlanLimits(store.plan_id);
    if (!planLimits) {
      return {
        allowed: false,
        reason: 'Plan not found or not configured',
      };
    }

    // Check quota based on operation type
    const usageType = operation === 'publish_article' ? 'published' : 'generated';
    const quotaCheck = await this.checkQuota(storeId, usageType);

    if (!quotaCheck.allowed) {
      return {
        allowed: false,
        reason: quotaCheck.reason,
        planLimits,
        quotaStatus: {
          articlesUsed: quotaCheck.quotaStatus.articlesUsed,
          articlesAllowed: quotaCheck.quotaStatus.articlesAllowed,
          articlesRemaining: quotaCheck.quotaStatus.articlesRemaining,
        },
      };
    }

    return {
      allowed: true,
      planLimits,
      quotaStatus: {
        articlesUsed: quotaCheck.quotaStatus.articlesUsed,
        articlesAllowed: quotaCheck.quotaStatus.articlesAllowed,
        articlesRemaining: quotaCheck.quotaStatus.articlesRemaining,
      },
    };
  }

  async checkQuota(storeId: string, usageType: 'generated' | 'published' = 'generated'): Promise<QuotaCheckResult> {
    const quotaStatus = await this.getQuotaStatus(storeId);

    if (!quotaStatus) {
      return {
        allowed: false,
        reason: 'Store not found or plan not configured',
        quotaStatus: this.getDefaultQuotaStatus(),
      };
    }

    const allowed = quotaStatus.articlesRemaining > 0;

    return {
      allowed,
      reason: allowed ? undefined : 'Article quota exceeded for current period',
      quotaStatus,
    };
  }

  async getQuotaStatus(storeId: string): Promise<QuotaStatus | null> {
    const { data, error } = await this.supabase.rpc('get_store_quota_status', {
      store_uuid: storeId,
    });

    if (error || !data) {
      return null;
    }

    const dbStatus = data as unknown as DatabaseQuotaStatus;

    return {
      planName: dbStatus.plan_name,
      priceMonthly: typeof dbStatus.price_monthly === 'string' ? parseFloat(dbStatus.price_monthly) : dbStatus.price_monthly,
      isTrial: dbStatus.is_trial,
      trialEndsAt: dbStatus.trial_ends_at,
      periodStart: dbStatus.period_start,
      periodEnd: dbStatus.period_end,
      articlesUsed: dbStatus.articles_used,
      articlesAllowed: dbStatus.articles_allowed,
      articlesRemaining: dbStatus.articles_remaining,
      usagePercentage: dbStatus.usage_percentage,
    };
  }

  async recordUsage(storeId: string, postId: string, usageType: 'generated' | 'published' = 'generated'): Promise<void> {
    const { error } = await this.supabase.rpc('record_article_usage', {
      store_uuid: storeId,
      post_uuid: postId,
      usage_type: usageType,
    });

    if (error) {
      throw new Error(`Failed to record article usage: ${error.message}`);
    }
  }

  private async getPlanLimits(planId: string | null): Promise<PlanLimits | null> {
    if (!planId) {
      return null;
    }

    const { data, error } = await this.supabase
      .from('plan_limits')
      .select('*')
      .eq('id', planId)
      .single();

    if (error || !data) {
      return null;
    }

    const plan = data as unknown as DatabasePlanRow;

    return {
      planId: plan.id,
      planName: plan.plan_name,
      articleLimitMonthly: plan.article_limit_monthly,
      articleLimitWeekly: plan.article_limit_weekly || undefined,
      priceMonthly: typeof plan.price_monthly === 'string' ? parseFloat(plan.price_monthly) : plan.price_monthly,
      trialDays: plan.trial_days || undefined,
    };
  }

  private async getStore(storeId: string): Promise<DatabaseStoreRow | null> {
    const { data, error } = await this.supabase
      .from('stores')
      .select('id, plan_id, is_active, is_paused, trial_ends_at')
      .eq('id', storeId)
      .single();

    if (error || !data) {
      return null;
    }

    return data as unknown as DatabaseStoreRow;
  }

  private getDefaultQuotaStatus(): QuotaStatus {
    return {
      planName: 'unknown',
      priceMonthly: 0,
      isTrial: false,
      trialEndsAt: null,
      periodStart: new Date().toISOString(),
      periodEnd: new Date().toISOString(),
      articlesUsed: 0,
      articlesAllowed: 0,
      articlesRemaining: 0,
      usagePercentage: 0,
    };
  }
}

// Export aliases for backward compatibility
export const PlanLimitsEnforcer = PlanQuotaManager;
export const QuotaManager = PlanQuotaManager;
