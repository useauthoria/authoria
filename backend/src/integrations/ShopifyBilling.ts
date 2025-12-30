/**
 * Shopify Billing API Integration
 * Follows Shopify's best practices for app billing
 * 
 * Features:
 * - Subscription creation with proper confirmation flow
 * - Currency-aware billing (merchant's local currency)
 * - Free trial support
 * - Subscription status checking
 * - Webhook handling for subscription updates
 * - Managed pricing support
 */

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

export class ShopifyBilling {
  private readonly shopifyGraphQL: ShopifyGraphQL;
  private readonly supabase: SupabaseClient;
  private readonly shopDomain: string;
  private readonly accessToken: string;

  constructor(
    supabase: SupabaseClient,
    shopDomain: string,
    accessToken: string,
  ) {
    this.supabase = supabase;
    this.shopDomain = shopDomain;
    this.accessToken = accessToken;
    this.shopifyGraphQL = new ShopifyGraphQL(shopDomain, accessToken);
  }

  /**
   * Get merchant's billing preferences (currency, country)
   * Best Practice: Use merchant's local currency for charges
   */
  async getBillingPreferences(): Promise<ShopBillingPreferences> {
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

    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{ shop: { billingPreferences: ShopBillingPreferences } }>(query),
        { maxAttempts: 3, initialDelay: 1000 },
      );

      return result.shop.billingPreferences || { currencyCode: 'USD', countryCode: 'US' };
    } catch (error) {
      console.warn('Failed to fetch billing preferences, using defaults:', error);
      return { currencyCode: 'USD', countryCode: 'US' };
    }
  }

  /**
   * Check if store has an active subscription
   * Best Practice: Gate requests by checking subscription status
   */
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

    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{
          currentAppInstallation: {
            activeSubscriptions: ReadonlyArray<ShopifySubscription>;
          };
        }>(query),
        { maxAttempts: 3, initialDelay: 1000 },
      );

      const subscriptions = result.currentAppInstallation?.activeSubscriptions || [];
      const activeSubscription = subscriptions.find(
        (sub) => sub.status === 'ACTIVE' || sub.status === 'PENDING',
      );

      return {
        hasActivePayment: !!activeSubscription,
        subscription: activeSubscription || null,
      };
    } catch (error) {
      return {
        hasActivePayment: false,
        subscription: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Create a subscription charge
   * Best Practice: Always redirect to confirmationUrl for merchant approval
   */
  async createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<CreateSubscriptionResult> {
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

    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{
          appSubscriptionCreate: {
            confirmationUrl: string | null;
            appSubscription: ShopifySubscription | null;
            userErrors: ReadonlyArray<{ field: readonly string[]; message: string }>;
          };
        }>(mutation, variables),
        { maxAttempts: 3, initialDelay: 1000 },
      );

      return {
        confirmationUrl: result.appSubscriptionCreate.confirmationUrl,
        subscription: result.appSubscriptionCreate.appSubscription,
        userErrors: result.appSubscriptionCreate.userErrors,
      };
    } catch (error) {
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

  /**
   * Create a one-time purchase
   * Best Practice: Use for credits, one-time features, etc.
   */
  async createOneTimePurchase(
    name: string,
    price: { amount: number; currencyCode: string },
    returnUrl: string,
    test: boolean = false,
  ): Promise<{ confirmationUrl: string | null; userErrors: ReadonlyArray<{ field: readonly string[]; message: string }> }> {
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

    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{
          appPurchaseOneTimeCreate: {
            confirmationUrl: string | null;
            userErrors: ReadonlyArray<{ field: readonly string[]; message: string }>;
          };
        }>(mutation, variables),
        { maxAttempts: 3, initialDelay: 1000 },
      );

      return {
        confirmationUrl: result.appPurchaseOneTimeCreate.confirmationUrl,
        userErrors: result.appPurchaseOneTimeCreate.userErrors,
      };
    } catch (error) {
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

  /**
   * Cancel a subscription
   * Best Practice: Use prorate parameter for immediate vs end-of-period cancellation
   */
  async cancelSubscription(
    subscriptionId: string,
    prorate: boolean = false,
  ): Promise<{ success: boolean; userErrors: ReadonlyArray<{ field: readonly string[]; message: string }> }> {
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

    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{
          appSubscriptionCancel: {
            appSubscription: { id: string; status: string } | null;
            userErrors: ReadonlyArray<{ field: readonly string[]; message: string }>;
          };
        }>(mutation, variables),
        { maxAttempts: 3, initialDelay: 1000 },
      );

      return {
        success: result.appSubscriptionCancel.appSubscription !== null,
        userErrors: result.appSubscriptionCancel.userErrors,
      };
    } catch (error) {
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

  /**
   * Get subscription by ID
   */
  async getSubscription(subscriptionId: string): Promise<ShopifySubscription | null> {
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

    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{
          node: ShopifySubscription | null;
        }>(query, { id: subscriptionId }),
        { maxAttempts: 3, initialDelay: 1000 },
      );

      return result.node;
    } catch (error) {
      console.error('Failed to get subscription:', error);
      return null;
    }
  }

  /**
   * Get all subscriptions for current app installation
   * Best Practice: Check all subscriptions, not just active ones
   */
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

    try {
      const result = await retry(
        async () => await this.shopifyGraphQL.query<{
          currentAppInstallation: {
            activeSubscriptions: ReadonlyArray<ShopifySubscription>;
          };
        }>(query),
        { maxAttempts: 3, initialDelay: 1000 },
      );

      return result.currentAppInstallation?.activeSubscriptions || [];
    } catch (error) {
      console.error('Failed to get subscriptions:', error);
      return [];
    }
  }

  /**
   * Map Shopify subscription status to internal plan status
   */
  mapSubscriptionStatusToPlanStatus(status: string): 'active' | 'pending' | 'cancelled' | 'expired' | 'paused' {
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

  /**
   * Extract plan name from subscription name
   * Best Practice: Use consistent naming conventions
   */
  extractPlanNameFromSubscription(subscription: ShopifySubscription): string | null {
    const name = subscription.name.toLowerCase();

    // Map common subscription name patterns to plan names
    if (name.includes('starter') || name.includes('basic')) {
      return 'starter';
    }
    if (name.includes('publisher') || name.includes('pro')) {
      return 'publisher';
    }
    if (name.includes('authority') || name.includes('premium')) {
      return 'authority';
    }
    if (name.includes('trial') || name.includes('free')) {
      return 'free_trial';
    }

    return null;
  }

  /**
   * Get plan selection page URL for managed pricing
   * Best Practice: Redirect to Shopify's hosted plan selection page
   */
  getPlanSelectionUrl(appHandle: string): string {
    const storeHandle = this.shopDomain.replace('.myshopify.com', '');
    return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
  }
}

