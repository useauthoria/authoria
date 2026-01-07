import { useMemo, useEffect, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStore, useQuotaStatus, usePosts, queryKeys } from '../lib/api-cache';
import { getShopDomain } from '../lib/app-bridge';
import { analyticsApi, dashboardApi } from '../lib/api-client';
import type { Store, BlogPost, QuotaStatus } from '../lib/api-client';
import { useNetworkStatus } from './useNetworkStatus';

export interface UseDashboardDataOptions {
  readonly onError?: (error: Error) => void;
}

export interface DashboardData {
  readonly store: Store | null;
  readonly quota: QuotaStatus | null;
  readonly posts: readonly BlogPost[];
  readonly scheduledPosts: readonly BlogPost[];
  readonly draftPosts: readonly BlogPost[];
  readonly analytics: unknown;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
  readonly refetch: () => void;
}

const BATCH_STALE_TIME = 60000;
const BATCH_GC_TIME = 5 * 60 * 1000;
const BATCH_REFETCH_INTERVAL = 2 * 60 * 1000;
const ANALYTICS_STALE_TIME = 5 * 60 * 1000;
const ANALYTICS_GC_TIME = 10 * 60 * 1000;
const MAX_STORE_ID_LENGTH = 200;
const MAX_SHOP_DOMAIN_LENGTH = 200;

const validateStoreId = (storeId: string | undefined): string => {
  if (!storeId || typeof storeId !== 'string') {
    return '';
  }
  const trimmed = storeId.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_STORE_ID_LENGTH) {
    return '';
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

export function useDashboardData(
  options: UseDashboardDataOptions = {},
): DashboardData {
  const isMountedRef = useRef(true);
  const { onError } = options;
  const { isOnline } = useNetworkStatus();

  const shopDomain = useMemo(() => {
    const domain = getShopDomain();
    const validated = validateShopDomain(domain);
    if (!validated && onError && isMountedRef.current) {
      try {
        onError(new Error('Shop domain not available'));
      } catch {
      }
    }
    return validated;
  }, [onError]);

  const validatedShopDomain = useMemo(() => shopDomain ?? '', [shopDomain]);

  const {
    data: store,
    isLoading: storeLoading,
    error: storeError,
    refetch: refetchStore,
  } = useStore(validatedShopDomain);

  const storeId = useMemo(() => {
    const id = store?.id;
    return validateStoreId(id);
  }, [store?.id]);

  const hasStoreId = useMemo(() => storeId.length > 0, [storeId]);

  const {
    data: batchData,
    isLoading: batchLoading,
    error: batchError,
    refetch: refetchBatch,
  } = useQuery({
    queryKey: ['dashboard-batch', storeId, shopDomain] as const,
    queryFn: async () => {
      if (!storeId && !shopDomain) {
        return null;
      }
      const validatedStoreId = validateStoreId(storeId);
      const validatedDomain = validateShopDomain(shopDomain);
      if (!validatedStoreId && !validatedDomain) {
        return null;
      }
      try {
        return await dashboardApi.getBatch(validatedStoreId, validatedDomain || '');
      } catch {
        return null;
      }
    },
    enabled: (hasStoreId || !!shopDomain) && isOnline,
    staleTime: BATCH_STALE_TIME,
    gcTime: BATCH_GC_TIME,
    refetchInterval: BATCH_REFETCH_INTERVAL,
  });

  const {
    data: quota,
    isLoading: quotaLoading,
    error: quotaError,
    refetch: refetchQuota,
  } = useQuotaStatus(storeId);

  const {
    data: posts,
    isLoading: postsLoading,
    error: postsError,
    refetch: refetchPosts,
  } = usePosts(storeId, { status: 'published' });

  const {
    data: scheduledPosts,
    isLoading: scheduledPostsLoading,
    error: scheduledPostsError,
    refetch: refetchScheduledPosts,
  } = usePosts(storeId, { status: 'scheduled' });

  const {
    data: draftPosts,
    isLoading: draftPostsLoading,
    error: draftPostsError,
    refetch: refetchDraftPosts,
  } = usePosts(storeId, { status: 'draft' });

  const {
    data: analytics,
    error: analyticsError,
    refetch: refetchAnalytics,
  } = useQuery({
    queryKey: queryKeys.analytics(storeId),
    queryFn: async () => {
      if (!storeId) {
        return null;
      }
      try {
        return await analyticsApi.getMetrics(storeId);
      } catch {
        return null;
      }
    },
    enabled: hasStoreId && isOnline && !batchData,
    staleTime: ANALYTICS_STALE_TIME,
    gcTime: ANALYTICS_GC_TIME,
  });

  const finalQuota = useMemo(
    () => batchData?.quota ?? quota ?? null,
    [batchData?.quota, quota],
  );

  const finalPosts = useMemo(
    () => (batchData?.posts ?? posts ?? []) as readonly BlogPost[],
    [batchData?.posts, posts],
  );

  const finalScheduledPosts = useMemo(
    () => (batchData?.scheduledPosts ?? scheduledPosts ?? []) as readonly BlogPost[],
    [batchData?.scheduledPosts, scheduledPosts],
  );

  const finalDraftPosts = useMemo(
    () => (batchData?.draftPosts ?? draftPosts ?? []) as readonly BlogPost[],
    [batchData?.draftPosts, draftPosts],
  );

  const finalAnalytics = useMemo(
    () => batchData?.analytics ?? analytics ?? null,
    [batchData?.analytics, analytics],
  );

  const isLoading = useMemo(() => {
    if (!shopDomain) {
      return false;
    }
    if (storeLoading) {
      return true;
    }
    if (!hasStoreId) {
      return false;
    }
    if (batchLoading) {
      return true;
    }
    if (batchData) {
      return false;
    }
    return (
      quotaLoading ||
      postsLoading ||
      scheduledPostsLoading ||
      draftPostsLoading
    );
  }, [
    shopDomain,
    storeLoading,
    hasStoreId,
    batchLoading,
    batchData,
    quotaLoading,
    postsLoading,
    scheduledPostsLoading,
    draftPostsLoading,
  ]);

  const isError = useMemo(() => {
    if (storeError || batchError) {
      return true;
    }
    if (batchData) {
      return false;
    }
    return !!(
      quotaError ||
      postsError ||
      scheduledPostsError ||
      draftPostsError ||
      analyticsError
    );
  }, [
    storeError,
    batchError,
    batchData,
    quotaError,
    postsError,
    scheduledPostsError,
    draftPostsError,
    analyticsError,
  ]);

  const error = useMemo(() => {
    if (storeError) {
      return normalizeError(storeError);
    }
    if (batchError) {
      return normalizeError(batchError);
    }
    if (batchData) {
      return null;
    }
    const individualError =
      quotaError ||
      postsError ||
      scheduledPostsError ||
      draftPostsError ||
      analyticsError;
    return individualError ? normalizeError(individualError) : null;
  }, [
    storeError,
    batchError,
    batchData,
    quotaError,
    postsError,
    scheduledPostsError,
    draftPostsError,
    analyticsError,
  ]);

  const refetch = useCallback(() => {
    if (!isMountedRef.current) {
      return;
    }
    try {
      refetchStore();
      if (batchData) {
        refetchBatch();
      } else {
        refetchQuota();
        refetchPosts();
        refetchScheduledPosts();
        refetchDraftPosts();
        refetchAnalytics();
      }
    } catch {
    }
  }, [
    refetchStore,
    refetchBatch,
    refetchQuota,
    refetchPosts,
    refetchScheduledPosts,
    refetchDraftPosts,
    refetchAnalytics,
    batchData,
  ]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!error || !onError || !isMountedRef.current) {
      return;
    }
    try {
      onError(error);
    } catch {
    }
  }, [error, onError]);

  return useMemo(
    () => ({
      store: store ?? null,
      quota: finalQuota,
      posts: finalPosts,
      scheduledPosts: finalScheduledPosts,
      draftPosts: finalDraftPosts,
      analytics: finalAnalytics,
      isLoading,
      isError,
      error,
      refetch,
    }),
    [
      store,
      finalQuota,
      finalPosts,
      finalScheduledPosts,
      finalDraftPosts,
      finalAnalytics,
      isLoading,
      isError,
      error,
      refetch,
    ],
  );
}
