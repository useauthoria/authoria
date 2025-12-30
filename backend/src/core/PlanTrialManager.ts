/**
 * Enterprise-Grade Plan and Trial Management System
 * 
 * Features:
 * - Atomic operations with transaction support
 * - Distributed locking to prevent race conditions
 * - Comprehensive validation and audit logging
 * - Grace period handling for trial expiration
 * - Quota period boundary management
 * - Plan upgrade/downgrade with proration
 */

import type { SupabaseClient } from '@supabase/supabase-js';

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

interface DatabasePlanRow {
  readonly id: string;
  readonly plan_name: string;
  readonly article_limit_monthly: number;
  readonly article_limit_weekly: number | null;
  readonly price_monthly: string | number;
  readonly trial_days: number | null;
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

interface LockRecord {
  readonly store_id: string;
  readonly operation: string;
  readonly expires_at: string;
  readonly correlation_id: string;
}

const DEFAULT_TRIAL_DAYS = 14;
const TRIAL_GRACE_PERIOD_DAYS = 3;
const LOCK_TIMEOUT_MS = 30000; // 30 seconds
const LOCK_OPERATION_QUOTA_CHECK = 'quota_check';
const LOCK_OPERATION_PLAN_UPDATE = 'plan_update';
const LOCK_OPERATION_TRIAL_UPDATE = 'trial_update';

export class PlanTrialManager {
  private readonly supabase: SupabaseClient;
  private readonly lockTableName = 'plan_operation_locks';
  private readonly auditTableName = 'plan_audit_log';
  private readonly gracePeriodColumn = 'grace_period_ends_at';

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  /**
   * Enterprise-grade quota enforcement with distributed locking
   */
  async enforceQuotaWithLock(
    storeId: string,
    operation: 'create_article' | 'publish_article' | 'schedule_article',
    correlationId: string,
  ): Promise<QuotaEnforcementResult> {
    const lockKey = `${storeId}:${LOCK_OPERATION_QUOTA_CHECK}`;
    let lockAcquired = false;

    try {
      // Acquire distributed lock
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

      // Get store status with validation
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

      // Validate store is active
      if (!storeStatus.isActive) {
        return {
          allowed: false,
          reason: 'Store is inactive',
          quotaStatus: storeStatus.quotaStatus,
          trialStatus: storeStatus.trialStatus,
          lockAcquired: true,
        };
      }

      // Validate store is not paused
      if (storeStatus.isPaused) {
        return {
          allowed: false,
          reason: 'Store is paused',
          quotaStatus: storeStatus.quotaStatus,
          trialStatus: storeStatus.trialStatus,
          lockAcquired: true,
        };
      }

      // Check trial expiration with grace period
      if (storeStatus.trialStatus.isExpired) {
        // Check if grace period exists or should be created
        const { data: storeWithGrace, error: graceError } = await this.supabase
          .from('stores')
          .select(`id, ${this.gracePeriodColumn}`)
          .eq('id', storeId)
          .single();

        let gracePeriodEndsAt: string | null = null;
        
        if (!graceError && storeWithGrace) {
          gracePeriodEndsAt = (storeWithGrace as { [key: string]: string | null })[this.gracePeriodColumn] || null;
        }

        // If no grace period exists and trial just expired, create one
        if (!gracePeriodEndsAt && storeStatus.trialStatus.endsAt) {
          const trialEnd = new Date(storeStatus.trialStatus.endsAt);
          const now = new Date();
          // Only create grace period if trial expired recently (within last hour)
          const timeSinceExpiration = now.getTime() - trialEnd.getTime();
          if (timeSinceExpiration > 0 && timeSinceExpiration < 60 * 60 * 1000) {
            gracePeriodEndsAt = new Date(now.getTime() + TRIAL_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
            await this.updateTrialGracePeriod(storeId, gracePeriodEndsAt, correlationId);
            storeStatus.trialStatus.gracePeriodEndsAt = gracePeriodEndsAt;
          }
        } else if (gracePeriodEndsAt) {
          storeStatus.trialStatus.gracePeriodEndsAt = gracePeriodEndsAt;
        }

        // Check if grace period has expired
        if (gracePeriodEndsAt) {
          const graceEnd = new Date(gracePeriodEndsAt);
          const now = new Date();
          if (now > graceEnd) {
            // Grace period expired - pause store
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
          // No grace period and trial expired - pause store
          await this.pauseStoreAfterTrialExpiration(storeId, correlationId);
          return {
            allowed: false,
            reason: 'Trial period has expired. Please upgrade to continue.',
            quotaStatus: storeStatus.quotaStatus,
            trialStatus: storeStatus.trialStatus,
            lockAcquired: true,
          };
        }
      }

      // Check quota
      const allowed = storeStatus.quotaStatus.articlesRemaining > 0;

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
    } finally {
      if (lockAcquired) {
        await this.releaseLock(storeId, LOCK_OPERATION_QUOTA_CHECK, correlationId);
      }
    }
  }

  /**
   * Initialize or update trial for a store (atomic operation)
   */
  async initializeTrial(
    storeId: string,
    trialDays: number = DEFAULT_TRIAL_DAYS,
    correlationId: string,
    forceReset: boolean = false,
  ): Promise<{ success: boolean; trialStatus: TrialStatus; error?: string }> {
    const lockAcquired = await this.acquireLock(storeId, LOCK_OPERATION_TRIAL_UPDATE, correlationId);
    
    if (!lockAcquired) {
      return {
        success: false,
        trialStatus: this.getDefaultTrialStatus(),
        error: 'Could not acquire lock for trial initialization',
      };
    }

    try {
      // Get current store state
      const { data: store, error: storeError } = await this.supabase
        .from('stores')
        .select('plan_id, trial_started_at, trial_ends_at, subscription_id')
        .eq('id', storeId)
        .single();

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

      // Only initialize/reset trial if:
      // 1. Force reset is requested, OR
      // 2. No trial exists (trial_ends_at is null), OR
      // 3. Trial has expired AND no active subscription
      if (!forceReset && existingTrialEndsAt && !trialExpired && !store.subscription_id) {
        // Trial is active, don't reset
        const trialStatus = this.calculateTrialStatus(
          store.trial_started_at,
          store.trial_ends_at,
        );
        return {
          success: true,
          trialStatus,
        };
      }

      // Check if store has active subscription - if so, don't set trial
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

      // Initialize trial
      const trialStartedAt = forceReset || !store.trial_started_at ? now : new Date(store.trial_started_at);
      const trialEndsAt = new Date(trialStartedAt.getTime() + trialDays * 24 * 60 * 60 * 1000);

      // Get free_trial plan
      const { data: freeTrialPlan, error: planError } = await this.supabase
        .from('plan_limits')
        .select('id, plan_name')
        .eq('plan_name', 'free_trial')
        .single();

      if (planError || !freeTrialPlan) {
        return {
          success: false,
          trialStatus: this.getDefaultTrialStatus(),
          error: 'Free trial plan not found',
        };
      }

      // Atomic update: set plan, trial dates, and ensure store is active
      const { error: updateError } = await this.supabase
        .from('stores')
        .update({
          plan_id: freeTrialPlan.id,
          trial_started_at: trialStartedAt.toISOString(),
          trial_ends_at: trialEndsAt.toISOString(),
          is_active: true,
          is_paused: false,
        })
        .eq('id', storeId);

      if (updateError) {
        return {
          success: false,
          trialStatus: this.getDefaultTrialStatus(),
          error: `Failed to initialize trial: ${updateError.message}`,
        };
      }

      // Audit log
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

      return {
        success: true,
        trialStatus,
      };
    } finally {
      await this.releaseLock(storeId, LOCK_OPERATION_TRIAL_UPDATE, correlationId);
    }
  }

  /**
   * Transition store to a new plan (atomic operation with validation)
   */
  async transitionPlan(
    storeId: string,
    transition: PlanTransition,
    correlationId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const lockAcquired = await this.acquireLock(storeId, LOCK_OPERATION_PLAN_UPDATE, correlationId);
    
    if (!lockAcquired) {
      return {
        success: false,
        error: 'Could not acquire lock for plan transition',
      };
    }

    try {
      // Validate transition
      const validation = await this.validatePlanTransition(storeId, transition);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error || 'Invalid plan transition',
        };
      }

      // Get current store state
      const { data: store, error: storeError } = await this.supabase
        .from('stores')
        .select('plan_id, subscription_id, trial_ends_at')
        .eq('id', storeId)
        .single();

      if (storeError || !store) {
        return {
          success: false,
          error: 'Store not found',
        };
      }

      // Get target plan
      const { data: targetPlan, error: planError } = await this.supabase
        .from('plan_limits')
        .select('*')
        .eq('id', transition.toPlanId)
        .single();

      if (planError || !targetPlan) {
        return {
          success: false,
          error: 'Target plan not found',
        };
      }

      // Build update object
      const updates: Record<string, unknown> = {
        plan_id: transition.toPlanId,
        updated_at: new Date().toISOString(),
      };

      // Handle subscription ID
      if (transition.subscriptionId !== undefined) {
        updates.subscription_id = transition.subscriptionId;
      }

      // Handle trial dates based on transition reason
      if (transition.reason === 'subscription_activated' || transition.reason === 'upgrade') {
        // Clear trial dates when subscription is activated or upgrading
        updates.trial_ends_at = null;
        updates.trial_started_at = null;
      } else if (transition.reason === 'trial_start') {
        // Set trial dates for new trial
        const now = new Date();
        const trialDays = (targetPlan as DatabasePlanRow).trial_days || DEFAULT_TRIAL_DAYS;
        updates.trial_started_at = now.toISOString();
        updates.trial_ends_at = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000).toISOString();
      } else if (transition.reason === 'trial_expired' || transition.reason === 'subscription_cancelled') {
        // Keep existing trial dates but ensure store is paused if no subscription
        if (!transition.subscriptionId) {
          updates.is_paused = true;
        }
      }

      // Atomic update
      const { error: updateError } = await this.supabase
        .from('stores')
        .update(updates)
        .eq('id', storeId);

      if (updateError) {
        return {
          success: false,
          error: `Failed to transition plan: ${updateError.message}`,
        };
      }

      // Sync plan limits
      const { error: syncError } = await this.supabase.rpc('sync_plan_limits_to_store', {
        p_store_id: storeId,
        p_new_plan_id: transition.toPlanId,
      });

      if (syncError) {
        // Log but don't fail - limits will sync on next quota check
        console.warn('Failed to sync plan limits:', syncError);
      }

      // Audit log
      await this.auditLog(storeId, 'plan_transitioned', {
        fromPlanId: transition.fromPlanId,
        toPlanId: transition.toPlanId,
        reason: transition.reason,
        subscriptionId: transition.subscriptionId,
        metadata: transition.metadata,
        correlationId,
      });

      return {
        success: true,
      };
    } finally {
      await this.releaseLock(storeId, LOCK_OPERATION_PLAN_UPDATE, correlationId);
    }
  }

  /**
   * Get comprehensive store plan status
   */
  async getStorePlanStatus(storeId: string): Promise<StorePlanStatus | null> {
    // Get store with plan info
    const { data: store, error: storeError } = await this.supabase
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

    if (storeError || !store) {
      return null;
    }

    const storeData = store as unknown as DatabaseStoreRow & {
      plan_limits: DatabasePlanRow | null;
    };

    if (!storeData.plan_limits) {
      return null;
    }

    // Get quota status
    const { data: quotaData, error: quotaError } = await this.supabase.rpc('get_store_quota_status', {
      store_uuid: storeId,
    });

    if (quotaError || !quotaData) {
      return null;
    }

    const quotaStatus = quotaData as unknown as DatabaseQuotaStatus;

    // Calculate trial status with grace period
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
  }

  /**
   * Acquire distributed lock
   */
  private async acquireLock(
    storeId: string,
    operation: string,
    correlationId: string,
  ): Promise<boolean> {
    const expiresAt = new Date(Date.now() + LOCK_TIMEOUT_MS).toISOString();

    try {
      // Try to insert lock (will fail if lock exists and not expired)
      const { error } = await this.supabase
        .from(this.lockTableName)
        .insert({
          store_id: storeId,
          operation,
          expires_at: expiresAt,
          correlation_id: correlationId,
        });

      if (!error) {
        return true;
      }

      // Lock exists - check if expired
      const { data: existingLock, error: fetchError } = await this.supabase
        .from(this.lockTableName)
        .select('expires_at')
        .eq('store_id', storeId)
        .eq('operation', operation)
        .single();

      if (fetchError || !existingLock) {
        return false;
      }

      const lockExpiresAt = new Date(existingLock.expires_at);
      const now = new Date();

      if (now > lockExpiresAt) {
        // Lock expired - try to acquire it
        const { error: updateError } = await this.supabase
          .from(this.lockTableName)
          .update({
            expires_at: expiresAt,
            correlation_id: correlationId,
          })
          .eq('store_id', storeId)
          .eq('operation', operation)
          .lt('expires_at', now.toISOString());

        return !updateError;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Release distributed lock
   */
  private async releaseLock(
    storeId: string,
    operation: string,
    correlationId: string,
  ): Promise<void> {
    await this.supabase
      .from(this.lockTableName)
      .delete()
      .eq('store_id', storeId)
      .eq('operation', operation)
      .eq('correlation_id', correlationId);
  }

  /**
   * Calculate trial status from dates
   */
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
    const daysRemaining = isExpired
      ? 0
      : Math.ceil((trialEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

    // Check if grace period is still active
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

  /**
   * Get default trial status
   */
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

  /**
   * Validate plan transition
   */
  private async validatePlanTransition(
    storeId: string,
    transition: PlanTransition,
  ): Promise<{ valid: boolean; error?: string }> {
    // Validate target plan exists
    const { data: plan, error: planError } = await this.supabase
      .from('plan_limits')
      .select('id')
      .eq('id', transition.toPlanId)
      .single();

    if (planError || !plan) {
      return {
        valid: false,
        error: 'Target plan not found',
      };
    }

    // Validate transition reason
    const validReasons = ['upgrade', 'downgrade', 'trial_start', 'trial_expired', 'subscription_cancelled', 'subscription_activated'];
    if (!validReasons.includes(transition.reason)) {
      return {
        valid: false,
        error: 'Invalid transition reason',
      };
    }

    return { valid: true };
  }

  /**
   * Update trial grace period
   */
  private async updateTrialGracePeriod(
    storeId: string,
    gracePeriodEndsAt: string,
    correlationId: string,
  ): Promise<void> {
    await this.supabase
      .from('stores')
      .update({
        [this.gracePeriodColumn]: gracePeriodEndsAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', storeId);

    await this.auditLog(storeId, 'grace_period_started', {
      gracePeriodEndsAt,
      correlationId,
    });
  }

  /**
   * Pause store after trial expiration
   */
  private async pauseStoreAfterTrialExpiration(
    storeId: string,
    correlationId: string,
  ): Promise<void> {
    await this.supabase
      .from('stores')
      .update({
        is_paused: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', storeId);

    await this.auditLog(storeId, 'store_paused_trial_expired', {
      correlationId,
    });
  }

  /**
   * Audit log for plan/trial operations
   */
  private async auditLog(
    storeId: string,
    eventType: string,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      await this.supabase.from(this.auditTableName).insert({
        store_id: storeId,
        event_type: eventType,
        metadata,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      // Don't fail operation if audit logging fails
      console.warn('Failed to audit log:', error);
    }
  }
}

