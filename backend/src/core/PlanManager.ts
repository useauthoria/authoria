import type { SupabaseClient } from '@supabase/supabase-js';
import { retry } from '../utils/error-handling.ts';

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

export interface PlanTransition {
  readonly fromPlanId: string | null;
  readonly toPlanId: string;
  readonly reason: 'upgrade' | 'downgrade' | 'trial_start' | 'trial_expired' | 'subscription_cancelled' | 'subscription_activated';
  readonly subscriptionId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TrialStatus {
  readonly isActive: boolean;
  readonly isExpired: boolean;
  readonly daysRemaining: number;
  readonly startedAt: string | null;
  readonly endsAt: string | null;
  readonly gracePeriodEndsAt: string | null;
}

export interface QuotaEnforcementResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly quotaStatus: {
    readonly articlesUsed: number;
    readonly articlesAllowed: number;
    readonly articlesRemaining: number;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly usagePercentage: number;
  };
  readonly trialStatus?: TrialStatus;
  readonly lockAcquired: boolean;
}

export interface StorePlanStatus {
  readonly storeId: string;
  readonly planId: string;
  readonly planName: string;
  readonly subscriptionId: string | null;
  readonly isActive: boolean;
  readonly isPaused: boolean;
  readonly trialStatus: TrialStatus;
  readonly quotaStatus: {
    readonly articlesUsed: number;
    readonly articlesAllowed: number;
    readonly articlesRemaining: number;
    readonly periodStart: string;
    readonly periodEnd: string;
  };
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
  readonly subscription_id: string | null;
  readonly is_active: boolean;
  readonly is_paused: boolean;
  readonly trial_started_at: string | null;
  readonly trial_ends_at: string | null;
  readonly created_at: string;
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

type LogLevel = 'info' | 'warn' | 'error';

type OperationType = 'create_article' | 'publish_article' | 'schedule_article';
type UsageType = 'generated' | 'published';
type TransitionReason = 'upgrade' | 'downgrade' | 'trial_start' | 'trial_expired' | 'subscription_cancelled' | 'subscription_activated';

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

const validateStoreId = (storeId: string): void => {
  if (!storeId || typeof storeId !== 'string' || storeId.trim().length === 0) {
    throw new Error('Invalid storeId: must be a non-empty string');
  }
};

const validateCorrelationId = (correlationId: string): void => {
  if (!correlationId || typeof correlationId !== 'string' || correlationId.trim().length === 0) {
    throw new Error('Invalid correlationId: must be a non-empty string');
  }
};

const validateOperation = (operation: string): operation is OperationType => {
  return operation === 'create_article' || operation === 'publish_article' || operation === 'schedule_article';
};

const validateUsageType = (usageType: string): usageType is UsageType => {
  return usageType === 'generated' || usageType === 'published';
};

const validateTransitionReason = (reason: string): reason is TransitionReason => {
  const validReasons: readonly TransitionReason[] = [
    'upgrade',
    'downgrade',
    'trial_start',
    'trial_expired',
    'subscription_cancelled',
    'subscription_activated',
  ];
  return validReasons.includes(reason as TransitionReason);
};

const validateTrialDays = (trialDays: number): void => {
  if (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 365) {
    throw new Error('Invalid trialDays: must be an integer between 1 and 365');
  }
};

const parsePrice = (price: string | number): number => {
  return typeof price === 'string' ? parseFloat(price) : price;
};

const calculateDaysRemaining = (endDate: Date, now: Date): number => {
  const diff = endDate.getTime() - now.getTime();
  return diff > 0 ? Math.ceil(diff / (24 * 60 * 60 * 1000)) : 0;
};

const DEFAULT_TRIAL_DAYS = 14;
const TRIAL_GRACE_PERIOD_DAYS = 3;
const LOCK_TIMEOUT_MS = 30000;
const LOCK_OPERATION_QUOTA_CHECK = 'quota_check';
const LOCK_OPERATION_PLAN_UPDATE = 'plan_update';
const LOCK_OPERATION_TRIAL_UPDATE = 'trial_update';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const GRACE_PERIOD_CREATION_WINDOW_MS = 60 * 60 * 1000;

export class PlanManager {
  private readonly supabase: SupabaseClient;
  private readonly lockTableName = 'plan_operation_locks';
  private readonly auditTableName = 'plan_audit_log';
  private readonly gracePeriodColumn = 'grace_period_ends_at';

  private static readonly SERVICE_NAME = 'PlanManager';
  private static readonly DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffMultiplier: 2,
    retryableErrors: ['rate limit', 'timeout', 'server_error'] as const,
  } as const;

  constructor(supabase: SupabaseClient) {
    if (!supabase) {
      throw new Error('SupabaseClient is required');
    }
    this.supabase = supabase;
  }

  async enforcePlanLimits(
    storeId: string,
    operation: OperationType,
  ): Promise<EnforcementResult> {
    const startTime = Date.now();
    validateStoreId(storeId);
    if (!validateOperation(operation)) {
      throw new Error(`Invalid operation: ${operation}`);
    }

    try {
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

      const planLimits = await this.getPlanLimits(store.plan_id);
      if (!planLimits) {
        return {
          allowed: false,
          reason: 'Plan not found or not configured',
        };
      }

      const usageType: UsageType = operation === 'publish_article' ? 'published' : 'generated';
      const quotaCheck = await this.checkQuota(storeId, usageType);

      const duration = Date.now() - startTime;
      structuredLog('info', PlanManager.SERVICE_NAME, 'Plan limits enforced', {
        storeId,
        operation,
        allowed: quotaCheck.allowed,
        durationMs: duration,
      });

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
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', PlanManager.SERVICE_NAME, 'Plan limits enforcement failed', {
        storeId,
        operation,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      throw error;
    }
  }

  async checkQuota(storeId: string, usageType: UsageType = 'generated'): Promise<QuotaCheckResult> {
    validateStoreId(storeId);
    if (!validateUsageType(usageType)) {
      throw new Error(`Invalid usageType: ${usageType}`);
    }

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
    validateStoreId(storeId);

    try {
      const { data, error } = await retry(
        async () => {
          return await this.supabase.rpc('get_store_quota_status', {
            store_uuid: storeId,
          });
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying quota status fetch', {
              attempt,
              storeId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error || !data) {
        structuredLog('warn', PlanManager.SERVICE_NAME, 'Failed to get quota status', {
          storeId,
          error: error?.message,
        });
        return null;
      }

      const dbStatus = data as unknown as DatabaseQuotaStatus;

      return {
        planName: dbStatus.plan_name,
        priceMonthly: parsePrice(dbStatus.price_monthly),
        isTrial: dbStatus.is_trial,
        trialEndsAt: dbStatus.trial_ends_at,
        periodStart: dbStatus.period_start,
        periodEnd: dbStatus.period_end,
        articlesUsed: dbStatus.articles_used,
        articlesAllowed: dbStatus.articles_allowed,
        articlesRemaining: dbStatus.articles_remaining,
        usagePercentage: dbStatus.usage_percentage,
      };
    } catch (error) {
      structuredLog('error', PlanManager.SERVICE_NAME, 'Quota status fetch failed', {
        storeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async recordUsage(storeId: string, postId: string, usageType: UsageType = 'generated'): Promise<void> {
    validateStoreId(storeId);
    if (!postId || typeof postId !== 'string' || postId.trim().length === 0) {
      throw new Error('Invalid postId: must be a non-empty string');
    }
    if (!validateUsageType(usageType)) {
      throw new Error(`Invalid usageType: ${usageType}`);
    }

    try {
      const { error } = await retry(
        async () => {
          return await this.supabase.rpc('record_article_usage', {
            store_uuid: storeId,
            post_uuid: postId,
            usage_type: usageType,
          });
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying usage recording', {
              attempt,
              storeId,
              postId,
              usageType,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error) {
        throw new Error(`Failed to record article usage: ${error.message}`);
      }

      structuredLog('info', PlanManager.SERVICE_NAME, 'Usage recorded', {
        storeId,
        postId,
        usageType,
      });
    } catch (error) {
      structuredLog('error', PlanManager.SERVICE_NAME, 'Failed to record usage', {
        storeId,
        postId,
        usageType,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async enforceQuotaWithLock(
    storeId: string,
    operation: OperationType,
    correlationId: string,
  ): Promise<QuotaEnforcementResult> {
    const startTime = Date.now();
    validateStoreId(storeId);
    validateCorrelationId(correlationId);
    if (!validateOperation(operation)) {
      throw new Error(`Invalid operation: ${operation}`);
    }

    let lockAcquired = false;

    try {
      lockAcquired = await this.acquireLock(storeId, LOCK_OPERATION_QUOTA_CHECK, correlationId);
      
      if (!lockAcquired) {
        return {
          allowed: false,
          reason: 'System is processing another quota check. Please try again in a moment.',
          quotaStatus: {
            articlesUsed: 0,
            articlesAllowed: 0,
            articlesRemaining: 0,
            periodStart: new Date().toISOString(),
            periodEnd: new Date().toISOString(),
            usagePercentage: 0,
          },
          lockAcquired: false,
        };
      }

      const storeStatus = await this.getStorePlanStatus(storeId);
      if (!storeStatus) {
        return {
          allowed: false,
          reason: 'Store not found or plan not configured',
          quotaStatus: {
            articlesUsed: 0,
            articlesAllowed: 0,
            articlesRemaining: 0,
            periodStart: new Date().toISOString(),
            periodEnd: new Date().toISOString(),
            usagePercentage: 0,
          },
          lockAcquired: true,
        };
      }

      if (!storeStatus.isActive) {
        return {
          allowed: false,
          reason: 'Store is inactive',
          quotaStatus: storeStatus.quotaStatus,
          trialStatus: storeStatus.trialStatus,
          lockAcquired: true,
        };
      }

      if (storeStatus.isPaused) {
        return {
          allowed: false,
          reason: 'Store is paused',
          quotaStatus: storeStatus.quotaStatus,
          trialStatus: storeStatus.trialStatus,
          lockAcquired: true,
        };
      }

      if (storeStatus.trialStatus.isExpired) {
        const graceResult = await this.handleTrialExpiration(storeId, storeStatus, correlationId);
        if (graceResult) {
          return graceResult;
        }
      }

      const allowed = storeStatus.quotaStatus.articlesRemaining > 0;

      const duration = Date.now() - startTime;
      structuredLog('info', PlanManager.SERVICE_NAME, 'Quota enforced with lock', {
        storeId,
        operation,
        correlationId,
        allowed,
        durationMs: duration,
      });

      if (!allowed) {
        return {
          allowed: false,
          reason: 'Article quota exceeded for current period',
          quotaStatus: storeStatus.quotaStatus,
          trialStatus: storeStatus.trialStatus,
          lockAcquired: true,
        };
      }

      return {
        allowed: true,
        quotaStatus: storeStatus.quotaStatus,
        trialStatus: storeStatus.trialStatus,
        lockAcquired: true,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', PlanManager.SERVICE_NAME, 'Quota enforcement with lock failed', {
        storeId,
        operation,
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      throw error;
    } finally {
      if (lockAcquired) {
        await this.releaseLock(storeId, LOCK_OPERATION_QUOTA_CHECK, correlationId);
      }
    }
  }

  async initializeTrial(
    storeId: string,
    trialDays: number = DEFAULT_TRIAL_DAYS,
    correlationId: string,
    forceReset: boolean = false,
  ): Promise<{ success: boolean; trialStatus: TrialStatus; error?: string }> {
    const startTime = Date.now();
    validateStoreId(storeId);
    validateCorrelationId(correlationId);
    validateTrialDays(trialDays);

    const lockAcquired = await this.acquireLock(storeId, LOCK_OPERATION_TRIAL_UPDATE, correlationId);
    
    if (!lockAcquired) {
      return {
        success: false,
        trialStatus: this.getDefaultTrialStatus(),
        error: 'Could not acquire lock for trial initialization',
      };
    }

    try {
      const { data: store, error: storeError } = await retry(
        async () => {
          return await this.supabase
            .from('stores')
            .select('plan_id, trial_started_at, trial_ends_at, subscription_id')
            .eq('id', storeId)
            .single();
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying store fetch for trial init', {
              attempt,
              storeId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (storeError || !store) {
        return {
          success: false,
          trialStatus: this.getDefaultTrialStatus(),
          error: 'Store not found',
        };
      }

      const now = new Date();
      const existingTrialEndsAt = store.trial_ends_at ? new Date(store.trial_ends_at) : null;
      const trialExpired = existingTrialEndsAt ? now > existingTrialEndsAt : true;

      if (!forceReset && existingTrialEndsAt && !trialExpired && !store.subscription_id) {
        const trialStatus = this.calculateTrialStatus(
          store.trial_started_at,
          store.trial_ends_at,
        );
        return {
          success: true,
          trialStatus,
        };
      }

      if (store.subscription_id) {
        const trialStatus = this.calculateTrialStatus(
          store.trial_started_at,
          store.trial_ends_at,
        );
        return {
          success: true,
          trialStatus,
        };
      }

      const trialStartedAt = forceReset || !store.trial_started_at ? now : new Date(store.trial_started_at);
      const trialEndsAt = new Date(trialStartedAt.getTime() + trialDays * MILLISECONDS_PER_DAY);

      const { data: freeTrialPlan, error: planError } = await retry(
        async () => {
          return await this.supabase
            .from('plan_limits')
            .select('id, plan_name')
            .eq('plan_name', 'free_trial')
            .single();
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying free trial plan fetch', {
              attempt,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (planError || !freeTrialPlan) {
        return {
          success: false,
          trialStatus: this.getDefaultTrialStatus(),
          error: 'Free trial plan not found',
        };
      }

      const { error: updateError } = await retry(
        async () => {
          return await this.supabase
            .from('stores')
            .update({
              plan_id: freeTrialPlan.id,
              trial_started_at: trialStartedAt.toISOString(),
              trial_ends_at: trialEndsAt.toISOString(),
              is_active: true,
              is_paused: false,
            })
            .eq('id', storeId);
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying trial initialization update', {
              attempt,
              storeId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (updateError) {
        return {
          success: false,
          trialStatus: this.getDefaultTrialStatus(),
          error: `Failed to initialize trial: ${updateError.message}`,
        };
      }

      await this.auditLog(storeId, 'trial_initialized', {
        trialDays,
        trialStartedAt: trialStartedAt.toISOString(),
        trialEndsAt: trialEndsAt.toISOString(),
        planId: freeTrialPlan.id,
        correlationId,
      });

      const trialStatus = this.calculateTrialStatus(
        trialStartedAt.toISOString(),
        trialEndsAt.toISOString(),
      );

      const duration = Date.now() - startTime;
      structuredLog('info', PlanManager.SERVICE_NAME, 'Trial initialized', {
        storeId,
        trialDays,
        correlationId,
        durationMs: duration,
      });

      return {
        success: true,
        trialStatus,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', PlanManager.SERVICE_NAME, 'Trial initialization failed', {
        storeId,
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      return {
        success: false,
        trialStatus: this.getDefaultTrialStatus(),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await this.releaseLock(storeId, LOCK_OPERATION_TRIAL_UPDATE, correlationId);
    }
  }

  async transitionPlan(
    storeId: string,
    transition: PlanTransition,
    correlationId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const startTime = Date.now();
    validateStoreId(storeId);
    validateCorrelationId(correlationId);
    if (!validateTransitionReason(transition.reason)) {
      throw new Error(`Invalid transition reason: ${transition.reason}`);
    }
    if (!transition.toPlanId || typeof transition.toPlanId !== 'string' || transition.toPlanId.trim().length === 0) {
      throw new Error('Invalid toPlanId: must be a non-empty string');
    }

    const lockAcquired = await this.acquireLock(storeId, LOCK_OPERATION_PLAN_UPDATE, correlationId);
    
    if (!lockAcquired) {
      return {
        success: false,
        error: 'Could not acquire lock for plan transition',
      };
    }

    try {
      const validation = await this.validatePlanTransition(storeId, transition);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error || 'Invalid plan transition',
        };
      }

      const { data: store, error: storeError } = await retry(
        async () => {
          return await this.supabase
            .from('stores')
            .select('plan_id, subscription_id, trial_ends_at')
            .eq('id', storeId)
            .single();
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying store fetch for plan transition', {
              attempt,
              storeId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (storeError || !store) {
        return {
          success: false,
          error: 'Store not found',
        };
      }

      const { data: targetPlan, error: planError } = await retry(
        async () => {
          return await this.supabase
            .from('plan_limits')
            .select('*')
            .eq('id', transition.toPlanId)
            .single();
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying target plan fetch', {
              attempt,
              toPlanId: transition.toPlanId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (planError || !targetPlan) {
        return {
          success: false,
          error: 'Target plan not found',
        };
      }

      const updates = this.buildPlanTransitionUpdates(transition, targetPlan as DatabasePlanRow);

      const { error: updateError } = await retry(
        async () => {
          return await this.supabase
            .from('stores')
            .update(updates)
            .eq('id', storeId);
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying plan transition update', {
              attempt,
              storeId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (updateError) {
        return {
          success: false,
          error: `Failed to transition plan: ${updateError.message}`,
        };
      }

      const { error: syncError } = await this.supabase.rpc('sync_plan_limits_to_store', {
        p_store_id: storeId,
        p_new_plan_id: transition.toPlanId,
      });

      if (syncError) {
        structuredLog('warn', PlanManager.SERVICE_NAME, 'Failed to sync plan limits', {
          storeId,
          toPlanId: transition.toPlanId,
          error: syncError.message,
        });
      }

      await this.auditLog(storeId, 'plan_transitioned', {
        fromPlanId: transition.fromPlanId,
        toPlanId: transition.toPlanId,
        reason: transition.reason,
        subscriptionId: transition.subscriptionId,
        metadata: transition.metadata,
        correlationId,
      });

      const duration = Date.now() - startTime;
      structuredLog('info', PlanManager.SERVICE_NAME, 'Plan transitioned', {
        storeId,
        fromPlanId: transition.fromPlanId,
        toPlanId: transition.toPlanId,
        reason: transition.reason,
        correlationId,
        durationMs: duration,
      });

      return {
        success: true,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', PlanManager.SERVICE_NAME, 'Plan transition failed', {
        storeId,
        toPlanId: transition.toPlanId,
        correlationId,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await this.releaseLock(storeId, LOCK_OPERATION_PLAN_UPDATE, correlationId);
    }
  }

  async getStorePlanStatus(storeId: string): Promise<StorePlanStatus | null> {
    validateStoreId(storeId);

    try {
      const [storeResult, quotaResult] = await Promise.all([
        retry(
          async () => {
            return await this.supabase
              .from('stores')
              .select(`
                id,
                plan_id,
                subscription_id,
                is_active,
                is_paused,
                trial_started_at,
                trial_ends_at,
                ${this.gracePeriodColumn},
                plan_limits (
                  id,
                  plan_name,
                  article_limit_monthly,
                  article_limit_weekly,
                  price_monthly,
                  trial_days
                )
              `)
              .eq('id', storeId)
              .single();
          },
          {
            ...PlanManager.DEFAULT_RETRY_OPTIONS,
            onRetry: (attempt, err) => {
              structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying store plan status fetch', {
                attempt,
                storeId,
                error: err instanceof Error ? err.message : String(err),
              });
            },
          },
        ),
        retry(
          async () => {
            return await this.supabase.rpc('get_store_quota_status', {
              store_uuid: storeId,
            });
          },
          {
            ...PlanManager.DEFAULT_RETRY_OPTIONS,
            onRetry: (attempt, err) => {
              structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying quota status fetch for store status', {
                attempt,
                storeId,
                error: err instanceof Error ? err.message : String(err),
              });
            },
          },
        ),
      ]);

      const { data: store, error: storeError } = storeResult;
      const { data: quotaData, error: quotaError } = quotaResult;

      if (storeError || !store) {
        return null;
      }

      const storeData = store as unknown as DatabaseStoreRow & {
        plan_limits: DatabasePlanRow | null;
      };

      if (!storeData.plan_limits) {
        return null;
      }

      if (quotaError || !quotaData) {
        return null;
      }

      const quotaStatus = quotaData as unknown as DatabaseQuotaStatus;
      const gracePeriodEndsAt = (storeData as { [key: string]: string | null })[this.gracePeriodColumn] || null;
      const trialStatus = this.calculateTrialStatus(
        storeData.trial_started_at,
        storeData.trial_ends_at,
        gracePeriodEndsAt,
      );

      return {
        storeId: storeData.id,
        planId: storeData.plan_id || '',
        planName: storeData.plan_limits.plan_name,
        subscriptionId: storeData.subscription_id,
        isActive: storeData.is_active,
        isPaused: storeData.is_paused,
        trialStatus,
        quotaStatus: {
          articlesUsed: quotaStatus.articles_used,
          articlesAllowed: quotaStatus.articles_allowed,
          articlesRemaining: quotaStatus.articles_remaining,
          periodStart: quotaStatus.period_start,
          periodEnd: quotaStatus.period_end,
        },
      };
    } catch (error) {
      structuredLog('error', PlanManager.SERVICE_NAME, 'Failed to get store plan status', {
        storeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async handleTrialExpiration(
    storeId: string,
    storeStatus: StorePlanStatus,
    correlationId: string,
  ): Promise<QuotaEnforcementResult | null> {
    const { data: storeWithGrace, error: graceError } = await retry(
      async () => {
        return await this.supabase
          .from('stores')
          .select(`id, ${this.gracePeriodColumn}`)
          .eq('id', storeId)
          .single();
      },
      {
        ...PlanManager.DEFAULT_RETRY_OPTIONS,
        onRetry: (attempt, err) => {
          structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying grace period check', {
            attempt,
            storeId,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      },
    );

    let gracePeriodEndsAt: string | null = null;
    
    if (!graceError && storeWithGrace) {
      gracePeriodEndsAt = (storeWithGrace as { [key: string]: string | null })[this.gracePeriodColumn] || null;
    }

    if (!gracePeriodEndsAt && storeStatus.trialStatus.endsAt) {
      const trialEnd = new Date(storeStatus.trialStatus.endsAt);
      const now = new Date();
      const timeSinceExpiration = now.getTime() - trialEnd.getTime();
      if (timeSinceExpiration > 0 && timeSinceExpiration < GRACE_PERIOD_CREATION_WINDOW_MS) {
        gracePeriodEndsAt = new Date(now.getTime() + TRIAL_GRACE_PERIOD_DAYS * MILLISECONDS_PER_DAY).toISOString();
        await this.updateTrialGracePeriod(storeId, gracePeriodEndsAt, correlationId);
        storeStatus.trialStatus.gracePeriodEndsAt = gracePeriodEndsAt;
      }
    } else if (gracePeriodEndsAt) {
      storeStatus.trialStatus.gracePeriodEndsAt = gracePeriodEndsAt;
    }

    if (gracePeriodEndsAt) {
      const graceEnd = new Date(gracePeriodEndsAt);
      const now = new Date();
      if (now > graceEnd) {
        await this.pauseStoreAfterTrialExpiration(storeId, correlationId);
        return {
          allowed: false,
          reason: 'Trial period has expired. Please upgrade to continue.',
          quotaStatus: storeStatus.quotaStatus,
          trialStatus: storeStatus.trialStatus,
          lockAcquired: true,
        };
      }
    } else {
      await this.pauseStoreAfterTrialExpiration(storeId, correlationId);
      return {
        allowed: false,
        reason: 'Trial period has expired. Please upgrade to continue.',
        quotaStatus: storeStatus.quotaStatus,
        trialStatus: storeStatus.trialStatus,
        lockAcquired: true,
      };
    }

    return null;
  }

  private buildPlanTransitionUpdates(
    transition: PlanTransition,
    targetPlan: DatabasePlanRow,
  ): Readonly<Record<string, unknown>> {
    const updates: Record<string, unknown> = {
      plan_id: transition.toPlanId,
      updated_at: new Date().toISOString(),
    };

    if (transition.subscriptionId !== undefined) {
      updates.subscription_id = transition.subscriptionId;
    }

    if (transition.reason === 'subscription_activated' || transition.reason === 'upgrade') {
      updates.trial_ends_at = null;
      updates.trial_started_at = null;
    } else if (transition.reason === 'trial_start') {
      const now = new Date();
      const trialDays = targetPlan.trial_days || DEFAULT_TRIAL_DAYS;
      updates.trial_started_at = now.toISOString();
      updates.trial_ends_at = new Date(now.getTime() + trialDays * MILLISECONDS_PER_DAY).toISOString();
    } else if (transition.reason === 'trial_expired' || transition.reason === 'subscription_cancelled') {
      if (!transition.subscriptionId) {
        updates.is_paused = true;
      }
    }

    return updates;
  }

  private async getPlanLimits(planId: string | null): Promise<PlanLimits | null> {
    if (!planId) {
      return null;
    }

    try {
      const { data, error } = await retry(
        async () => {
          return await this.supabase
            .from('plan_limits')
            .select('*')
            .eq('id', planId)
            .single();
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying plan limits fetch', {
              attempt,
              planId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error || !data) {
        return null;
      }

      const plan = data as unknown as DatabasePlanRow;

      return {
        planId: plan.id,
        planName: plan.plan_name,
        articleLimitMonthly: plan.article_limit_monthly,
        articleLimitWeekly: plan.article_limit_weekly || undefined,
        priceMonthly: parsePrice(plan.price_monthly),
        trialDays: plan.trial_days || undefined,
      };
    } catch (error) {
      structuredLog('warn', PlanManager.SERVICE_NAME, 'Failed to get plan limits', {
        planId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async getStore(storeId: string): Promise<DatabaseStoreRow | null> {
    try {
      const { data, error } = await retry(
        async () => {
          return await this.supabase
            .from('stores')
            .select('id, plan_id, is_active, is_paused, trial_ends_at')
            .eq('id', storeId)
            .single();
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying store fetch', {
              attempt,
              storeId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (error || !data) {
        return null;
      }

      return data as unknown as DatabaseStoreRow;
    } catch (error) {
      structuredLog('warn', PlanManager.SERVICE_NAME, 'Failed to get store', {
        storeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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

  private async acquireLock(
    storeId: string,
    operation: string,
    correlationId: string,
  ): Promise<boolean> {
    const expiresAt = new Date(Date.now() + LOCK_TIMEOUT_MS).toISOString();

    try {
      const { error } = await retry(
        async () => {
          return await this.supabase
            .from(this.lockTableName)
            .insert({
              store_id: storeId,
              operation,
              expires_at: expiresAt,
              correlation_id: correlationId,
            });
        },
        {
          maxAttempts: 1,
          initialDelay: 0,
          backoffMultiplier: 1,
          retryableErrors: [],
        },
      );

      if (!error) {
        return true;
      }

      const { data: existingLock, error: fetchError } = await retry(
        async () => {
          return await this.supabase
            .from(this.lockTableName)
            .select('expires_at')
            .eq('store_id', storeId)
            .eq('operation', operation)
            .single();
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying lock check', {
              attempt,
              storeId,
              operation,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (fetchError || !existingLock) {
        return false;
      }

      const lockExpiresAt = new Date(existingLock.expires_at);
      const now = new Date();

      if (now > lockExpiresAt) {
        const { error: updateError } = await retry(
          async () => {
            return await this.supabase
              .from(this.lockTableName)
              .update({
                expires_at: expiresAt,
                correlation_id: correlationId,
              })
              .eq('store_id', storeId)
              .eq('operation', operation)
              .lt('expires_at', now.toISOString());
          },
          {
            maxAttempts: 1,
            initialDelay: 0,
            backoffMultiplier: 1,
            retryableErrors: [],
          },
        );

        return !updateError;
      }

      return false;
    } catch (error) {
      structuredLog('warn', PlanManager.SERVICE_NAME, 'Lock acquisition failed', {
        storeId,
        operation,
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async releaseLock(
    storeId: string,
    operation: string,
    correlationId: string,
  ): Promise<void> {
    try {
      await retry(
        async () => {
          return await this.supabase
            .from(this.lockTableName)
            .delete()
            .eq('store_id', storeId)
            .eq('operation', operation)
            .eq('correlation_id', correlationId);
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying lock release', {
              attempt,
              storeId,
              operation,
              correlationId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );
    } catch (error) {
      structuredLog('warn', PlanManager.SERVICE_NAME, 'Lock release failed', {
        storeId,
        operation,
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private calculateTrialStatus(
    startedAt: string | null,
    endsAt: string | null,
    gracePeriodEndsAt: string | null = null,
  ): TrialStatus {
    if (!endsAt) {
      return {
        isActive: false,
        isExpired: true,
        daysRemaining: 0,
        startedAt: null,
        endsAt: null,
        gracePeriodEndsAt: null,
      };
    }

    const now = new Date();
    const trialEnd = new Date(endsAt);
    const isExpired = now > trialEnd;
    const daysRemaining = isExpired ? 0 : calculateDaysRemaining(trialEnd, now);

    let activeGracePeriod: string | null = null;
    if (gracePeriodEndsAt) {
      const graceEnd = new Date(gracePeriodEndsAt);
      if (now <= graceEnd) {
        activeGracePeriod = gracePeriodEndsAt;
      }
    }

    return {
      isActive: !isExpired || !!activeGracePeriod,
      isExpired,
      daysRemaining,
      startedAt,
      endsAt,
      gracePeriodEndsAt: activeGracePeriod,
    };
  }

  private getDefaultTrialStatus(): TrialStatus {
    return {
      isActive: false,
      isExpired: true,
      daysRemaining: 0,
      startedAt: null,
      endsAt: null,
      gracePeriodEndsAt: null,
    };
  }

  private async validatePlanTransition(
    storeId: string,
    transition: PlanTransition,
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      const { data: plan, error: planError } = await retry(
        async () => {
          return await this.supabase
            .from('plan_limits')
            .select('id')
            .eq('id', transition.toPlanId)
            .single();
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying plan validation', {
              attempt,
              toPlanId: transition.toPlanId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      if (planError || !plan) {
        return {
          valid: false,
          error: 'Target plan not found',
        };
      }

      return { valid: true };
    } catch (error) {
      structuredLog('error', PlanManager.SERVICE_NAME, 'Plan transition validation failed', {
        storeId,
        toPlanId: transition.toPlanId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        valid: false,
        error: 'Validation failed',
      };
    }
  }

  private async updateTrialGracePeriod(
    storeId: string,
    gracePeriodEndsAt: string,
    correlationId: string,
  ): Promise<void> {
    try {
      await retry(
        async () => {
          return await this.supabase
            .from('stores')
            .update({
              [this.gracePeriodColumn]: gracePeriodEndsAt,
              updated_at: new Date().toISOString(),
            })
            .eq('id', storeId);
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying grace period update', {
              attempt,
              storeId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      await this.auditLog(storeId, 'grace_period_started', {
        gracePeriodEndsAt,
        correlationId,
      });
    } catch (error) {
      structuredLog('error', PlanManager.SERVICE_NAME, 'Failed to update grace period', {
        storeId,
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async pauseStoreAfterTrialExpiration(
    storeId: string,
    correlationId: string,
  ): Promise<void> {
    try {
      await retry(
        async () => {
          return await this.supabase
            .from('stores')
            .update({
              is_paused: true,
              updated_at: new Date().toISOString(),
            })
            .eq('id', storeId);
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying store pause', {
              attempt,
              storeId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      await this.auditLog(storeId, 'store_paused_trial_expired', {
        correlationId,
      });
    } catch (error) {
      structuredLog('error', PlanManager.SERVICE_NAME, 'Failed to pause store', {
        storeId,
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async auditLog(
    storeId: string,
    eventType: string,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      await retry(
        async () => {
          return await this.supabase.from(this.auditTableName).insert({
            store_id: storeId,
            event_type: eventType,
            metadata,
            created_at: new Date().toISOString(),
          });
        },
        {
          ...PlanManager.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', PlanManager.SERVICE_NAME, 'Retrying audit log', {
              attempt,
              storeId,
              eventType,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );
    } catch (error) {
      structuredLog('warn', PlanManager.SERVICE_NAME, 'Audit logging failed', {
        storeId,
        eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const PlanQuotaManager = PlanManager;
export const PlanTrialManager = PlanManager;
export const PlanLimitsEnforcer = PlanManager;
export const QuotaManager = PlanManager;
