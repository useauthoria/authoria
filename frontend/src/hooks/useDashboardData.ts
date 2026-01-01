import { useMemo, useEffect, useCallback } from 'react';
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

export function useDashboardData(options: UseDashboardDataOptions = {}): DashboardData {
  const {
    onError,
  } = options;

  const { isOnline } = useNetworkStatus();

  const shopDomain = useMemo(() => {
    const domain = getShopDomain();
    if (!domain && onError) {
      onError(new Error('Shop domain not available'));
    }
    return domain;
  }, [onError]);

  const {
    data: store,
    isLoading: storeLoading,
    error: storeError,
    refetch: refetchStore,
  } = useStore(shopDomain ?? '');

  const storeId = store?.id ?? '';
  const hasStoreId = !!storeId;

  // Use batch endpoint to reduce Edge Function invocations from 5-6 calls to 1 call
  const {
    data: batchData,
    isLoading: batchLoading,
    error: batchError,
    refetch: refetchBatch,
  } = useQuery({
    queryKey: ['dashboard-batch', storeId, shopDomain],
    queryFn: async () => {
      if (!storeId && !shopDomain) return null;
      return dashboardApi.getBatch(storeId || '', shopDomain || '');
    },
    enabled: (!!storeId || !!shopDomain) && isOnline,
    staleTime: 60000, // 1 minute
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval: 2 * 60 * 1000, // Refetch every 2 minutes (reduced from individual polling)
  });

  // Fallback to individual queries if batch fails or storeId not available yet
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
      if (!storeId) return null;
      return analyticsApi.getMetrics(storeId);
    },
    enabled: !!storeId && isOnline && !batchData, // Only fetch if batch didn't provide analytics
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  // Use batch data if available, otherwise fall back to individual queries
  const finalQuota = batchData?.quota ?? quota ?? null;
  const finalPosts = batchData?.posts ?? posts ?? [];
  const finalScheduledPosts = batchData?.scheduledPosts ?? scheduledPosts ?? [];
  const finalDraftPosts = batchData?.draftPosts ?? draftPosts ?? [];
  const finalAnalytics = batchData?.analytics ?? analytics ?? null;

  // Only consider loading for queries that are actually enabled
  const isLoading = shopDomain 
    ? storeLoading || (hasStoreId && (batchLoading || (!batchData && (quotaLoading || postsLoading || scheduledPostsLoading || draftPostsLoading))))
    : false;
  const isError = !!storeError || !!batchError || (!batchData && (!!quotaError || !!postsError || !!scheduledPostsError || !!draftPostsError || !!analyticsError));
  const error = storeError || batchError || (!batchData && (quotaError || postsError || scheduledPostsError || draftPostsError || analyticsError)) || null;

  const refetch = useCallback(() => {
    refetchStore();
    if (batchData) {
      refetchBatch(); // Use batch refetch if available
    } else {
      // Fallback to individual refetches
      refetchQuota();
      refetchPosts();
      refetchScheduledPosts();
      refetchDraftPosts();
      refetchAnalytics();
    }
  }, [refetchStore, refetchBatch, refetchQuota, refetchPosts, refetchScheduledPosts, refetchDraftPosts, refetchAnalytics, batchData]);

  useEffect(() => {
    if (error && onError) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }, [error, onError]);

  return {
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
  };
}
