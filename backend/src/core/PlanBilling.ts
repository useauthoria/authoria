import type { SupabaseClient } from '@supabase/supabase-js';
import { ShopifyGraphQL } from '../integrations/ShopifyClient.ts';
import { ShopifyBilling } from '../integrations/ShopifyBilling.ts';
import { retry } from '../utils/error-handling.ts';

export interface BillingHistory {
  readonly events: ReadonlyArray<{
    readonly id: string;
    readonly eventType: string;
    readonly createdAt: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }>;
  readonly payments: ReadonlyArray<{
    readonly id: string;
    readonly paymentType: string;
    readonly amount: number;
    readonly currencyCode: string;
    readonly paymentStatus: string;
    readonly paymentDate: string;
  }>;
}

interface DatabasePlanRow {
  readonly id: string;
  readonly plan_name: string;
  readonly price_monthly: string | number;
  readonly trial_days?: number | null;
}

interface DatabaseStoreRow {
  readonly id: string;
  readonly plan_id?: string | null;
  readonly subscription_id?: string | null;
  readonly trial_started_at?: string | null;
  readonly trial_ends_at?: string | null;
  readonly created_at?: string;
  readonly language_settings?: {
    readonly currency?: string;
  };
}

interface DatabaseEventRow {
  readonly id: string;
  readonly event_type: string;
  readonly created_at: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface DatabasePaymentRow {
  readonly id: string;
  readonly payment_type: string;
  readonly amount: string | number;
  readonly currency_code: string;
  readonly payment_status: string;
  readonly payment_date?: string | null;
  readonly created_at: string;
}

interface ShopifyShopResponse {
  readonly shop: {
    readonly currencyCode: string;
  };
}

interface SubscriptionUpdateData {
  readonly id: string;
  readonly status: string;
  readonly name?: string;
  readonly createdAt?: string;
  readonly currentPeriodEnd?: string;
  readonly trialDays?: number;
  readonly trialEndsAt?: string;
}

interface StoreUpdateData {
  readonly subscription_id?: string | null;
  readonly plan_id?: string | null;
  readonly trial_started_at?: string | null;
  readonly trial_ends_at?: string | null;
  readonly updated_at?: string;
}

interface RetryConfig {
  readonly maxAttempts: number;
  readonly initialDelay: number;
  readonly retryableErrors: readonly string[];
  readonly backoffMultiplier?: number;
}

export class PlanBilling {
  private readonly supabase: SupabaseClient;
  private readonly shopifyGraphQL: ShopifyGraphQL;
  private readonly shopifyBilling: ShopifyBilling;
  private readonly shopDomain: string;
  private readonly accessToken: string;
  private shopCurrency: string | null = null;
  private static readonly DEFAULT_CURRENCY = 'USD';
  private static readonly DEFAULT_BILLING_LIMIT = 50;
  private static readonly MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
  private static readonly FREE_TRIAL_PLAN_NAME = 'free_trial';
  private static readonly DEFAULT_PAYMENT_STATUS = 'succeeded';
  private static readonly DEFAULT_CHURN_REASON = 'cancellation';
  private static readonly DEFAULT_CHURN_TYPE = 'voluntary';

  private static readonly PLAN_NAME_PATTERNS: Readonly<Record<string, string>> = {
    starter: 'starter',
    publisher: 'publisher',
    authority: 'authority',
    trial: 'free_trial',
  };

  private static readonly RETRY_CONFIG: RetryConfig = {
    maxAttempts: 3,
    initialDelay: 1000,
    retryableErrors: ['rate limit', 'timeout', 'network'],
  };

  constructor(
    supabase: SupabaseClient,
    shopDomain: string,
    accessToken: string,
  ) {
    this.supabase = supabase;
    this.shopDomain = shopDomain;
    this.accessToken = accessToken;
    this.shopifyGraphQL = new ShopifyGraphQL(shopDomain, accessToken);
    this.shopifyBilling = new ShopifyBilling(supabase, shopDomain, accessToken);
  }

  /**
   * Handle subscription update from Shopify webhook or API
   * Best Practice: Always verify subscription status with Shopify API
   */
  async handleSubscriptionUpdate(
    storeId: string,
    subscriptionData: SubscriptionUpdateData,
    correlationId: string = `billing-${Date.now()}`,
  ): Promise<void> {
    // Best Practice: Verify subscription status with Shopify API
    const activeSubscription = await this.shopifyBilling.checkActiveSubscription();

    if (!activeSubscription.hasActivePayment && subscriptionData.status === 'ACTIVE') {
      // Subscription might have been cancelled - verify with Shopify
      if (subscriptionData.id) {
        const shopifySubscription = await this.shopifyBilling.getSubscription(subscriptionData.id);
        if (!shopifySubscription || shopifySubscription.status !== 'ACTIVE') {
          console.warn('Subscription status mismatch', {
            storeId,
            subscriptionId: subscriptionData.id,
            reportedStatus: subscriptionData.status,
            actualStatus: shopifySubscription?.status,
          });
          // Use actual status from Shopify
          subscriptionData.status = (shopifySubscription?.status || 'CANCELLED') as SubscriptionUpdateData['status'];
        }
      }
    }

    const store = await this.getStore(storeId);
    const oldPlanId = store?.plan_id || null;

    // Extract plan name from subscription using Shopify billing helper
    const planName = subscriptionData.name
      ? this.shopifyBilling.extractPlanNameFromSubscription({
        id: subscriptionData.id,
        name: subscriptionData.name,
        status: subscriptionData.status as any,
        createdAt: subscriptionData.createdAt || new Date().toISOString(),
        lineItems: [],
      })
      : null;

    // Get plan ID from plan_limits table
    let newPlanId: string | null = oldPlanId;
    if (planName) {
      const { data: plan } = await this.supabase
        .from('plan_limits')
        .select('id')
        .eq('plan_name', planName)
        .single();

      newPlanId = plan?.id || null;
    }

    // Use enterprise-grade plan transition manager for atomic updates
    const { PlanTrialManager } = await import('./PlanTrialManager.ts');
    const planTrialManager = new PlanTrialManager(this.supabase);

    const transitionReason = this.determineTransitionReason(subscriptionData.status, oldPlanId, newPlanId);

    if (newPlanId && newPlanId !== oldPlanId) {
      const transitionResult = await planTrialManager.transitionPlan(
        storeId,
        {
          fromPlanId: oldPlanId,
          toPlanId: newPlanId,
          reason: transitionReason,
          subscriptionId: subscriptionData.id,
          metadata: {
            ...subscriptionData,
            verifiedWithShopify: true,
          },
        },
        correlationId,
      );

      if (!transitionResult.success) {
        throw new Error(`Failed to transition plan: ${transitionResult.error}`);
      }
    } else {
      // Just update subscription ID if plan didn't change
      await this.supabase
        .from('stores')
        .update({
          subscription_id: subscriptionData.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', storeId);
    }

    const eventType = this.determineEventType(subscriptionData.status, oldPlanId, newPlanId);
    await this.recordBillingEvent(
      storeId,
      eventType,
      subscriptionData.id,
      oldPlanId,
      newPlanId,
      subscriptionData,
    );

    if (subscriptionData.status === 'ACTIVE' && newPlanId) {
      await this.recordSubscriptionPayment(storeId, newPlanId, subscriptionData.id);
    }
  }

  private determineTransitionReason(
    status: string,
    oldPlanId: string | null,
    newPlanId: string | null,
  ): 'upgrade' | 'downgrade' | 'subscription_activated' | 'subscription_cancelled' {
    if (status === 'ACTIVE' && !oldPlanId && newPlanId) {
      return 'subscription_activated';
    }
    if (status === 'CANCELLED' || status === 'EXPIRED') {
      return 'subscription_cancelled';
    }
    // For upgrade/downgrade, we'd need to compare plan tiers
    // For now, default to upgrade if plan changed
    if (oldPlanId !== newPlanId && newPlanId) {
      return 'upgrade';
    }
    return 'subscription_activated';
  }

  async cancelSubscription(storeId: string, prorate: boolean = false): Promise<boolean> {
    const store = await this.getStore(storeId);
    if (!store || !store.subscription_id) {
      return false;
    }

    try {
      const result = await retry(
        async () => this.shopifyGraphQL.cancelSubscription(store.subscription_id!, prorate),
        PlanBilling.RETRY_CONFIG,
      );

      if (!result.success || result.userErrors.length > 0) {
        return false;
      }

      const freeTrialPlan = await this.getFreeTrialPlan();
      if (freeTrialPlan) {
        await this.updateStoreToFreeTrial(storeId, freeTrialPlan.id);
        await this.recordBillingEvent(
          storeId,
          'cancelled',
          store.subscription_id,
          store.plan_id || null,
          freeTrialPlan.id,
          { prorate },
        );
        await this.recordChurnEvent(storeId, store.plan_id || null);
        await this.syncPlanLimits(storeId, freeTrialPlan.id);
      }

      return true;
    } catch {
      return false;
    }
  }

  async getBillingHistory(
    storeId: string,
    limit: number = PlanBilling.DEFAULT_BILLING_LIMIT,
  ): Promise<BillingHistory> {
    const [events, payments] = await Promise.all([
      this.getBillingEvents(storeId, limit),
      this.getPaymentHistory(storeId, limit),
    ]);

    return {
      events: this.mapEvents(events),
      payments: this.mapPayments(payments),
    };
  }

  async endTrial(
    storeId: string,
    correlationId: string = `trial-end-${Date.now()}`,
  ): Promise<boolean> {
    const store = await this.getStore(storeId);
    if (!store || !store.trial_ends_at) {
      return false;
    }

    const trialEnd = new Date(store.trial_ends_at);
    const now = new Date();

    if (now <= trialEnd) {
      return false; // Trial hasn't ended yet
    }

    // Use enterprise-grade manager for trial expiration
    const { PlanTrialManager } = await import('./PlanTrialManager.ts');
    const planTrialManager = new PlanTrialManager(this.supabase);

    // Check if store has an active subscription
    if (store.subscription_id) {
      // Store already has a subscription, just record event
      await this.recordBillingEvent(
        storeId,
        'trial_ended',
        store.subscription_id,
        store.plan_id || null,
        store.plan_id || null,
      );
      return true;
    }

    // No subscription - transition to free trial plan (paused)
    const freeTrialPlan = await this.getFreeTrialPlan();
    if (freeTrialPlan) {
      const transitionResult = await planTrialManager.transitionPlan(
        storeId,
        {
          fromPlanId: store.plan_id || null,
          toPlanId: freeTrialPlan.id,
          reason: 'trial_expired',
          subscriptionId: null,
          metadata: { trial_ended_at: trialEnd.toISOString() },
        },
        correlationId,
      );

      if (transitionResult.success) {
        await this.recordBillingEvent(
          storeId,
          'trial_ended',
          null,
          store.plan_id || null,
          freeTrialPlan.id,
        );
        return true;
      }
    }

    return false;
  }

  /**
   * Get store currency using Shopify Billing API
   * Best Practice: Use merchant's local billing currency
   */
  private async getStoreCurrency(storeId: string): Promise<string> {
    if (this.shopCurrency) {
      return this.shopCurrency;
    }

    try {
      // Best Practice: Get currency from Shopify billing preferences
      const billingPreferences = await this.shopifyBilling.getBillingPreferences();
      this.shopCurrency = billingPreferences.currencyCode;

      // Also update store's language_settings for consistency
      const store = await this.getStoreWithLanguageSettings(storeId);
      if (store) {
        await this.updateStoreCurrency(storeId, store.language_settings || {}, this.shopCurrency);
      }

      return this.shopCurrency;
    } catch {
      // Fallback to stored currency or default
      try {
        const store = await this.getStoreWithLanguageSettings(storeId);
        if (store?.language_settings?.currency) {
          this.shopCurrency = store.language_settings.currency;
          return this.shopCurrency;
        }
      } catch {
        // Ignore
      }
      return PlanBilling.DEFAULT_CURRENCY;
    }
  }

  private async recordBillingEvent(
    storeId: string,
    eventType: string,
    subscriptionId: string | null = null,
    oldPlanId: string | null = null,
    newPlanId: string | null = null,
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    try {
      await this.supabase.rpc('record_subscription_event', {
        p_store_id: storeId,
        p_event_type: eventType,
        p_subscription_id: subscriptionId,
        p_old_plan_id: oldPlanId,
        p_new_plan_id: newPlanId,
        p_metadata: metadata,
      });
    } catch {
    }
  }

  private async recordPayment(
    storeId: string,
    paymentType: string,
    amount: number,
    currencyCode: string,
    paymentStatus: string = PlanBilling.DEFAULT_PAYMENT_STATUS,
    subscriptionId: string | null = null,
    metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    try {
      await this.supabase.rpc('record_payment', {
        p_store_id: storeId,
        p_payment_type: paymentType,
        p_amount: amount,
        p_currency_code: currencyCode,
        p_payment_status: paymentStatus,
        p_subscription_id: subscriptionId,
        p_metadata: metadata,
      });
    } catch {
    }
  }

  private async syncPlanLimits(storeId: string, planId: string): Promise<void> {
    try {
      await this.supabase.rpc('sync_plan_limits_to_store', {
        p_store_id: storeId,
        p_new_plan_id: planId,
      });
    } catch {
    }
  }

  private async getPlan(planId: string): Promise<DatabasePlanRow | null> {
    const { data, error } = await this.supabase
      .from('plan_limits')
      .select('*')
      .eq('id', planId)
      .single();

    return error || !data ? null : (data as DatabasePlanRow);
  }

  private async getStore(storeId: string): Promise<DatabaseStoreRow | null> {
    const { data, error } = await this.supabase
      .from('stores')
      .select('subscription_id, plan_id, trial_ends_at, created_at')
      .eq('id', storeId)
      .single();

    return error || !data ? null : (data as DatabaseStoreRow);
  }

  private async getStoreWithLanguageSettings(storeId: string): Promise<DatabaseStoreRow | null> {
    const { data, error } = await this.supabase
      .from('stores')
      .select('language_settings')
      .eq('id', storeId)
      .single();

    return error || !data ? null : (data as DatabaseStoreRow);
  }

  private async getFreeTrialPlan(): Promise<{ readonly id: string } | null> {
    const { data, error } = await this.supabase
      .from('plan_limits')
      .select('id')
      .eq('plan_name', PlanBilling.FREE_TRIAL_PLAN_NAME)
      .single();

    return error || !data ? null : { id: data.id };
  }

  private async updateStoreToFreeTrial(storeId: string, planId: string): Promise<void> {
    await this.supabase
      .from('stores')
      .update({
        plan_id: planId,
        subscription_id: null,
        trial_ends_at: null,
      })
      .eq('id', storeId);
  }

  private async updateStoreCurrency(
    storeId: string,
    languageSettings: Readonly<Record<string, unknown>>,
    currency: string,
  ): Promise<void> {
    await this.supabase
      .from('stores')
      .update({
        language_settings: {
          ...languageSettings,
          currency,
        },
      })
      .eq('id', storeId);
  }

  private async fetchShopifyCurrency(): Promise<string> {
    // Best Practice: Use Shopify Billing API to get merchant's billing currency
    try {
      const billingPreferences = await this.shopifyBilling.getBillingPreferences();
      return billingPreferences.currencyCode || PlanBilling.DEFAULT_CURRENCY;
    } catch {
      // Fallback to shop currency query
      const query = `query { shop { currencyCode } }`;
      const result = await retry(
        async () => await this.shopifyGraphQL.query<ShopifyShopResponse>(query),
        PlanBilling.RETRY_CONFIG,
      );
      return result.shop.currencyCode || PlanBilling.DEFAULT_CURRENCY;
    }
  }

  private buildSubscriptionUpdates(
    subscriptionData: SubscriptionUpdateData,
    oldPlanId: string | null,
  ): StoreUpdateData {
    const updates: StoreUpdateData = {
      subscription_id: subscriptionData.id,
      updated_at: new Date().toISOString(),
    };

    if (subscriptionData.status === 'ACTIVE' && subscriptionData.name) {
      const planName = this.parsePlanName(subscriptionData.name);
      if (planName) {
        updates.plan_id = planName;
      }
    }

    if (subscriptionData.trialDays && subscriptionData.trialEndsAt) {
      updates.trial_ends_at = subscriptionData.trialEndsAt;
    } else if (subscriptionData.status === 'ACTIVE' && !subscriptionData.trialDays) {
      updates.trial_ends_at = null;
    }

    return updates;
  }

  private determineEventType(
    status: string,
    oldPlanId: string | null,
    newPlanId: string | null,
  ): string {
    if (status === 'ACTIVE' && oldPlanId !== newPlanId) {
      return newPlanId ? 'activated' : 'deactivated';
    }
    if (status === 'CANCELLED') return 'cancelled';
    if (status === 'EXPIRED') return 'expired';
    if (status === 'FROZEN') return 'frozen';
    return 'updated';
  }

  private async recordSubscriptionPayment(
    storeId: string,
    planId: string,
    subscriptionId: string,
  ): Promise<void> {
    const plan = await this.getPlan(planId);
    if (!plan) return;

    const currencyCode = await this.getStoreCurrency(storeId);
    await this.recordPayment(
      storeId,
      'subscription',
      this.parseFloat(plan.price_monthly),
      currencyCode,
      PlanBilling.DEFAULT_PAYMENT_STATUS,
      subscriptionId,
    );
  }

  private async recordChurnEvent(storeId: string, planId: string | null): Promise<void> {
    if (!planId) return;

    const plan = await this.getPlan(planId);
    if (!plan) return;

    const currencyCode = await this.getStoreCurrency(storeId);
    const store = await this.getStore(storeId);
    const daysAsCustomer = this.calculateDaysAsCustomer(store?.created_at);

    await this.supabase.from('churn_events').insert({
      store_id: storeId,
      churn_date: this.getTodayDateString(),
      previous_plan_id: planId,
      previous_mrr: this.parseFloat(plan.price_monthly),
      currency_code: currencyCode,
      churn_reason: PlanBilling.DEFAULT_CHURN_REASON,
      churn_type: PlanBilling.DEFAULT_CHURN_TYPE,
      days_as_customer: daysAsCustomer,
    });
  }

  private async getBillingEvents(storeId: string, limit: number): Promise<ReadonlyArray<DatabaseEventRow> | null> {
    const { data } = await this.supabase
      .from('subscription_events')
      .select('*')
      .eq('store_id', storeId)
      .order('created_at', { ascending: false })
      .limit(limit);

    return data as ReadonlyArray<DatabaseEventRow> | null;
  }

  private async getPaymentHistory(storeId: string, limit: number): Promise<ReadonlyArray<DatabasePaymentRow> | null> {
    const { data } = await this.supabase
      .from('payment_history')
      .select('*')
      .eq('store_id', storeId)
      .order('payment_date', { ascending: false })
      .limit(limit);

    return data as ReadonlyArray<DatabasePaymentRow> | null;
  }

  private mapEvents(events: ReadonlyArray<DatabaseEventRow> | null): ReadonlyArray<BillingHistory['events'][number]> {
    if (!events) return [];
    return events.map((e) => ({
      id: e.id,
      eventType: e.event_type,
      createdAt: e.created_at,
      metadata: e.metadata,
    }));
  }

  private mapPayments(payments: ReadonlyArray<DatabasePaymentRow> | null): ReadonlyArray<BillingHistory['payments'][number]> {
    if (!payments) return [];
    return payments.map((p) => ({
      id: p.id,
      paymentType: p.payment_type,
      amount: this.parseFloat(p.amount),
      currencyCode: p.currency_code,
      paymentStatus: p.payment_status,
      paymentDate: p.payment_date || p.created_at,
    }));
  }

  private parsePlanName(subscriptionName: string): string | null {
    const lowerName = subscriptionName.toLowerCase();
    for (const [pattern, planName] of Object.entries(PlanBilling.PLAN_NAME_PATTERNS)) {
      if (lowerName.includes(pattern)) {
        return planName;
      }
    }
    return null;
  }

  private parseFloat(value: string | number): number {
    return typeof value === 'string' ? parseFloat(value) : value;
  }

  private getTodayDateString(): string {
    return new Date().toISOString().split('T')[0];
  }

  private calculateDaysAsCustomer(createdAt: string | null | undefined): number {
    if (!createdAt) return 0;
    return Math.floor(
      (new Date().getTime() - new Date(createdAt).getTime()) / PlanBilling.MILLISECONDS_PER_DAY,
    );
  }
}
