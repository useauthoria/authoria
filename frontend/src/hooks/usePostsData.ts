import { useMemo, useEffect, useCallback } from 'react';
import { useStore, usePosts } from '../lib/api-cache';
import { getShopDomain } from '../lib/app-bridge';
import type { BlogPost } from '../lib/api-client';
import { useNetworkStatus } from './useNetworkStatus';

export interface PostsFilters {
  readonly status?: string;
  readonly dateRange?: { readonly start: string; readonly end: string };
}

export type SortField = 'date' | 'title' | 'seo_score' | 'status';
export type SortDirection = 'asc' | 'desc';

export interface UsePostsDataOptions {
  readonly enableRealTime?: boolean;
  readonly refetchInterval?: number;
  readonly onError?: (error: Error) => void;
  readonly filters?: PostsFilters;
  readonly sortBy?: SortField;
  readonly sortDirection?: SortDirection;
  readonly searchQuery?: string;
}

export interface PostsData {
  readonly store: unknown;
  readonly sortedPosts: readonly BlogPost[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
  readonly refetch: () => void;
}

interface ApiFilters {
  status?: string;
}

function getPostDate(post: BlogPost): Date {
  const dateStr = post.published_at ?? post.scheduled_publish_at ?? post.created_at;
  return new Date(dateStr);
}

function matchesSearchQuery(post: BlogPost, query: string): boolean {
  const lowerQuery = query.toLowerCase();
  const titleMatch = post.title.toLowerCase().includes(lowerQuery);
  const contentMatch = post.content?.toLowerCase().includes(lowerQuery) ?? false;
  return titleMatch || contentMatch;
}

function matchesDateRange(post: BlogPost, start: Date, end: Date): boolean {
  const postDate = getPostDate(post);
  return postDate >= start && postDate <= end;
}


function getSortValue(post: BlogPost, field: SortField): string | number | Date {
  switch (field) {
    case 'date':
      return getPostDate(post);
    case 'title':
      return post.title.toLowerCase();
    case 'seo_score':
      return post.seo_health_score;
    case 'status':
      return post.status;
    default:
      return '';
  }
}

function compareValues(a: string | number | Date, b: string | number | Date, direction: SortDirection): number {
  if (a < b) {
    return direction === 'asc' ? -1 : 1;
  }
  if (a > b) {
    return direction === 'asc' ? 1 : -1;
  }
  return 0;
}

export function usePostsData(options: UsePostsDataOptions = {}): PostsData {
  const {
    enableRealTime = false,
    refetchInterval = 300000, // 5 minute interval to reduce API load
    onError,
    filters = {},
    sortBy = 'date',
    sortDirection = 'desc',
    searchQuery = '',
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

  const apiFilters = useMemo((): ApiFilters => {
    if (filters.status) {
      return { status: filters.status };
    }
    return {};
  }, [filters.status]);

  const {
    data: posts = [],
    isLoading: postsLoading,
    error: postsError,
    refetch: refetchPosts,
  } = usePosts(store?.id ?? '', apiFilters);

  const searchedPosts = useMemo((): readonly BlogPost[] => {
    if (!searchQuery.trim()) {
      return posts;
    }
    return posts.filter((post: BlogPost) => matchesSearchQuery(post, searchQuery));
  }, [posts, searchQuery]);

  const filteredPosts = useMemo((): readonly BlogPost[] => {
    let filtered = searchedPosts;

    if (filters.dateRange) {
      const start = new Date(filters.dateRange.start);
      const end = new Date(filters.dateRange.end);
      filtered = filtered.filter((post: BlogPost) => matchesDateRange(post, start, end));
    }

    return filtered;
  }, [searchedPosts, filters]);

  const sortedPosts = useMemo((): readonly BlogPost[] => {
    const sorted = [...filteredPosts];
    
    sorted.sort((a, b) => {
      const aValue = getSortValue(a, sortBy);
      const bValue = getSortValue(b, sortBy);
      return compareValues(aValue, bValue, sortDirection);
    });

    return sorted;
  }, [filteredPosts, sortBy, sortDirection]);

  const isLoading = storeLoading || postsLoading;
  const isError = !!storeError || !!postsError;
  const error = storeError || postsError || null;

  const refetch = useCallback(() => {
    refetchStore();
    refetchPosts();
  }, [refetchStore, refetchPosts]);

  useEffect(() => {
    if (error && onError) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }, [error, onError]);

  useEffect(() => {
    if (isOnline && !isLoading) {
      refetch();
    }
  }, [isOnline, isLoading, refetch]);

  useEffect(() => {
    if (!enableRealTime || !store?.id) {
      return;
    }

    // Optimized: Increase default refetch interval to reduce Edge Function invocations
    // Only refetch if user explicitly enables real-time updates
    const optimizedInterval = refetchInterval >= 30000 ? refetchInterval : Math.max(refetchInterval, 60000); // Minimum 1 minute

    const interval = setInterval(() => {
      refetchPosts();
    }, optimizedInterval);

    return () => clearInterval(interval);
  }, [enableRealTime, refetchInterval, store?.id, refetchPosts]);

  return {
    store,
    sortedPosts,
    isLoading,
    isError,
    error,
    refetch,
  };
}
