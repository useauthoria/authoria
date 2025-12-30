import { useMemo, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStore, useQuotaStatus, usePosts, queryKeys } from '../lib/api-cache';
import { getShopDomain } from '../lib/app-bridge';
import { analyticsApi } from '../lib/api-client';
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
    enabled: !!storeId && isOnline,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  // Only consider loading for queries that are actually enabled
  // When storeId is empty, React Query disables those queries so they don't contribute to loading
  // But we need to check if the queries themselves report loading state correctly when disabled
  const isLoading = shopDomain 
    ? storeLoading || (hasStoreId && (quotaLoading || postsLoading || scheduledPostsLoading || draftPostsLoading))
    : false;
  const isError = !!storeError || !!quotaError || !!postsError || !!scheduledPostsError || !!draftPostsError || !!analyticsError;
  const error = storeError || quotaError || postsError || scheduledPostsError || draftPostsError || analyticsError || null;

  const refetch = useCallback(() => {
    refetchStore();
    refetchQuota();
    refetchPosts();
    refetchScheduledPosts();
    refetchDraftPosts();
    refetchAnalytics();
  }, [refetchStore, refetchQuota, refetchPosts, refetchScheduledPosts, refetchDraftPosts, refetchAnalytics]);

  useEffect(() => {
    if (error && onError) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }, [error, onError]);

  return {
    store: store ?? null,
    quota: quota ?? null,
    posts: posts ?? [],
    scheduledPosts: scheduledPosts ?? [],
    draftPosts: draftPosts ?? [],
    analytics,
    isLoading,
    isError,
    error,
    refetch,
  };
}
