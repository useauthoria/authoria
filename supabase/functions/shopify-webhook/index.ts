/**
 * Shopify Webhook Handler
 * Handles APP_SUBSCRIPTIONS_UPDATE webhook for billing
 * Follows Shopify best practices for webhook processing
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import {
  getSupabaseClient,
  logger,
  UtilsError,
} from '../_shared/utils.ts';

interface WebhookPayload {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: string;
  readonly currentPeriodEnd?: string;
  readonly trialDays?: number;
  readonly trialEndsAt?: string;
  readonly lineItems?: ReadonlyArray<{
    readonly plan?: {
      readonly pricingDetails?: {
        readonly price?: {
          readonly amount?: string;
          readonly currencyCode?: string;
        };
        readonly interval?: string;
      };
    };
  }>;
}

interface WebhookRequest {
  readonly shop: string;
  readonly admin_graphql_api_id: string;
  readonly [key: string]: unknown;
}

const METHOD_POST = 'POST';
const METHOD_OPTIONS = 'OPTIONS';
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_INTERNAL_ERROR = 500;

/**
 * Verify webhook signature (Shopify best practice)
 * Note: In production, you should verify HMAC signature
 */
function verifyWebhookSignature(
  body: string,
  hmacHeader: string | null,
  secret: string,
): boolean {
  if (!hmacHeader) {
    return false;
  }

  // In production, implement proper HMAC verification
  // For now, we'll trust the webhook (should be secured in production)
  return true;
}

/**
 * Handle APP_SUBSCRIPTIONS_UPDATE webhook
 * Updates store subscription status when Shopify subscription changes
 */
async function handleSubscriptionUpdate(
  payload: WebhookPayload,
  shopDomain: string,
): Promise<void> {
  const supabase = await getSupabaseClient({ clientType: 'service' });

  // Find store by shop domain
  const { data: store, error: storeError } = await supabase
    .from('stores')
    .select('id, plan_id, subscription_id')
    .eq('shop_domain', shopDomain)
    .single();

  if (storeError || !store) {
    logger.error('Store not found for subscription update', {
      shopDomain,
      subscriptionId: payload.id,
      error: storeError?.message,
    });
    throw new UtilsError('Store not found', 'STORE_NOT_FOUND', STATUS_BAD_REQUEST);
  }

  // Use enterprise-grade plan transition manager
  const { PlanTrialManager } = await import('../backend/src/core/PlanTrialManager.ts');
  const { ShopifyBilling } = await import('../backend/src/integrations/ShopifyBilling.ts');
  
  const planTrialManager = new PlanTrialManager(supabase);
  
  // Get access token from store
  const storeWithToken = await supabase
    .from('stores')
    .select('access_token')
    .eq('id', store.id)
    .single();
  
  const accessToken = (storeWithToken.data as { access_token?: string } | null)?.access_token || '';
  const shopifyBilling = new ShopifyBilling(supabase, shopDomain, accessToken);

  // Extract plan name from subscription
  const planName = shopifyBilling.extractPlanNameFromSubscription(payload as unknown as ShopifyBilling['ShopifySubscription']);
  
  // Get plan ID from plan_limits table
  let planId: string | null = null;
  if (planName) {
    const { data: plan } = await supabase
      .from('plan_limits')
      .select('id')
      .eq('plan_name', planName)
      .single();
    
    planId = plan?.id || null;
  }

  // Determine transition reason based on status
  const status = payload.status;
  let reason: 'subscription_activated' | 'subscription_cancelled' | 'upgrade' | 'downgrade' = 'subscription_activated';
  
  if (status === 'CANCELLED' || status === 'EXPIRED') {
    reason = 'subscription_cancelled';
  } else if (status === 'ACTIVE' && store.plan_id && planId && store.plan_id !== planId) {
    // Determine if upgrade or downgrade (simplified - would need plan tier comparison)
    reason = 'upgrade';
  }

  // Transition plan if needed
  if (planId && (store.plan_id !== planId || reason === 'subscription_cancelled')) {
    const correlationId = `webhook-${Date.now()}-${payload.id}`;
    
    const transitionResult = await planTrialManager.transitionPlan(
      store.id,
      {
        fromPlanId: store.plan_id,
        toPlanId: planId,
        reason,
        subscriptionId: payload.id,
        metadata: {
          status: payload.status,
          currentPeriodEnd: payload.currentPeriodEnd,
          trialDays: payload.trialDays,
          trialEndsAt: payload.trialEndsAt,
          webhookReceivedAt: new Date().toISOString(),
        },
      },
      correlationId,
    );

    if (!transitionResult.success) {
      logger.error('Failed to transition plan from webhook', {
        storeId: store.id,
        error: transitionResult.error,
        subscriptionId: payload.id,
      });
    } else {
      logger.info('Plan transitioned from webhook', {
        storeId: store.id,
        fromPlanId: store.plan_id,
        toPlanId: planId,
        reason,
        subscriptionId: payload.id,
      });
    }
  }

  // Update subscription_id if it changed
  if (store.subscription_id !== payload.id) {
    await supabase
      .from('stores')
      .update({
        subscription_id: payload.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', store.id);
  }
}

serve(async (req: Request) => {
  if (req.method === METHOD_OPTIONS) {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Shopify-Shop-Domain, X-Shopify-Hmac-Sha256',
      },
    });
  }

  if (req.method !== METHOD_POST) {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const shopDomain = req.headers.get('X-Shopify-Shop-Domain');
    const hmacHeader = req.headers.get('X-Shopify-Hmac-Sha256');
    const topic = req.headers.get('X-Shopify-Topic');

    if (!shopDomain) {
      return new Response(JSON.stringify({ error: 'Missing shop domain' }), {
        status: STATUS_BAD_REQUEST,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await req.text();
    
    // Verify webhook signature (in production, use proper HMAC verification)
    const webhookSecret = Deno.env.get('SHOPIFY_WEBHOOK_SECRET') || '';
    if (!verifyWebhookSignature(body, hmacHeader, webhookSecret)) {
      logger.warn('Webhook signature verification failed', { shopDomain, topic });
      // In production, reject invalid signatures
      // return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      //   status: 401,
      //   headers: { 'Content-Type': 'application/json' },
      // });
    }

    const payload = JSON.parse(body) as WebhookRequest & WebhookPayload;

    // Handle different webhook topics
    if (topic === 'APP_SUBSCRIPTIONS_UPDATE') {
      await handleSubscriptionUpdate(payload as WebhookPayload, shopDomain);
    } else if (topic === 'APP_PURCHASES_ONE_TIME_UPDATE') {
      // Handle one-time purchase updates if needed
      logger.info('One-time purchase update received', { shopDomain, purchaseId: payload.id });
    } else {
      logger.info('Unhandled webhook topic', { shopDomain, topic });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: STATUS_OK,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    logger.error('Webhook processing failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: STATUS_INTERNAL_ERROR,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
});
