import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queueApi, type QueuedArticle } from '../lib/api-client';
import { useAppBridgeToast } from '../hooks/useAppBridge';
import { formatAPIErrorMessage } from '../utils/error-messages';

interface ArticlesQueueProps {
  readonly storeId: string;
  readonly onArticleClick?: (article: QueuedArticle) => void;
  readonly showTitle?: boolean;
  readonly maxItems?: number;
  readonly selectedDays?: ReadonlySet<number>;
  readonly publishTime?: string;
}

const DEFAULT_PUBLISH_TIME = '14:00';
const REFETCH_INTERVAL_MS = 30000;
const AUTO_REFILL_DELAY_MS = 2000;
const DRAG_RESET_DELAY_MS = 0;
const MAX_DATE_CALCULATION_ATTEMPTS = 100;
const SUNDAY_INDEX = 6;
const MINUTES_PER_HOUR = 60;
const MILLISECONDS_PER_DAY = 86400000;

const QUERY_KEYS = {
  queue: (storeId: string) => ['queue', storeId] as const,
  queueMetrics: (storeId: string) => ['queue-metrics', storeId] as const,
} as const;

function dayIndexToJsDay(index: number): number {
  if (index < 0 || index > 6) {
    throw new Error(`Invalid day index: ${index}. Must be between 0 and 6.`);
  }
  return index === SUNDAY_INDEX ? 0 : index + 1;
}

function validatePublishTime(publishTime: string): void {
  const timePattern = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timePattern.test(publishTime)) {
    throw new Error(`Invalid publish time format: ${publishTime}. Expected format: HH:mm`);
  }
}

function parsePublishTime(publishTime: string): readonly [number, number] {
  validatePublishTime(publishTime);
  const parts = publishTime.split(':');
  const hours = Number.parseInt(parts[0] || '0', 10);
  const minutes = Number.parseInt(parts[1] || '0', 10);
  if (
    !Number.isInteger(hours) ||
    hours < 0 ||
    hours >= 24 ||
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes >= MINUTES_PER_HOUR
  ) {
    throw new Error(`Invalid publish time values: ${publishTime}`);
  }
  return [hours, minutes] as const;
}

function calculateNextPublishingDates(
  selectedDays: ReadonlySet<number>,
  publishTime: string,
  count: number,
): readonly Date[] {
  if (selectedDays.size === 0 || count <= 0) {
    return [];
  }

  const dates: Date[] = [];
  const now = new Date();
  const [hours, minutes] = parsePublishTime(publishTime);

  const jsDays = Array.from(selectedDays)
    .map((day) => dayIndexToJsDay(day))
    .sort((a, b) => a - b);

  let currentDate = new Date(now);
  currentDate.setHours(hours, minutes, 0, 0);

  if (currentDate <= now) {
    currentDate.setTime(currentDate.getTime() + MILLISECONDS_PER_DAY);
  }

  let attempts = 0;

  while (dates.length < count && attempts < MAX_DATE_CALCULATION_ATTEMPTS) {
    const currentDay = currentDate.getDay();

    if (jsDays.includes(currentDay)) {
      dates.push(new Date(currentDate));
    }

    currentDate.setTime(currentDate.getTime() + MILLISECONDS_PER_DAY);
    attempts++;
  }

  return dates.slice(0, count);
}

function formatDate(date: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setTime(tomorrow.getTime() + MILLISECONDS_PER_DAY);

  const dateOnly = new Date(date);
  dateOnly.setHours(0, 0, 0, 0);

  const todayTime = today.getTime();
  const tomorrowTime = tomorrow.getTime();
  const dateTime = dateOnly.getTime();

  if (dateTime === todayTime) {
    return 'Today';
  } else if (dateTime === tomorrowTime) {
    return 'Tomorrow';
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

function validateStoreId(storeId: string): void {
  if (!storeId || typeof storeId !== 'string' || storeId.trim().length === 0) {
    throw new Error('Invalid storeId: must be a non-empty string');
  }
}

export default function ArticlesQueue({
  storeId,
  onArticleClick,
  showTitle = true,
  maxItems,
  selectedDays,
  publishTime = DEFAULT_PUBLISH_TIME,
}: ArticlesQueueProps): JSX.Element {
  validateStoreId(storeId);

  const { showToast } = useAppBridgeToast();
  const queryClient = useQueryClient();
  const isMountedRef = useRef(true);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [wasDragging, setWasDragging] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const { data: queue = [], isLoading, error } = useQuery({
    queryKey: QUERY_KEYS.queue(storeId),
    queryFn: () => queueApi.getQueue(storeId),
    refetchInterval: REFETCH_INTERVAL_MS,
    enabled: !!storeId,
  });

  const { data: metrics } = useQuery({
    queryKey: QUERY_KEYS.queueMetrics(storeId),
    queryFn: () => queueApi.getMetrics(storeId),
    refetchInterval: REFETCH_INTERVAL_MS,
    enabled: !!storeId,
  });

  const displayedQueue = useMemo(() => {
    return maxItems && maxItems > 0 ? queue.slice(0, maxItems) : queue;
  }, [queue, maxItems]);

  const scheduledDates = useMemo(() => {
    if (!selectedDays || selectedDays.size === 0) {
      return [];
    }
    try {
      return calculateNextPublishingDates(selectedDays, publishTime, displayedQueue.length);
    } catch {
      return [];
    }
  }, [selectedDays, publishTime, displayedQueue.length]);

  const reorderMutation = useMutation({
    mutationFn: (articleIds: readonly string[]) => queueApi.reorder(storeId, [...articleIds]),
    onMutate: async (newArticleIds) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEYS.queue(storeId) });

      const previousQueue = queryClient.getQueryData<readonly QueuedArticle[]>(
        QUERY_KEYS.queue(storeId),
      );

      if (previousQueue && previousQueue.length > 0) {
        const articleMap = new Map(previousQueue.map((article) => [article.id, article]));
        const reorderedQueue = newArticleIds
          .map((id) => articleMap.get(id))
          .filter((article): article is QueuedArticle => article !== undefined);

        queryClient.setQueryData<readonly QueuedArticle[]>(
          QUERY_KEYS.queue(storeId),
          reorderedQueue,
        );
      }

      return { previousQueue };
    },
    onError: (error, _newArticleIds, context) => {
      if (isMountedRef.current) {
        if (context?.previousQueue) {
          queryClient.setQueryData(QUERY_KEYS.queue(storeId), context.previousQueue);
        }
        const errorMessage = formatAPIErrorMessage(error, {
          action: 'reorder queue',
          resource: 'queue',
        });
        showToast(errorMessage, { isError: true });
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.queue(storeId) });
    },
    onSuccess: () => {
      if (isMountedRef.current) {
        showToast('Queue order updated', { isError: false });
      }
    },
  });

  const regenerateTitleMutation = useMutation({
    mutationFn: (articleId: string) => queueApi.regenerateTitle(storeId, articleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.queue(storeId) });
      if (isMountedRef.current) {
        showToast('Title regenerated successfully', { isError: false });
      }
    },
    onError: (error) => {
      if (isMountedRef.current) {
        const errorMessage = formatAPIErrorMessage(error, {
          action: 'regenerate title',
          resource: 'article',
        });
        showToast(errorMessage, { isError: true });
      }
    },
  });

  const refillMutation = useMutation({
    mutationFn: () => queueApi.refill(storeId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.queue(storeId) });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.queueMetrics(storeId) });
      if (isMountedRef.current && data.created > 0) {
        showToast(
          `${data.created} article${data.created > 1 ? 's' : ''} added to queue`,
          { isError: false },
        );
      }
    },
    onError: () => {
    },
  });

  useEffect(() => {
    if (
      metrics &&
      metrics.targetCount > 0 &&
      metrics.needsRefill &&
      !refillMutation.isPending &&
      isMountedRef.current
    ) {
      const timer = setTimeout(() => {
        if (isMountedRef.current && queue.length < metrics.targetCount) {
          refillMutation.mutate();
        }
      }, AUTO_REFILL_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [
    metrics?.needsRefill,
    metrics?.targetCount,
    queue.length,
    refillMutation,
    metrics,
  ]);

  const handleDragStart = useCallback((e: React.DragEvent, index: number): void => {
    if (index < 0 || !Number.isInteger(index)) {
      return;
    }
    setDraggedIndex(index);
    setWasDragging(true);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', '');
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number): void => {
    e.preventDefault();
    if (index >= 0 && Number.isInteger(index)) {
      setDragOverIndex(index);
    }
  }, []);

  const handleDragLeave = useCallback((): void => {
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, dropIndex: number): void => {
      e.preventDefault();
      e.stopPropagation();

      if (draggedIndex === null || dropIndex < 0 || draggedIndex < 0) {
        setDraggedIndex(null);
        setDragOverIndex(null);
        return;
      }

      if (
        draggedIndex === dropIndex ||
        draggedIndex >= displayedQueue.length ||
        dropIndex >= displayedQueue.length
      ) {
        setDraggedIndex(null);
        setDragOverIndex(null);
        return;
      }

      const newOrder = [...displayedQueue];
      const [draggedItem] = newOrder.splice(draggedIndex, 1);
      newOrder.splice(dropIndex, 0, draggedItem);

      const articleIds = newOrder.map((article) => article.id);
      reorderMutation.mutate(articleIds);

      setDraggedIndex(null);
      setDragOverIndex(null);
    },
    [draggedIndex, displayedQueue, reorderMutation],
  );

  const handleDragEnd = useCallback((): void => {
    setDraggedIndex(null);
    setDragOverIndex(null);
    setTimeout(() => {
      if (isMountedRef.current) {
        setWasDragging(false);
      }
    }, DRAG_RESET_DELAY_MS);
  }, []);

  const handleRegenerateTitle = useCallback(
    (e: React.MouseEvent, articleId: string): void => {
      e.stopPropagation();
      e.preventDefault();
      if (articleId && typeof articleId === 'string') {
        regenerateTitleMutation.mutate(articleId);
      }
    },
    [regenerateTitleMutation],
  );

  const handleRegenerateMouseDown = useCallback((e: React.MouseEvent): void => {
    e.stopPropagation();
    e.preventDefault();
  }, []);

  const handleArticleClick = useCallback(
    (article: QueuedArticle): void => {
      if (wasDragging || !isMountedRef.current) {
        return;
      }
      if (onArticleClick) {
        onArticleClick(article);
      }
    },
    [onArticleClick, wasDragging],
  );

  const handleRefillClick = useCallback((): void => {
    if (isMountedRef.current && !refillMutation.isPending) {
      refillMutation.mutate();
    }
  }, [refillMutation]);

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

  const queueCount = queue.length;
  const targetCount = metrics?.targetCount ?? 0;

  return (
    <div className="space-y-3">
      {showTitle && (
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">
            Upcoming Articles ({queueCount}
            {metrics ? `/${targetCount}` : ''})
          </h3>
          {metrics?.needsRefill && (
            <button
              onClick={handleRefillClick}
              disabled={refillMutation.isPending}
              type="button"
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
            const scheduledDate = scheduledDates[index] ?? null;
            const displayDate = article.scheduled_publish_at
              ? new Date(article.scheduled_publish_at)
              : scheduledDate;

            const isDragged = draggedIndex === index;
            const isDragOver = dragOverIndex === index;

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
                  p-3 bg-white border-2 rounded-lg transition-all
                  ${
                    isDragged
                      ? 'opacity-50 border-purple-500 cursor-grabbing'
                      : 'border-gray-200 hover:border-purple-300 cursor-grab'
                  }
                  ${isDragOver ? 'border-purple-500 bg-purple-50' : ''}
                  ${onArticleClick && draggedIndex === null ? 'cursor-pointer' : ''}
                `}
              >
                <div className="flex items-start gap-2">
                  <button
                    onClick={(e) => handleRegenerateTitle(e, article.id)}
                    onMouseDown={handleRegenerateMouseDown}
                    onDragStart={(e) => e.stopPropagation()}
                    disabled={regenerateTitleMutation.isPending}
                    type="button"
                    className="flex-shrink-0 p-1 text-gray-400 hover:text-purple-600 transition-colors disabled:opacity-50"
                    title="Regenerate title"
                    draggable={false}
                    aria-label="Regenerate title"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
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
                      <p className="text-sm font-medium text-gray-900 line-clamp-2">
                        {article.title}
                      </p>
                      {displayDate && (
                        <span className="text-xs text-gray-500 whitespace-nowrap">
                          {formatDate(displayDate)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div
                    className="flex-shrink-0 p-1 text-gray-400 cursor-grab active:cursor-grabbing"
                    aria-label="Drag handle"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M4 6h16M4 12h16M4 18h16"
                      />
                    </svg>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {metrics && queueCount < targetCount && (
        <button
          onClick={handleRefillClick}
          disabled={refillMutation.isPending}
          type="button"
          className="w-full py-2 px-3 text-xs font-medium text-purple-600 border border-purple-300 rounded-lg hover:bg-purple-50 transition-colors disabled:opacity-50"
        >
          {refillMutation.isPending
            ? 'Adding articles...'
            : `Add ${targetCount - queueCount} more article${targetCount - queueCount > 1 ? 's' : ''}`}
        </button>
      )}
    </div>
  );
}
