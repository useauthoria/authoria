import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePostsData, type PostsFilters } from '../hooks/usePostsData';
import { postsApi, type QueuedArticle, type BlogPost, type Store } from '../lib/api-client';
import { useAppBridgeToast } from '../hooks/useAppBridge';
import ArticleEditor from '../components/ArticleEditor';
import ArticlesQueue from '../components/ArticlesQueue';
import { formatAPIErrorMessage } from '../utils/error-messages';
import Tooltip from '../components/Tooltip';

const REFETCH_INTERVAL = 300000;
const ITEMS_PER_PAGE = 20;
const MAX_SEARCH_QUERY_LENGTH = 200;
const STATUS_OPTIONS = ['published', 'scheduled', 'draft', 'archived'] as const;
const DATE_RANGE_OPTIONS = ['7', '30', '90', 'all'] as const;

interface ExtendedBlogPost extends BlogPost {
  readonly excerpt?: string | null;
  readonly seo_title?: string | null;
  readonly seo_description?: string | null;
  readonly featured_image_url?: string | null;
  readonly keywords?: readonly string[] | null;
  readonly views?: number;
}

interface StatusBadge {
  readonly label: string;
  readonly className: string;
}

interface DateRange {
  readonly start?: Date;
  readonly end?: Date;
}

interface ReviewFeedback {
  readonly tone_too_casual?: boolean;
  readonly tone_too_formal?: boolean;
  readonly needs_more_depth?: boolean;
  readonly improve_seo_focus?: boolean;
  readonly better_brand_alignment?: boolean;
}

const formatDate = (date: string | null | undefined): string => {
  if (!date) {
    return '—';
  }
  const d = new Date(date);
  if (isNaN(d.getTime())) {
    return '—';
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const getStatusBadge = (status: string): StatusBadge => {
  switch (status) {
    case 'published':
      return {
        label: 'Published',
        className: 'px-2 py-1 text-xs font-medium rounded-full bg-green-100 text-green-800',
      };
    case 'scheduled':
      return {
        label: 'Scheduled',
        className: 'px-2 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-800',
      };
    case 'draft':
      return {
        label: 'Draft',
        className: 'px-2 py-1 text-xs font-medium rounded-full bg-orange-100 text-orange-800',
      };
    case 'archived':
      return {
        label: 'Archived',
        className: 'px-2 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-800',
      };
    case 'queued':
      return {
        label: 'Queued',
        className: 'px-2 py-1 text-xs font-medium rounded-full bg-purple-100 text-purple-800',
      };
    default:
      return {
        label: status,
        className: 'px-2 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-800',
      };
  }
};

const getDateRangeValue = (value: string): DateRange | null => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (value) {
    case '7':
      return {
        start: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000),
        end: now,
      };
    case '30':
      return {
        start: new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000),
        end: now,
      };
    case '90':
      return {
        start: new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000),
        end: now,
      };
    case 'all':
      return null;
    default:
      return null;
  }
};

const validateSearchQuery = (query: string): string => {
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    return query.slice(0, MAX_SEARCH_QUERY_LENGTH);
  }
  return query;
};

const isStoreWithId = (store: unknown): store is Store & { id: string } => {
  return (
    store !== null &&
    typeof store === 'object' &&
    'id' in store &&
    typeof (store as Store).id === 'string' &&
    (store as Store).id.length > 0
  );
};

const isExtendedBlogPost = (post: BlogPost): post is ExtendedBlogPost => {
  return post !== null && typeof post === 'object';
};

const getStatusTooltipContent = (status: string): string => {
  switch (status) {
    case 'published':
      return 'This article is live and visible on your blog';
    case 'scheduled':
      return 'This article is scheduled to publish at a future date';
    case 'draft':
      return 'This article is a draft and needs review before publishing';
    case 'archived':
      return 'This article has been archived and is hidden from public view';
    default:
      return 'Article status information';
  }
};

export default function Articles(): JSX.Element {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [dateRangeFilter, setDateRangeFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPosts, setSelectedPosts] = useState<Set<string>>(new Set());
  const [showPreviewModal, setShowPreviewModal] = useState<string | null>(null);
  const [previewPost, setPreviewPost] = useState<BlogPost | null>(null);
  const [previewQueueArticle, setPreviewQueueArticle] = useState<QueuedArticle | null>(null);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [editingPost, setEditingPost] = useState<BlogPost | null>(null);
  const [showReviewModal, setShowReviewModal] = useState<string | null>(null);
  const [reviewFeedback, setReviewFeedback] = useState<ReviewFeedback>({});
  const isMountedRef = useRef(true);

  const queryClient = useQueryClient();
  const { showToast } = useAppBridgeToast();

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleError = useCallback(
    (error: unknown) => {
      if (!isMountedRef.current) {
        return;
      }
      const errorMessage = formatAPIErrorMessage(error, { action: 'load articles', resource: 'articles' });
      showToast(errorMessage, { isError: true });
    },
    [showToast],
  );

  const dateRange = useMemo(() => {
    return getDateRangeValue(dateRangeFilter);
  }, [dateRangeFilter]);

  const filters: PostsFilters = useMemo(() => {
    const byStatus = statusFilter ? { status: statusFilter } : {};
    const byDate =
      dateRange && dateRange.start && dateRange.end
        ? {
            dateRange: {
              start: dateRange.start.toISOString(),
              end: dateRange.end.toISOString(),
            },
          }
        : {};
    return { ...byStatus, ...byDate };
  }, [statusFilter, dateRange]);

  const {
    store,
    sortedPosts,
    isLoading,
    isError,
    error,
    refetch,
  } = usePostsData({
    enableRealTime: true,
    refetchInterval: REFETCH_INTERVAL,
    onError: handleError,
    filters,
    searchQuery: validateSearchQuery(searchQuery),
    sortBy: 'date',
    sortDirection: 'desc',
  });

  const totalArticles = useMemo(() => sortedPosts.length, [sortedPosts.length]);

  const paginatedPosts = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;
    return sortedPosts.slice(start, end);
  }, [sortedPosts, currentPage]);

  const totalPages = useMemo(() => {
    return Math.ceil(sortedPosts.length / ITEMS_PER_PAGE);
  }, [sortedPosts.length]);

  const startItem = useMemo(() => {
    return sortedPosts.length === 0 ? 0 : (currentPage - 1) * ITEMS_PER_PAGE + 1;
  }, [sortedPosts.length, currentPage]);

  const endItem = useMemo(() => {
    return Math.min(currentPage * ITEMS_PER_PAGE, sortedPosts.length);
  }, [sortedPosts.length, currentPage]);

  const storeId = useMemo(() => {
    return isStoreWithId(store) ? store.id : null;
  }, [store]);

  const handlePostClick = useCallback(
    async (postId: string) => {
      if (!isMountedRef.current) {
        return;
      }
      try {
        const post = await postsApi.get(postId);
        if (isMountedRef.current) {
          setEditingPost(post);
          setEditingPostId(postId);
        }
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }
        const errorMessage = formatAPIErrorMessage(error, { action: 'load article', resource: 'article' });
        showToast(errorMessage, { isError: true });
      }
    },
    [showToast],
  );

  const deletePostMutation = useMutation({
    mutationFn: (postId: string) => postsApi.delete(postId),
    onSuccess: () => {
      if (!isMountedRef.current) {
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      showToast('Article deleted successfully', { isError: false });
    },
    onError: (error) => {
      if (!isMountedRef.current) {
        return;
      }
      const errorMessage = formatAPIErrorMessage(error, { action: 'delete article', resource: 'article' });
      showToast(errorMessage, { isError: true });
    },
  });

  const handleDelete = useCallback(
    (postId: string) => {
      if (window.confirm('Are you sure you want to delete this article? This action cannot be undone.')) {
        deletePostMutation.mutate(postId);
      }
    },
    [deletePostMutation],
  );

  const handleBulkDelete = useCallback(() => {
    if (selectedPosts.size === 0) {
      return;
    }
    if (window.confirm(`Are you sure you want to delete ${selectedPosts.size} article(s)? This action cannot be undone.`)) {
      postsApi
        .bulkDelete(Array.from(selectedPosts))
        .then(() => {
          if (!isMountedRef.current) {
            return;
          }
          queryClient.invalidateQueries({ queryKey: ['posts'] });
          setSelectedPosts(new Set());
          showToast(`${selectedPosts.size} article${selectedPosts.size > 1 ? 's' : ''} deleted successfully`, { isError: false });
        })
        .catch((error) => {
          if (!isMountedRef.current) {
            return;
          }
          const errorMessage = formatAPIErrorMessage(error, { action: 'delete articles', resource: 'articles' });
          showToast(errorMessage, { isError: true });
        });
    }
  }, [selectedPosts, queryClient, showToast]);

  const handleBulkPublish = useCallback(() => {
    if (selectedPosts.size === 0) {
      return;
    }
    postsApi
      .bulkUpdate(Array.from(selectedPosts), { status: 'published' })
      .then(() => {
        if (!isMountedRef.current) {
          return;
        }
        queryClient.invalidateQueries({ queryKey: ['posts'] });
        setSelectedPosts(new Set());
        showToast(`${selectedPosts.size} article${selectedPosts.size > 1 ? 's' : ''} published successfully`, { isError: false });
      })
      .catch((error) => {
        if (!isMountedRef.current) {
          return;
        }
        const errorMessage = formatAPIErrorMessage(error, { action: 'publish articles', resource: 'articles' });
        showToast(errorMessage, { isError: true });
      });
  }, [selectedPosts, queryClient, showToast]);

  const handleBulkArchive = useCallback(() => {
    if (selectedPosts.size === 0) {
      return;
    }
    postsApi
      .bulkUpdate(Array.from(selectedPosts), { status: 'archived' })
      .then(() => {
        if (!isMountedRef.current) {
          return;
        }
        queryClient.invalidateQueries({ queryKey: ['posts'] });
        setSelectedPosts(new Set());
        showToast(`${selectedPosts.size} article${selectedPosts.size > 1 ? 's' : ''} archived successfully`, { isError: false });
      })
      .catch((error) => {
        if (!isMountedRef.current) {
          return;
        }
        const errorMessage = formatAPIErrorMessage(error, { action: 'archive articles', resource: 'articles' });
        showToast(errorMessage, { isError: true });
      });
  }, [selectedPosts, queryClient, showToast]);

  const handleToggleSelect = useCallback((postId: string) => {
    setSelectedPosts((prev) => {
      const next = new Set(prev);
      if (next.has(postId)) {
        next.delete(postId);
      } else {
        next.add(postId);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (selectedPosts.size === paginatedPosts.length) {
      setSelectedPosts(new Set());
    } else {
      setSelectedPosts(new Set(paginatedPosts.map((p) => p.id)));
    }
  }, [selectedPosts.size, paginatedPosts]);

  const handlePreview = useCallback(
    async (postId: string) => {
      if (!isMountedRef.current) {
        return;
      }
      try {
        const post = await postsApi.get(postId);
        if (isMountedRef.current) {
          setPreviewPost(post);
          setPreviewQueueArticle(null);
          setShowPreviewModal(postId);
        }
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }
        const errorMessage = formatAPIErrorMessage(error, { action: 'load article preview', resource: 'article' });
        showToast(errorMessage, { isError: true });
      }
    },
    [showToast],
  );

  const handleQueueArticleClick = useCallback((article: QueuedArticle) => {
    setPreviewQueueArticle(article);
    setPreviewPost(null);
    setShowPreviewModal(article.id);
  }, []);

  const schedulePostMutation = useMutation({
    mutationFn: ({ postId, scheduledAt }: { postId: string; scheduledAt: string }) =>
      postsApi.schedule(postId, scheduledAt),
    onSuccess: () => {
      if (!isMountedRef.current) {
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      showToast('Article scheduled successfully', { isError: false });
    },
    onError: (error) => {
      if (!isMountedRef.current) {
        return;
      }
      const errorMessage = formatAPIErrorMessage(error, { action: 'schedule article', resource: 'article' });
      showToast(errorMessage, { isError: true });
    },
  });

  const handleStatusFilterChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setStatusFilter(e.target.value);
    setCurrentPage(1);
  }, []);

  const handleDateRangeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setDateRangeFilter(e.target.value);
    setCurrentPage(1);
  }, []);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const validated = validateSearchQuery(e.target.value);
    setSearchQuery(validated);
    setCurrentPage(1);
  }, []);

  const handlePreviousPage = useCallback(() => {
    setCurrentPage((prev) => Math.max(1, prev - 1));
  }, []);

  const handleNextPage = useCallback(() => {
    setCurrentPage((prev) => Math.min(totalPages, prev + 1));
  }, [totalPages]);

  const handleApprovePost = useCallback(
    async (postId: string) => {
      if (!isMountedRef.current) {
        return;
      }
      try {
        await postsApi.approve(postId);
        if (isMountedRef.current) {
          queryClient.invalidateQueries({ queryKey: ['posts'] });
          showToast('Article approved successfully', { isError: false });
        }
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }
        const errorMessage = formatAPIErrorMessage(error, { action: 'approve article', resource: 'article' });
        showToast(errorMessage, { isError: true });
      }
    },
    [queryClient, showToast],
  );

  const handleRejectPost = useCallback(
    async (postId: string, feedback: ReviewFeedback) => {
      if (!isMountedRef.current) {
        return;
      }
      try {
        await postsApi.reject(postId, feedback as Readonly<Record<string, unknown>>);
        if (isMountedRef.current) {
          queryClient.invalidateQueries({ queryKey: ['posts'] });
          setShowReviewModal(null);
          setReviewFeedback({});
          showToast('Article rejected successfully', { isError: false });
        }
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }
        const errorMessage = formatAPIErrorMessage(error, { action: 'reject article', resource: 'article' });
        showToast(errorMessage, { isError: true });
      }
    },
    [queryClient, showToast],
  );

  const handleRegeneratePost = useCallback(
    async (postId: string, feedback: ReviewFeedback, storeIdValue: string) => {
      if (!isMountedRef.current) {
        return;
      }
      try {
        const limitCheck = await postsApi.checkRegenerationLimits(storeIdValue, postId);
        if (!limitCheck.allowed) {
          if (!isMountedRef.current) {
            return;
          }
          const friendlyReason = limitCheck.reason
            ? limitCheck.reason.replace(/regeneration limit/i, "You've reached your monthly regeneration limit")
            : "You've reached your monthly regeneration limit. Please try again next month or use a different article.";
          showToast(friendlyReason, { isError: true });
          return;
        }

        await postsApi.regenerate(postId, feedback as Readonly<Record<string, unknown>>, storeIdValue);
        if (isMountedRef.current) {
          queryClient.invalidateQueries({ queryKey: ['posts'] });
          setShowReviewModal(null);
          setReviewFeedback({});
          showToast('Article regeneration started successfully', { isError: false });
        }
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }
        const errorMessage = formatAPIErrorMessage(error, { action: 'regenerate article', resource: 'article' });
        showToast(errorMessage, { isError: true });
      }
    },
    [queryClient, showToast],
  );

  const handleClosePreview = useCallback(() => {
    setShowPreviewModal(null);
    setPreviewPost(null);
    setPreviewQueueArticle(null);
  }, []);

  const handleCloseReview = useCallback(() => {
    setShowReviewModal(null);
    setReviewFeedback({});
  }, []);

  const handleUpdateReviewFeedback = useCallback((key: keyof ReviewFeedback, value: boolean) => {
    setReviewFeedback((prev) => ({ ...prev, [key]: value }));
  }, []);

  if (isLoading) {
    return (
      <div className="h-screen overflow-hidden bg-gray-50">
        <main className="h-full overflow-y-auto bg-gray-50">
          <header className="bg-white border-b border-gray-200 px-4 sm:px-6 lg:px-8 py-4 sm:py-5 lg:py-6">
            <div className="animate-pulse">
              <div className="h-8 w-48 bg-gray-200 rounded mb-2"></div>
              <div className="h-4 w-64 bg-gray-200 rounded"></div>
            </div>
          </header>
          <div className="p-4 sm:p-6 lg:p-8">
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm mb-6 sm:mb-8 animate-pulse">
              <div className="p-4 sm:p-5 lg:p-6">
                <div className="h-6 w-24 bg-gray-200 rounded mb-4"></div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-20 bg-gray-100 rounded"></div>
                  ))}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-5 lg:gap-6 mb-6 sm:mb-8">
              {[1, 2, 3].map((i) => (
                <div key={i} className="bg-white rounded-xl p-4 sm:p-5 lg:p-6 border border-gray-200 shadow-sm animate-pulse">
                  <div className="h-4 w-24 bg-gray-200 rounded mb-3"></div>
                  <div className="h-10 w-16 bg-gray-200 rounded"></div>
                </div>
              ))}
            </div>
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm animate-pulse">
              <div className="p-4">
                <div className="h-6 w-32 bg-gray-200 rounded mb-4"></div>
                <div className="space-y-3">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="h-16 bg-gray-100 rounded"></div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (isError && error && !store) {
    return (
      <div className="h-screen overflow-hidden bg-gray-50">
        <main className="h-full overflow-y-auto bg-gray-50">
          <div className="p-4 sm:p-6 lg:p-8">
            <div className="bg-red-50 border border-red-200 rounded-xl p-6 max-w-2xl mx-auto">
              <h2 className="text-lg font-semibold text-red-900 mb-2">Setup Required</h2>
              <p className="text-sm text-red-700 mb-4">{formatAPIErrorMessage(error, { action: 'load articles', resource: 'articles' })}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => window.location.reload()}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
                  type="button"
                >
                  Refresh Page
                </button>
                <button
                  onClick={() => refetch()}
                  className="px-4 py-2 border border-red-300 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 transition-colors"
                  type="button"
                >
                  Retry
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (editingPostId && editingPost) {
    return (
      <ArticleEditor
        post={editingPost}
        onSave={() => {
          setEditingPostId(null);
          setEditingPost(null);
          queryClient.invalidateQueries({ queryKey: ['posts'] });
        }}
        onCancel={() => {
          setEditingPostId(null);
          setEditingPost(null);
        }}
      />
    );
  }

  const extendedPreviewPost = previewPost && isExtendedBlogPost(previewPost) ? previewPost : null;

  return (
    <div className="h-screen overflow-hidden bg-gray-50">
      <main className="h-full overflow-y-auto bg-gray-50">
        <header className="bg-white border-b border-gray-200 px-4 sm:px-6 lg:px-8 py-4 sm:py-5 lg:py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 sm:gap-3">
              <button
                onClick={() => navigate('/dashboard')}
                className="text-gray-600 hover:text-gray-900 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 rounded"
                aria-label="Back to dashboard"
                type="button"
              >
                <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <div>
                <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-gray-900">Articles</h1>
                <p className="text-xs sm:text-sm text-gray-500 mt-1">Review and manage your automatically generated content</p>
              </div>
            </div>
          </div>
        </header>

        <div className="p-4 sm:p-6 lg:p-8">
          {storeId && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm mb-6 sm:mb-8">
              <div className="p-4 sm:p-5 lg:p-6">
                <ArticlesQueue storeId={storeId} onArticleClick={handleQueueArticleClick} />
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm mb-6 sm:mb-8">
            <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
              <h2 className="text-base sm:text-lg font-semibold text-gray-900">Filters</h2>
            </div>
            <div className="p-4 sm:p-5 lg:p-6">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="store-search" className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                    Search
                  </label>
                  <input
                    id="store-search"
                    type="text"
                    placeholder="Search articles..."
                    value={searchQuery}
                    onChange={handleSearchChange}
                    maxLength={MAX_SEARCH_QUERY_LENGTH}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors touch-manipulation"
                  />
                </div>
                <div>
                  <label htmlFor="status-filter" className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                    Status
                  </label>
                  <select
                    id="status-filter"
                    value={statusFilter}
                    onChange={handleStatusFilterChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors touch-manipulation"
                  >
                    <option value="">All Status</option>
                    {STATUS_OPTIONS.map((status) => (
                      <option key={status} value={status}>
                        {getStatusBadge(status).label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="date-range-filter" className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                    Date Range
                  </label>
                  <select
                    id="date-range-filter"
                    value={dateRangeFilter}
                    onChange={handleDateRangeChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors touch-manipulation"
                  >
                    <option value="7">Last 7 days</option>
                    <option value="30">Last 30 days</option>
                    <option value="90">Last 90 days</option>
                    <option value="all">All time</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {selectedPosts.size > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm mb-6 sm:mb-8 p-4 sm:p-5 lg:p-6">
              <div className="flex items-center justify-between flex-wrap gap-4">
                <p className="text-sm text-gray-700">
                  <strong>{selectedPosts.size}</strong> article{selectedPosts.size !== 1 ? 's' : ''} selected
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={handleBulkPublish}
                    className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                    type="button"
                  >
                    Publish
                  </button>
                  <button
                    onClick={handleBulkArchive}
                    className="px-3 py-1.5 text-sm bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
                    type="button"
                  >
                    Archive
                  </button>
                  <button
                    onClick={handleBulkDelete}
                    className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                    type="button"
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => setSelectedPosts(new Set())}
                    className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                    type="button"
                  >
                    Clear Selection
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            {isError && error && (
              <div className="p-4 sm:p-6 border-b border-red-200 bg-red-50">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-red-900 mb-1">Failed to load articles</h3>
                    <p className="text-xs text-red-700">{formatAPIErrorMessage(error, { action: 'load articles', resource: 'articles' })}</p>
                  </div>
                  <button
                    onClick={() => refetch()}
                    className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                    type="button"
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}

            {sortedPosts.length === 0 && !isLoading ? (
              <div className="p-8 sm:p-12 text-center">
                <svg className="w-12 h-12 sm:w-16 sm:h-16 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                <h3 className="text-base sm:text-lg font-semibold text-gray-900 mb-2">No articles found</h3>
                <p className="text-sm text-gray-500 mb-4">
                  {statusFilter || searchQuery || dateRangeFilter !== 'all'
                    ? 'Try adjusting your filters.'
                    : 'Articles are automatically generated based on your schedule and preferences. Check back soon to see your content.'}
                </p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto -mx-4 sm:mx-0">
                  <div className="inline-block min-w-full align-middle">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          <th className="px-3 sm:px-4 py-3 text-left">
                            <input
                              type="checkbox"
                              checked={selectedPosts.size === paginatedPosts.length && paginatedPosts.length > 0}
                              onChange={handleSelectAll}
                              className="w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
                              aria-label="Select all articles"
                            />
                          </th>
                          <th className="px-3 sm:px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider min-w-[200px]">
                            Article Title
                          </th>
                          <th className="px-3 sm:px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider whitespace-nowrap">
                            <Tooltip content="Article status: Published (live), Scheduled (will publish later), Draft (needs review), or Archived (hidden)">
                              <span className="cursor-help">Status</span>
                            </Tooltip>
                          </th>
                          <th className="px-3 sm:px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider whitespace-nowrap">
                            <Tooltip content="Number of times this article has been viewed by visitors">
                              <span className="cursor-help">Views</span>
                            </Tooltip>
                          </th>
                          <th className="px-3 sm:px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider whitespace-nowrap">
                            <Tooltip content="Date when the article was created or first published">
                              <span className="cursor-help">Created</span>
                            </Tooltip>
                          </th>
                          <th className="px-3 sm:px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider whitespace-nowrap">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 bg-white">
                        {paginatedPosts.map((post) => {
                          const statusBadge = getStatusBadge(post.status);
                          const extendedPost = isExtendedBlogPost(post) ? post : null;
                          return (
                            <tr key={post.id} className="hover:bg-gray-50 transition-colors">
                              <td className="px-3 sm:px-4 py-3">
                                <input
                                  type="checkbox"
                                  checked={selectedPosts.has(post.id)}
                                  onChange={() => handleToggleSelect(post.id)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
                                  aria-label={`Select ${post.title}`}
                                />
                              </td>
                              <td className="px-3 sm:px-4 py-3 text-sm text-gray-900 cursor-pointer min-w-[200px]" onClick={() => handlePostClick(post.id)}>
                                <div className="font-medium truncate">{post.title}</div>
                                {extendedPost?.excerpt && (
                                  <div className="text-xs text-gray-500 mt-1 line-clamp-1">{extendedPost.excerpt}</div>
                                )}
                              </td>
                              <td className="px-3 sm:px-4 py-3 whitespace-nowrap">
                                <Tooltip content={getStatusTooltipContent(post.status)}>
                                  <span className={statusBadge.className}>{statusBadge.label}</span>
                                </Tooltip>
                              </td>
                              <td className="px-3 sm:px-4 py-3 text-sm text-gray-700 whitespace-nowrap">
                                {extendedPost?.views !== undefined ? extendedPost.views.toLocaleString() : '—'}
                              </td>
                              <td className="px-3 sm:px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
                                {formatDate(post.published_at || post.scheduled_publish_at || post.created_at)}
                              </td>
                              <td className="px-3 sm:px-4 py-3 whitespace-nowrap">
                                <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handlePostClick(post.id);
                                    }}
                                    className="text-xs text-purple-600 hover:text-purple-700 font-medium touch-manipulation"
                                    title="Edit"
                                    type="button"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handlePreview(post.id);
                                    }}
                                    className="text-xs text-blue-600 hover:text-blue-700 font-medium touch-manipulation"
                                    title="Preview"
                                    type="button"
                                  >
                                    Preview
                                  </button>
                                  {post.status === 'draft' && post.review_status === 'pending' && (
                                    <>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleApprovePost(post.id);
                                        }}
                                        className="text-xs text-green-600 hover:text-green-700 font-medium touch-manipulation"
                                        title="Approve"
                                        type="button"
                                      >
                                        Approve
                                      </button>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setShowReviewModal(post.id);
                                          setReviewFeedback({});
                                        }}
                                        className="text-xs text-orange-600 hover:text-orange-700 font-medium touch-manipulation"
                                        title="Review"
                                        type="button"
                                      >
                                        Review
                                      </button>
                                    </>
                                  )}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDelete(post.id);
                                    }}
                                    className="text-xs text-red-600 hover:text-red-700 font-medium touch-manipulation"
                                    type="button"
                                  >
                                    Delete
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {totalPages > 1 && (
                  <div className="px-4 py-3 border-t border-gray-200 flex flex-col sm:flex-row items-center justify-between gap-3">
                    <p className="text-xs sm:text-sm text-gray-500">
                      Showing {startItem}-{endItem} of {totalArticles.toLocaleString()} articles
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handlePreviousPage}
                        disabled={currentPage === 1}
                        className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation"
                        aria-label="Previous page"
                        type="button"
                      >
                        Previous
                      </button>
                      <span className="px-3 py-1.5 text-sm text-gray-700">
                        Page {currentPage} of {totalPages}
                      </span>
                      <button
                        onClick={handleNextPage}
                        disabled={currentPage === totalPages}
                        className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation"
                        aria-label="Next page"
                        type="button"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {showPreviewModal && (previewPost || previewQueueArticle) && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-2 sm:p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[95vh] sm:max-h-[90vh] overflow-hidden flex flex-col m-2 sm:m-0">
              <div className="p-4 sm:p-6 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
                <h2 className="text-lg sm:text-xl font-bold text-gray-900 truncate pr-2">Article Preview</h2>
                <button
                  onClick={handleClosePreview}
                  className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0 touch-manipulation p-1"
                  aria-label="Close preview"
                  type="button"
                >
                  <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 sm:p-6">
                {previewQueueArticle ? (
                  <>
                    <div className="mb-4 bg-purple-50 border border-purple-200 rounded-lg p-4">
                      <p className="text-sm text-purple-800">
                        <strong>Queue Article:</strong> This article is in the publishing queue and will be automatically published according to your schedule.
                      </p>
                    </div>
                    <div className="prose max-w-none">
                      <div className="mb-4 space-y-2">
                        <h1 className="text-3xl font-bold">{previewQueueArticle.title}</h1>
                        {previewQueueArticle.scheduled_publish_at && (
                          <p className="text-sm text-gray-500">Scheduled: {formatDate(previewQueueArticle.scheduled_publish_at)}</p>
                        )}
                      </div>
                      {previewQueueArticle.content ? (
                        <div className="article-content" dangerouslySetInnerHTML={{ __html: previewQueueArticle.content }} />
                      ) : (
                        <p className="text-gray-500 italic">Content not available for preview.</p>
                      )}
                    </div>
                  </>
                ) : extendedPreviewPost ? (
                  <>
                    {extendedPreviewPost.ai_metadata && (
                      <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
                        <h3 className="text-sm font-semibold text-blue-900 mb-3">Why This Article Was Created</h3>
                        <div className="space-y-2 text-sm text-blue-800">
                          {extendedPreviewPost.ai_metadata.topic_reason && (
                            <p>
                              <strong>Topic:</strong> {extendedPreviewPost.ai_metadata.topic_reason}
                            </p>
                          )}
                          {extendedPreviewPost.ai_metadata.seo_goals && (
                            <p>
                              <strong>SEO Goal:</strong> {extendedPreviewPost.ai_metadata.seo_goals}
                            </p>
                          )}
                          {extendedPreviewPost.ai_metadata.keyword_opportunity && (
                            <p>
                              <strong>Keyword Opportunity:</strong> {extendedPreviewPost.ai_metadata.keyword_opportunity}
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="prose max-w-none">
                      <div className="mb-4 space-y-2">
                        <h1 className="text-3xl font-bold">{extendedPreviewPost.title}</h1>
                        {extendedPreviewPost.seo_title && extendedPreviewPost.seo_title !== extendedPreviewPost.title && (
                          <p className="text-sm text-gray-500">SEO Title: {extendedPreviewPost.seo_title}</p>
                        )}
                        {extendedPreviewPost.seo_description && (
                          <p className="text-sm text-gray-600">{extendedPreviewPost.seo_description}</p>
                        )}
                      </div>
                      {extendedPreviewPost.excerpt && <p className="text-lg text-gray-600 mb-6">{extendedPreviewPost.excerpt}</p>}
                      {extendedPreviewPost.featured_image_url && (
                        <img
                          src={extendedPreviewPost.featured_image_url}
                          alt={extendedPreviewPost.title}
                          className="w-full h-auto rounded-lg mb-6"
                        />
                      )}
                      <div className="article-content" dangerouslySetInnerHTML={{ __html: extendedPreviewPost.content || '' }} />
                      {extendedPreviewPost.keywords && extendedPreviewPost.keywords.length > 0 && (
                        <div className="mt-6 pt-6 border-t border-gray-200">
                          <p className="text-sm font-medium text-gray-700 mb-2">Keywords:</p>
                          <div className="flex flex-wrap gap-2">
                            {extendedPreviewPost.keywords.map((keyword, idx) => (
                              <span key={idx} className="px-2 py-1 bg-gray-100 text-gray-700 rounded text-xs">
                                {keyword}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                ) : null}
              </div>
              <div className="p-4 sm:p-6 border-t border-gray-200 flex items-center justify-end gap-2 sm:gap-3 flex-wrap flex-shrink-0">
                <button
                  onClick={handleClosePreview}
                  className="px-3 sm:px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors touch-manipulation"
                  type="button"
                >
                  Close
                </button>
                {previewPost && previewPost.status === 'draft' && previewPost.review_status === 'pending' && (
                  <button
                    onClick={async () => {
                      await handleApprovePost(previewPost.id);
                      handleClosePreview();
                    }}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors"
                    type="button"
                  >
                    Approve
                  </button>
                )}
                {previewPost && (
                  <button
                    onClick={() => {
                      handleClosePreview();
                      handlePostClick(previewPost.id);
                    }}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors"
                    type="button"
                  >
                    {previewPost.status === 'draft' ? 'Edit Article' : 'View Article'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {showReviewModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-2 sm:p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full max-h-[95vh] sm:max-h-[90vh] overflow-y-auto m-2 sm:m-0 p-4 sm:p-6">
              <h2 className="text-lg sm:text-xl font-bold text-gray-900 mb-4">Review Article</h2>
              <div className="space-y-4">
                {showReviewModal && storeId && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
                    <p className="text-blue-800 font-medium mb-1">Regeneration Limits</p>
                    <p className="text-blue-700 text-xs">You can regenerate this article up to 3 times. Monthly limits apply based on your plan.</p>
                  </div>
                )}
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-3">Feedback (select all that apply):</p>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={reviewFeedback.tone_too_casual || false}
                        onChange={(e) => handleUpdateReviewFeedback('tone_too_casual', e.target.checked)}
                        className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                      />
                      <span className="text-sm text-gray-700">Tone too casual</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={reviewFeedback.tone_too_formal || false}
                        onChange={(e) => handleUpdateReviewFeedback('tone_too_formal', e.target.checked)}
                        className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                      />
                      <span className="text-sm text-gray-700">Tone too formal</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={reviewFeedback.needs_more_depth || false}
                        onChange={(e) => handleUpdateReviewFeedback('needs_more_depth', e.target.checked)}
                        className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                      />
                      <span className="text-sm text-gray-700">Needs more depth</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={reviewFeedback.improve_seo_focus || false}
                        onChange={(e) => handleUpdateReviewFeedback('improve_seo_focus', e.target.checked)}
                        className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                      />
                      <span className="text-sm text-gray-700">Improve SEO focus</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={reviewFeedback.better_brand_alignment || false}
                        onChange={(e) => handleUpdateReviewFeedback('better_brand_alignment', e.target.checked)}
                        className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                      />
                      <span className="text-sm text-gray-700">Better brand alignment</span>
                    </label>
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 pt-4">
                  <button
                    onClick={handleCloseReview}
                    className="flex-1 px-3 sm:px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors touch-manipulation"
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      if (showReviewModal) {
                        await handleRejectPost(showReviewModal, reviewFeedback);
                      }
                    }}
                    className="flex-1 px-3 sm:px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-700 transition-colors touch-manipulation"
                    type="button"
                  >
                    Reject
                  </button>
                  <button
                    onClick={async () => {
                      if (!storeId || !showReviewModal) {
                        showToast("We couldn't find your store information. Please refresh the page and try again.", { isError: true });
                        return;
                      }
                      await handleRegeneratePost(showReviewModal, reviewFeedback, storeId);
                    }}
                    className="flex-1 px-3 sm:px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors touch-manipulation"
                    type="button"
                  >
                    Regenerate
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
