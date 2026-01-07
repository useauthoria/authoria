import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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

export interface UseShopifyBillingReturn {
  readonly hasActivePayment: boolean;
  readonly subscription: SubscriptionStatus['subscription'];
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly shouldRedirect: boolean;
  readonly checkAndRedirect: () => void;
  readonly planSelectionUrl: string;
  readonly refetch: () => void;
}

export interface UseRequirePaymentReturn {
  readonly hasActivePayment: boolean;
  readonly isLoading: boolean;
  readonly requiresPayment: boolean;
}

interface BillingCheckResponse {
  readonly hasActivePayment: boolean;
  readonly subscription: SubscriptionStatus['subscription'];
}

const DEFAULT_REDIRECT = true;
const STALE_TIME = 60000;
const GC_TIME = 300000;
const CACHE_TTL = 60000;
const MAX_APP_HANDLE_LENGTH = 200;
const MAX_SHOP_DOMAIN_LENGTH = 200;
const MIN_APP_HANDLE_LENGTH = 1;

const validateAppHandle = (appHandle: string | undefined): string | null => {
  if (!appHandle || typeof appHandle !== 'string') {
    return null;
  }
  const trimmed = appHandle.trim();
  if (trimmed.length < MIN_APP_HANDLE_LENGTH || trimmed.length > MAX_APP_HANDLE_LENGTH) {
    return null;
  }
  return trimmed;
};

const validateShopDomain = (shopDomain: string | null | undefined): string | null => {
  if (!shopDomain || typeof shopDomain !== 'string') {
    return null;
  }
  const trimmed = shopDomain.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SHOP_DOMAIN_LENGTH) {
    return null;
  }
  return trimmed;
};

const normalizeError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = String(error.message);
    return new Error(message.length > 0 ? message : 'Unknown error');
  }
  return new Error(String(error));
};

const isValidBillingResponse = (response: unknown): response is BillingCheckResponse => {
  if (!response || typeof response !== 'object') {
    return false;
  }
  const data = response as Record<string, unknown>;
  if (typeof data.hasActivePayment !== 'boolean') {
    return false;
  }
  if (data.subscription !== null && typeof data.subscription !== 'object') {
    return false;
  }
  return true;
};

export function useShopifyBilling(appHandle: string): UseShopifyBillingReturn {
  const isMountedRef = useRef(true);
  const [shouldRedirect, setShouldRedirect] = useState(false);

  const validatedAppHandle = useMemo(() => validateAppHandle(appHandle), [appHandle]);

  const shopDomain = useMemo(() => {
    const domain = getShopDomain();
    return validateShopDomain(domain);
  }, []);

  const {
    data: billingStatus,
    isLoading,
    error,
    refetch,
  } = useQuery<BillingCheckResponse>({
    queryKey: ['shopify-billing', shopDomain] as const,
    queryFn: async (): Promise<BillingCheckResponse> => {
      if (!shopDomain) {
        throw new Error('Shop domain not available');
      }

      try {
        const response = await api.get<BillingCheckResponse>('/api-router/billing/check', {
          params: { shopDomain },
          cache: { enabled: true, ttl: CACHE_TTL },
        });

        if (!isValidBillingResponse(response)) {
          throw new Error('Invalid billing response format');
        }

        return response;
      } catch (error) {
        throw normalizeError(error);
      }
    },
    enabled: !!shopDomain,
    staleTime: STALE_TIME,
    gcTime: GC_TIME,
  });

  const checkAndRedirect = useCallback(() => {
    if (!isMountedRef.current || !validatedAppHandle) {
      return;
    }
    if (billingStatus && !billingStatus.hasActivePayment) {
      try {
        redirectToPlanSelection(validatedAppHandle);
        if (isMountedRef.current) {
          setShouldRedirect(true);
        }
      } catch {
      }
    }
  }, [billingStatus, validatedAppHandle]);

  const planSelectionUrl = useMemo(() => {
    if (!validatedAppHandle) {
      return '/settings?billing=required';
    }
    try {
      return getPlanSelectionUrl(validatedAppHandle);
    } catch {
      return '/settings?billing=required';
    }
  }, [validatedAppHandle]);

  const normalizedError = useMemo(() => {
    if (error) {
      return normalizeError(error);
    }
    return null;
  }, [error]);

  const hasActivePayment = useMemo(
    () => billingStatus?.hasActivePayment ?? false,
    [billingStatus?.hasActivePayment],
  );

  const subscription = useMemo(
    () => billingStatus?.subscription ?? null,
    [billingStatus?.subscription],
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return useMemo(
    () => ({
      hasActivePayment,
      subscription,
      isLoading,
      error: normalizedError,
      shouldRedirect,
      checkAndRedirect,
      planSelectionUrl,
      refetch,
    }),
    [
      hasActivePayment,
      subscription,
      isLoading,
      normalizedError,
      shouldRedirect,
      checkAndRedirect,
      planSelectionUrl,
      refetch,
    ],
  );
}

export function useRequirePayment(
  appHandle: string,
  redirect: boolean = DEFAULT_REDIRECT,
): UseRequirePaymentReturn {
  const isMountedRef = useRef(true);
  const validatedRedirect = useMemo(() => {
    return typeof redirect === 'boolean' ? redirect : DEFAULT_REDIRECT;
  }, [redirect]);

  const { hasActivePayment, isLoading, checkAndRedirect } = useShopifyBilling(appHandle);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isMountedRef.current || isLoading || hasActivePayment || !validatedRedirect) {
      return;
    }
    try {
      checkAndRedirect();
    } catch {
    }
  }, [hasActivePayment, isLoading, validatedRedirect, checkAndRedirect]);

  const requiresPayment = useMemo(
    () => !hasActivePayment && !isLoading,
    [hasActivePayment, isLoading],
  );

  return useMemo(
    () => ({
      hasActivePayment,
      isLoading,
      requiresPayment,
    }),
    [hasActivePayment, isLoading, requiresPayment],
  );
}
