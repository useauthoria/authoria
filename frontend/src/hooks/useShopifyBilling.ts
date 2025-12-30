/**
 * React hook for Shopify Billing API
 * Provides subscription status checking and plan selection redirects
 * Follows Shopify best practices for billing
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getShopDomain } from '../lib/app-bridge';
import { api } from '../lib/api-client';
import { getPlanSelectionUrl, redirectToPlanSelection } from '../utils/shopify-billing';

export interface SubscriptionStatus {
  readonly hasActivePayment: boolean;
  readonly subscription: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly currentPeriodEnd?: string;
    readonly trialDays?: number;
    readonly trialEndsAt?: string;
  } | null;
  readonly error?: string;
}

interface BillingCheckResponse {
  readonly hasActivePayment: boolean;
  readonly subscription: SubscriptionStatus['subscription'];
}

/**
 * Hook to check Shopify subscription status
 * Best Practice: Check subscription status before allowing access to paid features
 */
export function useShopifyBilling(appHandle: string) {
  const shopDomain = getShopDomain();
  const [shouldRedirect, setShouldRedirect] = useState(false);

  const {
    data: billingStatus,
    isLoading,
    error,
    refetch,
  } = useQuery<BillingCheckResponse>({
    queryKey: ['shopify-billing', shopDomain],
    queryFn: async () => {
      if (!shopDomain) {
        throw new Error('Shop domain not available');
      }

      // Check subscription status via API
      const response = await api.get<BillingCheckResponse>(
        `/api-router/billing/check`,
        {
          params: { shopDomain },
          cache: { enabled: true, ttl: 60000 }, // Cache for 1 minute
        },
      );

      return response;
    },
    enabled: !!shopDomain,
    staleTime: 60000, // Consider data fresh for 1 minute
    gcTime: 300000, // Keep in cache for 5 minutes
  });

  const checkAndRedirect = useCallback(() => {
    if (billingStatus && !billingStatus.hasActivePayment) {
      redirectToPlanSelection(appHandle);
      setShouldRedirect(true);
    }
  }, [billingStatus, appHandle]);

  const planSelectionUrl = useMemo(() => {
    return getPlanSelectionUrl(appHandle);
  }, [appHandle]);

  return {
    hasActivePayment: billingStatus?.hasActivePayment ?? false,
    subscription: billingStatus?.subscription ?? null,
    isLoading,
    error,
    shouldRedirect,
    checkAndRedirect,
    planSelectionUrl,
    refetch,
  };
}

/**
 * Hook to require active payment before rendering content
 * Best Practice: Use in route loaders/actions to gate access
 */
export function useRequirePayment(appHandle: string, redirect: boolean = true) {
  const { hasActivePayment, isLoading, checkAndRedirect } = useShopifyBilling(appHandle);

  useEffect(() => {
    if (!isLoading && !hasActivePayment && redirect) {
      checkAndRedirect();
    }
  }, [hasActivePayment, isLoading, redirect, checkAndRedirect]);

  return {
    hasActivePayment,
    isLoading,
    requiresPayment: !hasActivePayment && !isLoading,
  };
}

