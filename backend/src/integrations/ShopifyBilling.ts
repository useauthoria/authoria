import type { SupabaseClient } from '@supabase/supabase-js';
import { ShopifyGraphQL } from './ShopifyClient.ts';
import { retry } from '../utils/error-handling.ts';

export interface ShopifySubscription {
  readonly id: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'PENDING' | 'CANCELLED' | 'EXPIRED' | 'DECLINED' | 'FROZEN';
  readonly createdAt: string;
  readonly currentPeriodEnd?: string;
  readonly trialDays?: number;
  readonly trialEndsAt?: string;
  readonly lineItems: ReadonlyArray<{
    readonly id: string;
    readonly plan: {
      readonly pricingDetails: {
        readonly price: {
          readonly amount: string;
          readonly currencyCode: string;
        };
        readonly interval: 'EVERY_30_DAYS' | 'ANNUAL';
      };
    };
  }>;
}

export interface CreateSubscriptionInput {
  readonly name: string;
  readonly returnUrl: string;
  readonly test?: boolean;
  readonly trialDays?: number;
  readonly lineItems: ReadonlyArray<{
    readonly plan: {
      readonly appRecurringPricingDetails: {
        readonly price: {
          readonly amount: number;
          readonly currencyCode: string;
        };
        readonly interval: 'EVERY_30_DAYS' | 'ANNUAL';
      };
    };
  }>;
}

export interface CreateSubscriptionResult {
  readonly confirmationUrl: string | null;
  readonly subscription: ShopifySubscription | null;
  readonly userErrors: ReadonlyArray<{
    readonly field: readonly string[];
    readonly message: string;
  }>;
}

export interface ShopBillingPreferences {
  readonly currencyCode: string;
  readonly countryCode: string;
}

export interface ActiveSubscriptionResult {
  readonly hasActivePayment: boolean;
  readonly subscription: ShopifySubscription | null;
  readonly error?: string;
}

interface BillingPreferencesCacheEntry {
  readonly data: ShopBillingPreferences;
  readonly expiresAt: number;
}

interface SubscriptionCacheEntry {
  readonly data: ShopifySubscription | null;
  readonly expiresAt: number;
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

const validateShopDomain = (shopDomain: string): void => {
  if (!shopDomain || typeof shopDomain !== 'string' || shopDomain.trim().length === 0) {
    throw new Error('Invalid shop domain: must be a non-empty string');
  }
  if (!shopDomain.includes('.') || shopDomain.length > 255) {
    throw new Error('Invalid shop domain format');
  }
};

const validateAccessToken = (accessToken: string): void => {
  if (!accessToken || typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    throw new Error('Invalid access token: must be a non-empty string');
  }
  if (accessToken.length > 10000) {
    throw new Error('Invalid access token: exceeds maximum length');
  }
};

const validateSubscriptionId = (subscriptionId: string): void => {
  if (!subscriptionId || typeof subscriptionId !== 'string' || subscriptionId.trim().length === 0) {
    throw new Error('Invalid subscription ID: must be a non-empty string');
  }
  if (subscriptionId.length > 100) {
    throw new Error('Invalid subscription ID: exceeds maximum length');
  }
};

const validateReturnUrl = (returnUrl: string): void => {
  if (!returnUrl || typeof returnUrl !== 'string' || returnUrl.trim().length === 0) {
    throw new Error('Invalid return URL: must be a non-empty string');
  }
  try {
    new URL(returnUrl);
  } catch {
    throw new Error(`Invalid return URL format: ${returnUrl}`);
  }
  if (returnUrl.length > 2000) {
    throw new Error('Invalid return URL: exceeds maximum length');
  }
};

const validateSubscriptionName = (name: string): void => {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Invalid subscription name: must be a non-empty string');
  }
  if (name.length > 200) {
    throw new Error('Invalid subscription name: exceeds maximum length');
  }
};

const validatePrice = (price: { amount: number; currencyCode: string }): void => {
  if (!price || typeof price !== 'object') {
    throw new Error('Invalid price: must be an object');
  }
  if (typeof price.amount !== 'number' || price.amount < 0 || price.amount > 1000000) {
    throw new Error('Invalid price amount: must be a number between 0 and 1000000');
  }
  if (!price.currencyCode || typeof price.currencyCode !== 'string' || price.currencyCode.length !== 3) {
    throw new Error('Invalid currency code: must be a 3-character string');
  }
};

const validateTrialDays = (trialDays: number | undefined): void => {
  if (trialDays !== undefined) {
    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) {
      throw new Error('Invalid trial days: must be an integer between 0 and 365');
    }
  }
};

const validateLineItems = (lineItems: ReadonlyArray<unknown>): void => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('Invalid line items: must be a non-empty array');
  }
  if (lineItems.length > 10) {
    throw new Error('Invalid line items: exceeds maximum count of 10');
  }
  for (const item of lineItems) {
    if (!item || typeof item !== 'object') {
      throw new Error('Invalid line item: must be an object');
    }
  }
};

const validateAppHandle = (appHandle: string): void => {
  if (!appHandle || typeof appHandle !== 'string' || appHandle.trim().length === 0) {
    throw new Error('Invalid app handle: must be a non-empty string');
  }
  if (appHandle.length > 100) {
    throw new Error('Invalid app handle: exceeds maximum length');
  }
};

const isSubscriptionStatus = (status: string): status is ShopifySubscription['status'] => {
  return ['ACTIVE', 'PENDING', 'CANCELLED', 'EXPIRED', 'DECLINED', 'FROZEN'].includes(status);
};

export class ShopifyBilling {
  private readonly shopifyGraphQL: ShopifyGraphQL;
  private readonly shopDomain: string;
  private readonly accessToken: string;
  private readonly billingPreferencesCache: Map<string, BillingPreferencesCacheEntry>;
  private readonly subscriptionCache: Map<string, SubscriptionCacheEntry>;

  private static readonly SERVICE_NAME = 'ShopifyBilling';
  private static readonly DEFAULT_CURRENCY_CODE = 'USD';
  private static readonly DEFAULT_COUNTRY_CODE = 'US';
  private static readonly BILLING_PREFERENCES_CACHE_TTL_MS = 60 * 60 * 1000;
  private static readonly SUBSCRIPTION_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 3,
    initialDelay: 1000,
    retryableErrors: ['network', 'timeout', 'server_error'] as const,
  } as const;

  constructor(
    shopDomain: string,
    accessToken: string,
    supabase?: SupabaseClient,
  ) {
    validateShopDomain(shopDomain);
    validateAccessToken(accessToken);
    this.shopDomain = shopDomain;
    this.accessToken = accessToken;
    this.shopifyGraphQL = new ShopifyGraphQL(shopDomain, accessToken);
    this.billingPreferencesCache = new Map();
    this.subscriptionCache = new Map();
  }

  destroy(): void {
    this.billingPreferencesCache.clear();
    this.subscriptionCache.clear();
  }

  async getBillingPreferences(): Promise<ShopBillingPreferences> {
    const cacheKey = `billing-preferences:${this.shopDomain}`;
    const cached = this.billingPreferencesCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const query = `
      query {
        shop {
          billingPreferences {
            currencyCode
            countryCode
          }
        }
      }
    `;

    const startTime = Date.now();
    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{ shop: { billingPreferences: ShopBillingPreferences } }>(query),
        {
          ...ShopifyBilling.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', ShopifyBilling.SERVICE_NAME, 'Retrying billing preferences fetch', {
              attempt,
              shopDomain: this.shopDomain,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      const preferences = result.shop.billingPreferences || {
        currencyCode: ShopifyBilling.DEFAULT_CURRENCY_CODE,
        countryCode: ShopifyBilling.DEFAULT_COUNTRY_CODE,
      };

      this.billingPreferencesCache.set(cacheKey, {
        data: preferences,
        expiresAt: Date.now() + ShopifyBilling.BILLING_PREFERENCES_CACHE_TTL_MS,
      });

      const duration = Date.now() - startTime;
      structuredLog('info', ShopifyBilling.SERVICE_NAME, 'Billing preferences fetched', {
        shopDomain: this.shopDomain,
        currencyCode: preferences.currencyCode,
        durationMs: duration,
      });

      return preferences;
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('warn', ShopifyBilling.SERVICE_NAME, 'Failed to fetch billing preferences, using defaults', {
        shopDomain: this.shopDomain,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      return {
        currencyCode: ShopifyBilling.DEFAULT_CURRENCY_CODE,
        countryCode: ShopifyBilling.DEFAULT_COUNTRY_CODE,
      };
    }
  }

  async checkActiveSubscription(): Promise<ActiveSubscriptionResult> {
    const query = `
      query {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            createdAt
            currentPeriodEnd
            trialDays
            trialEndsAt
            lineItems {
              id
              plan {
                ... on AppRecurringPricing {
                  pricingDetails {
                    price {
                      amount
                      currencyCode
                    }
                    interval
                  }
                }
              }
            }
          }
        }
      }
    `;

    const startTime = Date.now();
    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{
          currentAppInstallation: {
            activeSubscriptions: ReadonlyArray<ShopifySubscription>;
          };
        }>(query),
        {
          ...ShopifyBilling.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', ShopifyBilling.SERVICE_NAME, 'Retrying active subscription check', {
              attempt,
              shopDomain: this.shopDomain,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      const subscriptions = result.currentAppInstallation?.activeSubscriptions || [];
      const activeSubscription = subscriptions.find(
        (sub) => sub.status === 'ACTIVE' || sub.status === 'PENDING',
      );

      const duration = Date.now() - startTime;
      structuredLog('info', ShopifyBilling.SERVICE_NAME, 'Active subscription checked', {
        shopDomain: this.shopDomain,
        hasActivePayment: !!activeSubscription,
        durationMs: duration,
      });

      return {
        hasActivePayment: !!activeSubscription,
        subscription: activeSubscription || null,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', ShopifyBilling.SERVICE_NAME, 'Failed to check active subscription', {
        shopDomain: this.shopDomain,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      return {
        hasActivePayment: false,
        subscription: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<CreateSubscriptionResult> {
    validateSubscriptionName(input.name);
    validateReturnUrl(input.returnUrl);
    validateTrialDays(input.trialDays);
    validateLineItems(input.lineItems);
    for (const item of input.lineItems) {
      if (item.plan?.appRecurringPricingDetails?.price) {
        validatePrice(item.plan.appRecurringPricingDetails.price);
      }
    }

    const mutation = `
      mutation appSubscriptionCreate($name: String!, $returnUrl: URL!, $test: Boolean, $trialDays: Int, $lineItems: [AppSubscriptionLineItemInput!]!) {
        appSubscriptionCreate(
          name: $name
          returnUrl: $returnUrl
          test: $test
          trialDays: $trialDays
          lineItems: $lineItems
        ) {
          confirmationUrl
          appSubscription {
            id
            name
            status
            createdAt
            currentPeriodEnd
            trialDays
            trialEndsAt
            lineItems {
              id
              plan {
                ... on AppRecurringPricing {
                  pricingDetails {
                    price {
                      amount
                      currencyCode
                    }
                    interval
                  }
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      name: input.name,
      returnUrl: input.returnUrl,
      test: input.test ?? false,
      trialDays: input.trialDays,
      lineItems: input.lineItems.map((item) => ({
        plan: {
          appRecurringPricingDetails: item.plan.appRecurringPricingDetails,
        },
      })),
    };

    const startTime = Date.now();
    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{
          appSubscriptionCreate: {
            confirmationUrl: string | null;
            appSubscription: ShopifySubscription | null;
            userErrors: ReadonlyArray<{ field: readonly string[]; message: string }>;
          };
        }>(mutation, variables),
        {
          ...ShopifyBilling.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', ShopifyBilling.SERVICE_NAME, 'Retrying subscription creation', {
              attempt,
              shopDomain: this.shopDomain,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      const duration = Date.now() - startTime;
      structuredLog('info', ShopifyBilling.SERVICE_NAME, 'Subscription created', {
        shopDomain: this.shopDomain,
        subscriptionId: result.appSubscriptionCreate.appSubscription?.id,
        hasConfirmationUrl: !!result.appSubscriptionCreate.confirmationUrl,
        durationMs: duration,
      });

      return {
        confirmationUrl: result.appSubscriptionCreate.confirmationUrl,
        subscription: result.appSubscriptionCreate.appSubscription,
        userErrors: result.appSubscriptionCreate.userErrors,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', ShopifyBilling.SERVICE_NAME, 'Failed to create subscription', {
        shopDomain: this.shopDomain,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      return {
        confirmationUrl: null,
        subscription: null,
        userErrors: [
          {
            field: [],
            message: error instanceof Error ? error.message : 'Failed to create subscription',
          },
        ],
      };
    }
  }

  async createOneTimePurchase(
    name: string,
    price: { amount: number; currencyCode: string },
    returnUrl: string,
    test: boolean = false,
  ): Promise<{ confirmationUrl: string | null; userErrors: ReadonlyArray<{ field: readonly string[]; message: string }> }> {
    validateSubscriptionName(name);
    validatePrice(price);
    validateReturnUrl(returnUrl);

    const mutation = `
      mutation appPurchaseOneTimeCreate($name: String!, $price: MoneyInput!, $returnUrl: URL!, $test: Boolean!) {
        appPurchaseOneTimeCreate(
          name: $name
          price: $price
          returnUrl: $returnUrl
          test: $test
        ) {
          confirmationUrl
          appPurchaseOneTime {
            id
            name
            status
            createdAt
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      name,
      price: {
        amount: price.amount.toFixed(2),
        currencyCode: price.currencyCode,
      },
      returnUrl,
      test,
    };

    const startTime = Date.now();
    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{
          appPurchaseOneTimeCreate: {
            confirmationUrl: string | null;
            userErrors: ReadonlyArray<{ field: readonly string[]; message: string }>;
          };
        }>(mutation, variables),
        {
          ...ShopifyBilling.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', ShopifyBilling.SERVICE_NAME, 'Retrying one-time purchase creation', {
              attempt,
              shopDomain: this.shopDomain,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      const duration = Date.now() - startTime;
      structuredLog('info', ShopifyBilling.SERVICE_NAME, 'One-time purchase created', {
        shopDomain: this.shopDomain,
        hasConfirmationUrl: !!result.appPurchaseOneTimeCreate.confirmationUrl,
        durationMs: duration,
      });

      return {
        confirmationUrl: result.appPurchaseOneTimeCreate.confirmationUrl,
        userErrors: result.appPurchaseOneTimeCreate.userErrors,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', ShopifyBilling.SERVICE_NAME, 'Failed to create one-time purchase', {
        shopDomain: this.shopDomain,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      return {
        confirmationUrl: null,
        userErrors: [
          {
            field: [],
            message: error instanceof Error ? error.message : 'Failed to create one-time purchase',
          },
        ],
      };
    }
  }

  async cancelSubscription(
    subscriptionId: string,
    prorate: boolean = false,
  ): Promise<{ success: boolean; userErrors: ReadonlyArray<{ field: readonly string[]; message: string }> }> {
    validateSubscriptionId(subscriptionId);

    const mutation = `
      mutation appSubscriptionCancel($id: ID!, $prorate: Boolean!) {
        appSubscriptionCancel(
          id: $id
          prorate: $prorate
        ) {
          appSubscription {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      id: subscriptionId,
      prorate,
    };

    const startTime = Date.now();
    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{
          appSubscriptionCancel: {
            appSubscription: { id: string; status: string } | null;
            userErrors: ReadonlyArray<{ field: readonly string[]; message: string }>;
          };
        }>(mutation, variables),
        {
          ...ShopifyBilling.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', ShopifyBilling.SERVICE_NAME, 'Retrying subscription cancellation', {
              attempt,
              shopDomain: this.shopDomain,
              subscriptionId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      const success = result.appSubscriptionCancel.appSubscription !== null;
      const duration = Date.now() - startTime;
      structuredLog('info', ShopifyBilling.SERVICE_NAME, 'Subscription cancelled', {
        shopDomain: this.shopDomain,
        subscriptionId,
        success,
        durationMs: duration,
      });

      this.subscriptionCache.delete(`subscription:${subscriptionId}`);

      return {
        success,
        userErrors: result.appSubscriptionCancel.userErrors,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', ShopifyBilling.SERVICE_NAME, 'Failed to cancel subscription', {
        shopDomain: this.shopDomain,
        subscriptionId,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      return {
        success: false,
        userErrors: [
          {
            field: [],
            message: error instanceof Error ? error.message : 'Failed to cancel subscription',
          },
        ],
      };
    }
  }

  async getSubscription(subscriptionId: string): Promise<ShopifySubscription | null> {
    validateSubscriptionId(subscriptionId);

    const cacheKey = `subscription:${subscriptionId}`;
    const cached = this.subscriptionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const query = `
      query getAppSubscription($id: ID!) {
        node(id: $id) {
          ... on AppSubscription {
            id
            name
            status
            createdAt
            currentPeriodEnd
            trialDays
            trialEndsAt
            lineItems {
              id
              plan {
                ... on AppRecurringPricing {
                  pricingDetails {
                    price {
                      amount
                      currencyCode
                    }
                    interval
                  }
                }
              }
            }
          }
        }
      }
    `;

    const startTime = Date.now();
    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{
          node: ShopifySubscription | null;
        }>(query, { id: subscriptionId }),
        {
          ...ShopifyBilling.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', ShopifyBilling.SERVICE_NAME, 'Retrying subscription fetch', {
              attempt,
              shopDomain: this.shopDomain,
              subscriptionId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      this.subscriptionCache.set(cacheKey, {
        data: result.node,
        expiresAt: Date.now() + ShopifyBilling.SUBSCRIPTION_CACHE_TTL_MS,
      });

      const duration = Date.now() - startTime;
      structuredLog('info', ShopifyBilling.SERVICE_NAME, 'Subscription fetched', {
        shopDomain: this.shopDomain,
        subscriptionId,
        found: !!result.node,
        durationMs: duration,
      });

      return result.node;
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', ShopifyBilling.SERVICE_NAME, 'Failed to get subscription', {
        shopDomain: this.shopDomain,
        subscriptionId,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      return null;
    }
  }

  async getAllSubscriptions(): Promise<ReadonlyArray<ShopifySubscription>> {
    const query = `
      query {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            createdAt
            currentPeriodEnd
            trialDays
            trialEndsAt
            lineItems {
              id
              plan {
                ... on AppRecurringPricing {
                  pricingDetails {
                    price {
                      amount
                      currencyCode
                    }
                    interval
                  }
                }
              }
            }
          }
        }
      }
    `;

    const startTime = Date.now();
    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{
          currentAppInstallation: {
            activeSubscriptions: ReadonlyArray<ShopifySubscription>;
          };
        }>(query),
        {
          ...ShopifyBilling.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, err) => {
            structuredLog('warn', ShopifyBilling.SERVICE_NAME, 'Retrying subscriptions fetch', {
              attempt,
              shopDomain: this.shopDomain,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );

      const subscriptions = result.currentAppInstallation?.activeSubscriptions || [];
      for (const subscription of subscriptions) {
        this.subscriptionCache.set(`subscription:${subscription.id}`, {
          data: subscription,
          expiresAt: Date.now() + ShopifyBilling.SUBSCRIPTION_CACHE_TTL_MS,
        });
      }

      const duration = Date.now() - startTime;
      structuredLog('info', ShopifyBilling.SERVICE_NAME, 'Subscriptions fetched', {
        shopDomain: this.shopDomain,
        count: subscriptions.length,
        durationMs: duration,
      });

      return subscriptions;
    } catch (error) {
      const duration = Date.now() - startTime;
      structuredLog('error', ShopifyBilling.SERVICE_NAME, 'Failed to get subscriptions', {
        shopDomain: this.shopDomain,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      });
      return [];
    }
  }

  mapSubscriptionStatusToPlanStatus(status: string): 'active' | 'pending' | 'cancelled' | 'expired' | 'paused' {
    if (isSubscriptionStatus(status)) {
      switch (status) {
        case 'ACTIVE':
          return 'active';
        case 'PENDING':
          return 'pending';
        case 'CANCELLED':
          return 'cancelled';
        case 'EXPIRED':
          return 'expired';
        case 'FROZEN':
          return 'paused';
        default:
          return 'paused';
      }
    }
    return 'paused';
  }

  extractPlanNameFromSubscription(subscription: ShopifySubscription): string | null {
    const name = subscription.name.toLowerCase();

    if (name.includes('starter') || name.includes('basic')) {
      return 'starter';
    }
    if (name.includes('publisher') || name.includes('pro')) {
      return 'publisher';
    }
    if (name.includes('trial') || name.includes('free')) {
      return 'free_trial';
    }

    return null;
  }

  getPlanSelectionUrl(appHandle: string): string {
    validateAppHandle(appHandle);
    const storeHandle = this.shopDomain.replace('.myshopify.com', '');
    return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
  }
}
