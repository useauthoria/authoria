import { useState, useCallback, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queueApi, type QueuedArticle } from '../lib/api-client';
import { useAppBridgeToast } from '../hooks/useAppBridge';
import { formatAPIErrorMessage } from '../utils/error-messages';

interface ArticlesQueueProps {
  storeId: string;
  onArticleClick?: (article: QueuedArticle) => void;
  showTitle?: boolean;
  maxItems?: number;
}

export default function ArticlesQueue({ storeId, onArticleClick, showTitle = true, maxItems }: ArticlesQueueProps) {
  const { showToast } = useAppBridgeToast();
  const queryClient = useQueryClient();
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const { data: queue = [], isLoading, error, refetch } = useQuery({
    queryKey: ['queue', storeId],
    queryFn: () => queueApi.getQueue(storeId),
    refetchInterval: 30000, // Refetch every 30 seconds
  });

  const { data: metrics } = useQuery({
    queryKey: ['queue-metrics', storeId],
    queryFn: () => queueApi.getMetrics(storeId),
    refetchInterval: 30000, // Refetch every 30 seconds to ensure queue stays filled
  });

  // Auto-refill queue when it's below target - ensure queue is always filled for active stores
  useEffect(() => {
    if (metrics && metrics.targetCount > 0 && metrics.needsRefill && !refillMutation.isPending) {
      // Small delay to avoid race conditions with other refetches
      const timer = setTimeout(() => {
        if (queue.length < metrics.targetCount) {
          refillMutation.mutate();
        }
      }, 2000); // 2 second delay to batch refills
      return () => clearTimeout(timer);
    }
  }, [metrics?.needsRefill, metrics?.targetCount, queue.length, refillMutation, metrics]);

  const displayedQueue = maxItems ? queue.slice(0, maxItems) : queue;

  const reorderMutation = useMutation({
    mutationFn: (articleIds: string[]) => queueApi.reorder(storeId, articleIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue', storeId] });
      showToast('Queue order updated', { isError: false });
    },
    onError: (error) => {
      console.error('Failed to reorder queue:', error);
      const errorMessage = formatAPIErrorMessage(error, { action: 'reorder queue', resource: 'queue' });
      showToast(errorMessage, { isError: true });
    },
  });

  const regenerateTitleMutation = useMutation({
    mutationFn: (articleId: string) => queueApi.regenerateTitle(storeId, articleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue', storeId] });
      showToast('Title regenerated successfully', { isError: false });
    },
    onError: (error) => {
      console.error('Failed to regenerate title:', error);
      const errorMessage = formatAPIErrorMessage(error, { action: 'regenerate title', resource: 'article' });
      showToast(errorMessage, { isError: true });
    },
  });

  const refillMutation = useMutation({
    mutationFn: () => queueApi.refill(storeId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['queue', storeId] });
      queryClient.invalidateQueries({ queryKey: ['queue-metrics', storeId] });
      if (data.created > 0) {
        showToast(`${data.created} article${data.created > 1 ? 's' : ''} added to queue`, { isError: false });
      }
    },
    onError: (error) => {
      console.error('Failed to refill queue:', error);
      // Don't show error toast for auto-refill
    },
  });

  const handleDragStart = useCallback((index: number) => {
    setDraggedIndex(index);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    
    if (draggedIndex === null || draggedIndex === dropIndex) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    const newOrder = [...queue];
    const [draggedItem] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(dropIndex, 0, draggedItem);

    const articleIds = newOrder.map((article) => article.id);
    reorderMutation.mutate(articleIds);

    setDraggedIndex(null);
    setDragOverIndex(null);
  }, [draggedIndex, queue, reorderMutation]);

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, []);

  const handleRegenerateTitle = useCallback((e: React.MouseEvent, articleId: string) => {
    e.stopPropagation();
    regenerateTitleMutation.mutate(articleId);
  }, [regenerateTitleMutation]);

  const handleArticleClick = useCallback((article: QueuedArticle) => {
    if (onArticleClick) {
      onArticleClick(article);
    }
  }, [onArticleClick]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-gray-100 rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
        <p className="text-sm text-red-700">Failed to load queue. Please refresh.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {showTitle && (
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">
            Upcoming Articles ({queue.length}{metrics ? `/${metrics.targetCount}` : ''})
          </h3>
          {metrics?.needsRefill && (
            <button
              onClick={() => refillMutation.mutate()}
              disabled={refillMutation.isPending}
              className="text-xs text-purple-600 hover:text-purple-700 font-medium disabled:opacity-50"
            >
              {refillMutation.isPending ? 'Refilling...' : 'Refill Queue'}
            </button>
          )}
        </div>
      )}

      {displayedQueue.length === 0 ? (
        <div className="p-4 text-center text-sm text-gray-500 bg-gray-50 rounded-lg border border-gray-200">
          <p>No articles in queue. Articles will be automatically generated based on your schedule.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {displayedQueue.map((article, index) => (
            <div
              key={article.id}
              draggable
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              onClick={() => handleArticleClick(article)}
              className={`
                p-3 bg-white border-2 rounded-lg cursor-move transition-all
                ${draggedIndex === index ? 'opacity-50 border-purple-500' : 'border-gray-200 hover:border-purple-300'}
                ${dragOverIndex === index ? 'border-purple-500 bg-purple-50' : ''}
                ${onArticleClick ? 'cursor-pointer' : ''}
              `}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <svg
                      className="w-4 h-4 text-gray-400 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                    <span className="text-xs text-gray-500 font-medium">#{index + 1}</span>
                  </div>
                  <p className="text-sm font-medium text-gray-900 line-clamp-2">{article.title}</p>
                </div>
                <button
                  onClick={(e) => handleRegenerateTitle(e, article.id)}
                  disabled={regenerateTitleMutation.isPending}
                  className="flex-shrink-0 p-1 text-gray-400 hover:text-purple-600 transition-colors disabled:opacity-50"
                  title="Regenerate title"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {metrics && queue.length < metrics.targetCount && (
        <button
          onClick={() => refillMutation.mutate()}
          disabled={refillMutation.isPending}
          className="w-full py-2 px-3 text-xs font-medium text-purple-600 border border-purple-300 rounded-lg hover:bg-purple-50 transition-colors disabled:opacity-50"
        >
          {refillMutation.isPending ? 'Adding articles...' : `Add ${metrics.targetCount - queue.length} more article${metrics.targetCount - queue.length > 1 ? 's' : ''}`}
        </button>
      )}
    </div>
  );
}

