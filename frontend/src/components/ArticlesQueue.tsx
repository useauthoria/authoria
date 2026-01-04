import { useState, useCallback, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queueApi, type QueuedArticle } from '../lib/api-client';
import { useAppBridgeToast } from '../hooks/useAppBridge';
import { formatAPIErrorMessage } from '../utils/error-messages';

interface ArticlesQueueProps {
  storeId: string;
  onArticleClick?: (article: QueuedArticle) => void;
  showTitle?: boolean;
  maxItems?: number;
  selectedDays?: Set<number>; // Day indices: Mon=0, Tue=1, ..., Sun=6
  publishTime?: string; // Format: "HH:mm"
}

// Convert our day index (Mon=0, ..., Sun=6) to JS Date.getDay() format (Sun=0, Mon=1, ..., Sat=6)
function dayIndexToJsDay(index: number): number {
  return index === 6 ? 0 : index + 1;
}

// Calculate the next publishing dates based on selected days and publish time
function calculateNextPublishingDates(
  selectedDays: Set<number>,
  publishTime: string,
  count: number
): Date[] {
  if (selectedDays.size === 0 || count === 0) return [];
  
  const dates: Date[] = [];
  const now = new Date();
  const [hours, minutes] = publishTime.split(':').map(Number);
  
  // Convert selected day indices to JS day format
  const jsDays = Array.from(selectedDays).map(dayIndexToJsDay).sort((a, b) => a - b);
  
  // Start from today
  let currentDate = new Date(now);
  currentDate.setHours(hours, minutes, 0, 0);
  
  // If current time has passed today, start from tomorrow
  if (currentDate <= now) {
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  // Find the next occurrence of each selected day
  let attempts = 0;
  const maxAttempts = 100; // Safety limit to prevent infinite loops
  
  while (dates.length < count && attempts < maxAttempts) {
    const currentDay = currentDate.getDay();
    
    // Check if current day is in selected days
    if (jsDays.includes(currentDay)) {
      dates.push(new Date(currentDate));
    }
    
    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1);
    attempts++;
  }
  
  return dates.slice(0, count);
}

function formatDate(date: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  const dateOnly = new Date(date);
  dateOnly.setHours(0, 0, 0, 0);
  
  if (dateOnly.getTime() === today.getTime()) {
    return 'Today';
  } else if (dateOnly.getTime() === tomorrow.getTime()) {
    return 'Tomorrow';
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

export default function ArticlesQueue({ storeId, onArticleClick, showTitle = true, maxItems, selectedDays, publishTime = '14:00' }: ArticlesQueueProps) {
  const { showToast } = useAppBridgeToast();
  const queryClient = useQueryClient();
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [wasDragging, setWasDragging] = useState(false);

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

  const displayedQueue = maxItems ? queue.slice(0, maxItems) : queue;
  
  // Calculate scheduled dates for articles if schedule settings are provided
  const scheduledDates = useMemo(() => {
    if (!selectedDays || selectedDays.size === 0) return [];
    return calculateNextPublishingDates(selectedDays, publishTime, displayedQueue.length);
  }, [selectedDays, publishTime, displayedQueue.length]);

  const reorderMutation = useMutation({
    mutationFn: (articleIds: string[]) => queueApi.reorder(storeId, articleIds),
    onMutate: async (newArticleIds) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['queue', storeId] });

      // Snapshot the previous value
      const previousQueue = queryClient.getQueryData<QueuedArticle[]>(['queue', storeId]);

      // Optimistically update to the new value
      if (previousQueue) {
        // Reorder based on new IDs
        const articleMap = new Map(previousQueue.map((article) => [article.id, article]));
        const reorderedQueue = newArticleIds
          .map((id) => articleMap.get(id))
          .filter((article): article is QueuedArticle => article !== undefined);
        
        queryClient.setQueryData<QueuedArticle[]>(['queue', storeId], reorderedQueue);
      }

      // Return context with the previous value
      return { previousQueue };
    },
    onError: (error, newArticleIds, context) => {
      // Rollback to previous value on error
      if (context?.previousQueue) {
        queryClient.setQueryData(['queue', storeId], context.previousQueue);
      }
      console.error('Failed to reorder queue:', error);
      const errorMessage = formatAPIErrorMessage(error, { action: 'reorder queue', resource: 'queue' });
      showToast(errorMessage, { isError: true });
    },
    onSettled: () => {
      // Always refetch after error or success to ensure consistency
      queryClient.invalidateQueries({ queryKey: ['queue', storeId] });
    },
    onSuccess: () => {
      showToast('Queue order updated', { isError: false });
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

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    setWasDragging(true);
    // Set drag data to make it work properly
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', '');
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
    e.stopPropagation();
    
    if (draggedIndex === null) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    // Use displayedQueue for the calculation since that's what we're displaying
    const currentQueue = displayedQueue;
    
    if (draggedIndex === dropIndex || draggedIndex < 0 || dropIndex < 0 || draggedIndex >= currentQueue.length || dropIndex >= currentQueue.length) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    // Create new order by reordering items
    const newOrder = [...currentQueue];
    const [draggedItem] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(dropIndex, 0, draggedItem);

    const articleIds = newOrder.map((article) => article.id);
    reorderMutation.mutate(articleIds);

    setDraggedIndex(null);
    setDragOverIndex(null);
  }, [draggedIndex, displayedQueue, reorderMutation]);

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
    setDragOverIndex(null);
    // Reset wasDragging after a small delay to allow click event to check it
    setTimeout(() => setWasDragging(false), 0);
  }, []);

  const handleRegenerateTitle = useCallback((e: React.MouseEvent, articleId: string) => {
    e.stopPropagation();
    regenerateTitleMutation.mutate(articleId);
  }, [regenerateTitleMutation]);

  const handleArticleClick = useCallback((article: QueuedArticle) => {
    // Don't trigger click if we were just dragging
    if (wasDragging) {
      return;
    }
    if (onArticleClick) {
      onArticleClick(article);
    }
  }, [onArticleClick, wasDragging]);

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
          {displayedQueue.map((article, index) => {
            const scheduledDate = scheduledDates[index] || null;
            const displayDate = article.scheduled_publish_at 
              ? new Date(article.scheduled_publish_at)
              : scheduledDate;
            
            return (
              <div
                key={article.id}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
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
                <div className="flex items-start gap-2">
                  <button
                    onClick={(e) => handleRegenerateTitle(e, article.id)}
                    onDragStart={(e) => e.stopPropagation()}
                    disabled={regenerateTitleMutation.isPending}
                    className="flex-shrink-0 p-1 text-gray-400 hover:text-purple-600 transition-colors disabled:opacity-50"
                    title="Regenerate title"
                    draggable={false}
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
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-gray-900 line-clamp-2">{article.title}</p>
                      {displayDate && (
                        <span className="text-xs text-gray-500 whitespace-nowrap">
                          {formatDate(displayDate)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div
                    className="flex-shrink-0 p-1 text-gray-400 cursor-grab active:cursor-grabbing"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                  </div>
                </div>
              </div>
            );
          })}
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

