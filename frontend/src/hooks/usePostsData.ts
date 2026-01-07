import { useMemo, useEffect, useCallback, useRef } from 'react';
import { useStore, usePosts } from '../lib/api-cache';
import { getShopDomain } from '../lib/app-bridge';
import type { BlogPost, Store } from '../lib/api-client';
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
  readonly store: Store | null;
  readonly sortedPosts: readonly BlogPost[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
  readonly refetch: () => void;
}

interface ApiFilters {
  readonly status?: string;
}

const DEFAULT_ENABLE_REAL_TIME = false;
const DEFAULT_REFETCH_INTERVAL = 300000;
const DEFAULT_SORT_BY: SortField = 'date';
const DEFAULT_SORT_DIRECTION: SortDirection = 'desc';
const DEFAULT_SEARCH_QUERY = '';
const MIN_REFETCH_INTERVAL = 30000;
const OPTIMIZED_MIN_INTERVAL = 60000;
const MAX_SEARCH_QUERY_LENGTH = 500;
const MAX_STATUS_LENGTH = 50;
const MAX_SHOP_DOMAIN_LENGTH = 200;

const isSortField = (field: string | undefined): field is SortField => {
  return field === 'date' || field === 'title' || field === 'seo_score' || field === 'status';
};

const isSortDirection = (direction: string | undefined): direction is SortDirection => {
  return direction === 'asc' || direction === 'desc';
};

const validateRefetchInterval = (interval: number | undefined): number => {
  if (interval === undefined || interval === null) {
    return DEFAULT_REFETCH_INTERVAL;
  }
  if (typeof interval !== 'number' || !Number.isFinite(interval)) {
    return DEFAULT_REFETCH_INTERVAL;
  }
  if (interval < MIN_REFETCH_INTERVAL) {
    return MIN_REFETCH_INTERVAL;
  }
  return Math.floor(interval);
};

const validateSearchQuery = (query: string | undefined): string => {
  if (!query || typeof query !== 'string') {
    return DEFAULT_SEARCH_QUERY;
  }
  const trimmed = query.trim();
  if (trimmed.length > MAX_SEARCH_QUERY_LENGTH) {
    return trimmed.slice(0, MAX_SEARCH_QUERY_LENGTH);
  }
  return trimmed;
};

const validateStatus = (status: string | undefined): string | undefined => {
  if (!status || typeof status !== 'string') {
    return undefined;
  }
  const trimmed = status.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_STATUS_LENGTH) {
    return undefined;
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

const isValidDate = (date: Date): boolean => {
  return Number.isFinite(date.getTime());
};

function getPostDate(post: BlogPost): Date {
  const dateStr = post.published_at ?? post.scheduled_publish_at ?? post.created_at;
  if (!dateStr || typeof dateStr !== 'string') {
    return new Date(0);
  }
  const date = new Date(dateStr);
  return isValidDate(date) ? date : new Date(0);
}

function matchesSearchQuery(post: BlogPost, query: string): boolean {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return false;
  }
  try {
    const lowerQuery = query.toLowerCase().trim();
    if (lowerQuery.length === 0) {
      return false;
    }
    const title = post.title?.toLowerCase() || '';
    const content = post.content?.toLowerCase() || '';
    return title.includes(lowerQuery) || content.includes(lowerQuery);
  } catch {
    return false;
  }
}

function matchesDateRange(post: BlogPost, start: Date, end: Date): boolean {
  if (!isValidDate(start) || !isValidDate(end)) {
    return false;
  }
  if (start > end) {
    return false;
  }
  try {
    const postDate = getPostDate(post);
    if (!isValidDate(postDate)) {
      return false;
    }
    return postDate >= start && postDate <= end;
  } catch {
    return false;
  }
}

function getSortValue(post: BlogPost, field: SortField): string | number | Date {
  switch (field) {
    case 'date': {
      const date = getPostDate(post);
      return isValidDate(date) ? date : new Date(0);
    }
    case 'title': {
      const title = post.title || '';
      return typeof title === 'string' ? title.toLowerCase() : '';
    }
    case 'seo_score': {
      const score = post.seo_health_score;
      if (typeof score === 'number' && Number.isFinite(score)) {
        return score;
      }
      return 0;
    }
    case 'status': {
      const status = post.status || '';
      return typeof status === 'string' ? status : '';
    }
    default:
      return '';
  }
}

function compareValues(
  a: string | number | Date,
  b: string | number | Date,
  direction: SortDirection,
): number {
  try {
    if (a < b) {
      return direction === 'asc' ? -1 : 1;
    }
    if (a > b) {
      return direction === 'asc' ? 1 : -1;
    }
    return 0;
  } catch {
    return 0;
  }
}

export function usePostsData(options: UsePostsDataOptions = {}): PostsData {
  const isMountedRef = useRef(true);
  const {
    enableRealTime = DEFAULT_ENABLE_REAL_TIME,
    refetchInterval = DEFAULT_REFETCH_INTERVAL,
    onError,
    filters = {},
    sortBy = DEFAULT_SORT_BY,
    sortDirection = DEFAULT_SORT_DIRECTION,
    searchQuery = DEFAULT_SEARCH_QUERY,
  } = options;

  const { isOnline } = useNetworkStatus();

  const validatedRefetchInterval = useMemo(
    () => validateRefetchInterval(refetchInterval),
    [refetchInterval],
  );

  const validatedSearchQuery = useMemo(() => validateSearchQuery(searchQuery), [searchQuery]);

  const validatedSortBy = useMemo(
    () => (isSortField(sortBy) ? sortBy : DEFAULT_SORT_BY),
    [sortBy],
  );

  const validatedSortDirection = useMemo(
    () => (isSortDirection(sortDirection) ? sortDirection : DEFAULT_SORT_DIRECTION),
    [sortDirection],
  );

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
    return id && typeof id === 'string' && id.trim().length > 0 ? id.trim() : '';
  }, [store?.id]);

  const validatedStatus = useMemo(() => validateStatus(filters.status), [filters.status]);

  const apiFilters = useMemo((): ApiFilters => {
    if (validatedStatus) {
      return { status: validatedStatus };
    }
    return {};
  }, [validatedStatus]);

  const {
    data: posts = [],
    isLoading: postsLoading,
    error: postsError,
    refetch: refetchPosts,
  } = usePosts(storeId, apiFilters);

  const searchedPosts = useMemo((): readonly BlogPost[] => {
    if (!validatedSearchQuery || validatedSearchQuery.length === 0) {
      return posts;
    }
    return posts.filter((post: BlogPost) => matchesSearchQuery(post, validatedSearchQuery));
  }, [posts, validatedSearchQuery]);

  const filteredPosts = useMemo((): readonly BlogPost[] => {
    if (!filters.dateRange) {
      return searchedPosts;
    }

    const startStr = filters.dateRange.start;
    const endStr = filters.dateRange.end;

    if (!startStr || !endStr || typeof startStr !== 'string' || typeof endStr !== 'string') {
      return searchedPosts;
    }

    try {
      const start = new Date(startStr);
      const end = new Date(endStr);

      if (!isValidDate(start) || !isValidDate(end) || start > end) {
        return searchedPosts;
      }

      return searchedPosts.filter((post: BlogPost) => matchesDateRange(post, start, end));
    } catch {
      return searchedPosts;
    }
  }, [searchedPosts, filters.dateRange]);

  const sortedPosts = useMemo((): readonly BlogPost[] => {
    const sorted = [...filteredPosts];

    try {
      sorted.sort((a, b) => {
        const aValue = getSortValue(a, validatedSortBy);
        const bValue = getSortValue(b, validatedSortBy);
        return compareValues(aValue, bValue, validatedSortDirection);
      });
    } catch {
    }

    return sorted;
  }, [filteredPosts, validatedSortBy, validatedSortDirection]);

  const isLoading = useMemo(() => storeLoading || postsLoading, [storeLoading, postsLoading]);

  const isError = useMemo(() => !!storeError || !!postsError, [storeError, postsError]);

  const error = useMemo(() => {
    if (storeError) {
      return normalizeError(storeError);
    }
    if (postsError) {
      return normalizeError(postsError);
    }
    return null;
  }, [storeError, postsError]);

  const refetch = useCallback(() => {
    if (!isMountedRef.current) {
      return;
    }
    try {
      refetchStore();
      refetchPosts();
    } catch {
    }
  }, [refetchStore, refetchPosts]);

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

  useEffect(() => {
    if (!isOnline || isLoading || !isMountedRef.current) {
      return;
    }
    try {
      refetch();
    } catch {
    }
  }, [isOnline, isLoading, refetch]);

  useEffect(() => {
    if (!enableRealTime || !storeId || !isMountedRef.current) {
      return;
    }

    const optimizedInterval =
      validatedRefetchInterval >= MIN_REFETCH_INTERVAL
        ? validatedRefetchInterval
        : Math.max(validatedRefetchInterval, OPTIMIZED_MIN_INTERVAL);

    const intervalId = setInterval(() => {
      if (isMountedRef.current) {
        try {
          refetchPosts();
        } catch {
        }
      }
    }, optimizedInterval);

    return () => {
      clearInterval(intervalId);
    };
  }, [enableRealTime, validatedRefetchInterval, storeId, refetchPosts]);

  return useMemo(
    () => ({
      store: store ?? null,
      sortedPosts,
      isLoading,
      isError,
      error,
      refetch,
    }),
    [store, sortedPosts, isLoading, isError, error, refetch],
  );
}
