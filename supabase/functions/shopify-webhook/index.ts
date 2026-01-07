import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import {
  getSupabaseClient,
  logger,
  UtilsError,
  SupabaseClientError,
  createCORSHeaders,
} from '../_shared/utils.ts';

interface DenoEnv {
  readonly get?: (key: string) => string | undefined;
}

interface DenoGlobal {
  readonly Deno?: {
    readonly env?: DenoEnv;
  };
}

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
  readonly shop?: string;
  readonly admin_graphql_api_id?: string;
  readonly [key: string]: unknown;
}

interface WebhookResponse {
  readonly success?: boolean;
  readonly error?: string;
  readonly correlationId?: string;
}

interface StoreData {
  readonly id: string;
  readonly plan_id?: string | null;
  readonly subscription_id?: string | null;
  readonly access_token?: string;
}

interface PlanData {
  readonly id: string;
}

interface TransitionReason {
  readonly type: 'subscription_activated' | 'subscription_cancelled' | 'upgrade' | 'downgrade';
}

const ENV_SHOPIFY_WEBHOOK_SECRET = 'SHOPIFY_WEBHOOK_SECRET' as const;
const ENV_CORS_ORIGINS = 'CORS_ORIGINS' as const;
const METHOD_POST = 'POST' as const;
const METHOD_OPTIONS = 'OPTIONS' as const;
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_METHOD_NOT_ALLOWED = 405;
const STATUS_INTERNAL_ERROR = 500;
const STATUS_NO_CONTENT = 204;
const HEADER_X_SHOPIFY_SHOP_DOMAIN = 'X-Shopify-Shop-Domain' as const;
const HEADER_X_SHOPIFY_HMAC_SHA256 = 'X-Shopify-Hmac-Sha256' as const;
const HEADER_X_SHOPIFY_TOPIC = 'X-Shopify-Topic' as const;
const HEADER_CONTENT_TYPE = 'Content-Type' as const;
const HEADER_CONTENT_TYPE_JSON = 'application/json' as const;
const HEADER_X_CORRELATION_ID = 'x-correlation-id' as const;
const CORRELATION_PREFIX = 'webhook-' as const;
const ID_RADIX = 36;
const ID_LENGTH = 9;
const ERROR_MISSING_SHOP_DOMAIN = 'Missing shop domain' as const;
const ERROR_INVALID_SIGNATURE = 'Invalid signature' as const;
const ERROR_MISSING_SIGNATURE = 'Missing signature' as const;
const ERROR_STORE_NOT_FOUND = 'Store not found' as const;
const ERROR_METHOD_NOT_ALLOWED = 'Method not allowed' as const;
const ERROR_INVALID_JSON = 'Invalid JSON in request body' as const;
const ERROR_INTERNAL_SERVER = 'Internal server error' as const;
const ERROR_CODE_STORE_NOT_FOUND = 'STORE_NOT_FOUND' as const;
const ERROR_CODE_INVALID_SIGNATURE = 'INVALID_SIGNATURE' as const;
const ERROR_CODE_INTERNAL_ERROR = 'INTERNAL_ERROR' as const;
const TOPIC_APP_SUBSCRIPTIONS_UPDATE = 'APP_SUBSCRIPTIONS_UPDATE' as const;
const TOPIC_APP_PURCHASES_ONE_TIME_UPDATE = 'APP_PURCHASES_ONE_TIME_UPDATE' as const;
const STATUS_CANCELLED = 'CANCELLED' as const;
const STATUS_EXPIRED = 'EXPIRED' as const;
const STATUS_ACTIVE = 'ACTIVE' as const;
const REASON_SUBSCRIPTION_ACTIVATED = 'subscription_activated' as const;
const REASON_SUBSCRIPTION_CANCELLED = 'subscription_cancelled' as const;
const REASON_UPGRADE = 'upgrade' as const;
const TABLE_STORES = 'stores' as const;
const TABLE_PLAN_LIMITS = 'plan_limits' as const;
const COLUMN_ID = 'id' as const;
const COLUMN_SHOP_DOMAIN = 'shop_domain' as const;
const COLUMN_PLAN_ID = 'plan_id' as const;
const COLUMN_SUBSCRIPTION_ID = 'subscription_id' as const;
const COLUMN_ACCESS_TOKEN = 'access_token' as const;
const COLUMN_UPDATED_AT = 'updated_at' as const;
const COLUMN_PLAN_NAME = 'plan_name' as const;

function getEnv(key: string, defaultValue = ''): string {
  try {
    const deno = (globalThis as DenoGlobal).Deno;
    return deno?.env?.get?.(key) ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

const CONFIG = {
  WEBHOOK_SECRET: getEnv(ENV_SHOPIFY_WEBHOOK_SECRET, ''),
  CORS_ORIGINS: getEnv(ENV_CORS_ORIGINS, '*').split(','),
} as const;

function generateCorrelationId(): string {
  return `${CORRELATION_PREFIX}${Date.now()}-${Math.random().toString(ID_RADIX).substring(2, 2 + ID_LENGTH)}`;
}

async function verifyWebhookSignature(
  body: string,
  hmacHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!hmacHeader) {
    return false;
  }

  if (!secret) {
    logger.warn('Webhook secret not configured, skipping signature verification');
    return true;
  }

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(body);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, messageData);
  const hashArray = Array.from(new Uint8Array(signature));
  const calculatedHmac = btoa(String.fromCharCode(...hashArray));

  return hmacHeader === calculatedHmac;
}

function createSuccessResponse(
  correlationId: string,
  request: Request,
): Response {
  const response: WebhookResponse = {
    success: true,
    correlationId,
  };
  return new Response(JSON.stringify(response), {
    status: STATUS_OK,
    headers: {
      ...createCORSHeaders(request, CONFIG.CORS_ORIGINS),
      [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON,
      [HEADER_X_CORRELATION_ID]: correlationId,
    },
  });
}

function createErrorResponse(
  error: string,
  status: number,
  correlationId: string,
  request: Request,
  errorCode?: string,
): Response {
  const response: WebhookResponse = {
    error,
    correlationId,
    ...(errorCode && { errorCode }),
  };
  return new Response(JSON.stringify(response), {
    status,
    headers: {
      ...createCORSHeaders(request, CONFIG.CORS_ORIGINS),
      [HEADER_CONTENT_TYPE]: HEADER_CONTENT_TYPE_JSON,
      [HEADER_X_CORRELATION_ID]: correlationId,
    },
  });
}

function determineTransitionReason(
  status: string,
  currentPlanId: string | null | undefined,
  newPlanId: string | null,
): TransitionReason['type'] {
  if (status === STATUS_CANCELLED || status === STATUS_EXPIRED) {
    return REASON_SUBSCRIPTION_CANCELLED;
  }

  if (status === STATUS_ACTIVE && currentPlanId && newPlanId && currentPlanId !== newPlanId) {
    return REASON_UPGRADE;
  }

  return REASON_SUBSCRIPTION_ACTIVATED;
}

async function handleSubscriptionUpdate(
  payload: WebhookPayload,
  shopDomain: string,
  correlationId: string,
): Promise<void> {
  const supabase = await getSupabaseClient({ clientType: 'service' });

  const { data: store, error: storeError } = await supabase
    .from(TABLE_STORES)
    .select(`${COLUMN_ID}, ${COLUMN_PLAN_ID}, ${COLUMN_SUBSCRIPTION_ID}, ${COLUMN_ACCESS_TOKEN}`)
    .eq(COLUMN_SHOP_DOMAIN, shopDomain)
    .single();

  if (storeError || !store) {
    logger.error('Store not found for subscription update', {
      correlationId,
      shopDomain,
      subscriptionId: payload.id,
      error: storeError?.message,
    });
    throw new UtilsError(ERROR_STORE_NOT_FOUND, ERROR_CODE_STORE_NOT_FOUND as string, STATUS_BAD_REQUEST);
  }

  const storeData = store as unknown as StoreData;

  const { PlanManager } = await import('../backend/src/core/PlanManager.ts');
  const { ShopifyBilling } = await import('../backend/src/integrations/ShopifyBilling.ts');

  const planManager = new PlanManager(supabase);
  const shopifyBilling = new ShopifyBilling(supabase, shopDomain, storeData.access_token || '');

  const planName = shopifyBilling.extractPlanNameFromSubscription(payload as unknown as Parameters<typeof shopifyBilling.extractPlanNameFromSubscription>[0]);

  let planId: string | null = null;
  if (planName) {
    const { data: plan } = await supabase
      .from(TABLE_PLAN_LIMITS)
      .select(COLUMN_ID)
      .eq(COLUMN_PLAN_NAME, planName)
      .single();

    planId = (plan as PlanData | null)?.id || null;
  }

  const reason = determineTransitionReason(payload.status, storeData.plan_id, planId);

  if (planId && (storeData.plan_id !== planId || reason === REASON_SUBSCRIPTION_CANCELLED)) {
    const transitionResult = await planManager.transitionPlan(
      storeData.id,
      {
        fromPlanId: storeData.plan_id || undefined,
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
        correlationId,
        storeId: storeData.id,
        error: transitionResult.error,
        subscriptionId: payload.id,
      });
    } else {
      logger.info('Plan transitioned from webhook', {
        correlationId,
        storeId: storeData.id,
        fromPlanId: storeData.plan_id,
        toPlanId: planId,
        reason,
        subscriptionId: payload.id,
      });
    }
  }

  if (storeData.subscription_id !== payload.id) {
    const { error: updateError } = await supabase
      .from(TABLE_STORES)
      .update({
        [COLUMN_SUBSCRIPTION_ID]: payload.id,
        [COLUMN_UPDATED_AT]: new Date().toISOString(),
      })
      .eq(COLUMN_ID, storeData.id);

    if (updateError) {
      logger.error('Failed to update subscription ID', {
        correlationId,
        storeId: storeData.id,
        error: updateError.message,
      });
    }
  }
}

async function handleWebhookRequest(req: Request): Promise<Response> {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();
  const shopDomain = req.headers.get(HEADER_X_SHOPIFY_SHOP_DOMAIN);
  const hmacHeader = req.headers.get(HEADER_X_SHOPIFY_HMAC_SHA256);
  const topic = req.headers.get(HEADER_X_SHOPIFY_TOPIC);

  if (!shopDomain) {
    logger.warn('Missing shop domain in webhook request', { correlationId });
    return createErrorResponse(ERROR_MISSING_SHOP_DOMAIN, STATUS_BAD_REQUEST, correlationId, req);
  }

  let body: string;
  try {
    body = await req.text();
  } catch (error) {
    logger.error('Failed to read webhook body', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return createErrorResponse(ERROR_INTERNAL_SERVER, STATUS_INTERNAL_ERROR, correlationId, req, ERROR_CODE_INTERNAL_ERROR as string);
  }

  const isValidSignature = await verifyWebhookSignature(body, hmacHeader, CONFIG.WEBHOOK_SECRET);
  if (!isValidSignature) {
    logger.warn('Webhook signature verification failed', {
      correlationId,
      shopDomain,
      topic,
    });
    return createErrorResponse(ERROR_INVALID_SIGNATURE, STATUS_UNAUTHORIZED, correlationId, req, ERROR_CODE_INVALID_SIGNATURE as string);
  }

  let payload: WebhookRequest & WebhookPayload;
  try {
    payload = JSON.parse(body) as WebhookRequest & WebhookPayload;
  } catch (error) {
    logger.error('Failed to parse webhook payload', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return createErrorResponse(ERROR_INVALID_JSON, STATUS_BAD_REQUEST, correlationId, req);
  }

  if (topic === TOPIC_APP_SUBSCRIPTIONS_UPDATE) {
    try {
      await handleSubscriptionUpdate(payload as WebhookPayload, shopDomain, correlationId);
    } catch (error) {
      logger.error('Failed to handle subscription update', {
        correlationId,
        shopDomain,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (error instanceof UtilsError) {
        return createErrorResponse(
          error.message,
          error.statusCode,
          correlationId,
          req,
          error.code,
        );
      }

      return createErrorResponse(ERROR_INTERNAL_SERVER, STATUS_INTERNAL_ERROR, correlationId, req, ERROR_CODE_INTERNAL_ERROR as string);
    }
  } else if (topic === TOPIC_APP_PURCHASES_ONE_TIME_UPDATE) {
    logger.info('One-time purchase update received', {
      correlationId,
      shopDomain,
      purchaseId: payload.id,
    });
  } else {
    logger.info('Unhandled webhook topic', {
      correlationId,
      shopDomain,
      topic,
    });
  }

  return createSuccessResponse(correlationId, req);
}

serve(async (req: Request) => {
  const correlationId = req.headers.get(HEADER_X_CORRELATION_ID) ?? generateCorrelationId();

  if (req.method === METHOD_OPTIONS) {
    return new Response(null, {
      status: STATUS_NO_CONTENT,
      headers: createCORSHeaders(req, CONFIG.CORS_ORIGINS),
    });
  }

  if (req.method !== METHOD_POST) {
    logger.warn('Method not allowed', { correlationId, method: req.method });
    return createErrorResponse(
      ERROR_METHOD_NOT_ALLOWED,
      STATUS_METHOD_NOT_ALLOWED,
      correlationId,
      req,
    );
  }

  try {
    return await handleWebhookRequest(req);
  } catch (error) {
    logger.error('Webhook processing failed', {
      correlationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_INTERNAL_SERVER,
      error instanceof UtilsError ? error.statusCode : STATUS_INTERNAL_ERROR,
      correlationId,
      req,
      error instanceof UtilsError ? error.code : ERROR_CODE_INTERNAL_ERROR as string,
    );
  }
});
