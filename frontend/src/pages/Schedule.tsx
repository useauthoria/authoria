import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { useStore, usePosts, useQuotaStatus, queryKeys } from '../lib/api-cache';
import { getShopDomain } from '../lib/app-bridge';
import { supabase, postsApi, queueApi, type BlogPost, type QueuedArticle, type Store, type QuotaStatus } from '../lib/api-client';
import { getPlanFrequencyConfig, validateSelectedDays, getFrequencySettings } from '../utils/plan-frequency';
import { useAppBridgeToast } from '../hooks/useAppBridge';
import ArticlesQueue from '../components/ArticlesQueue';
import { formatAPIErrorMessage } from '../utils/error-messages';
import { HelpIcon } from '../components/Tooltip';

const REFETCH_INTERVAL = 300000;
const QUEUE_REFETCH_INTERVAL = 30000;
const MAX_ATTEMPTS = 200;
const DEFAULT_PUBLISH_TIME = '14:00';
const CALENDAR_ROWS = 6;
const DAYS_IN_WEEK = 7;
const CALENDAR_CELLS = CALENDAR_ROWS * DAYS_IN_WEEK;
const MONTHS_IN_YEAR = 12;
const MAX_TITLE_PREVIEW_LENGTH = 20;
const JS_DAYS_IN_WEEK = 7;
const HOURS_IN_DAY = 24;
const MINUTES_IN_HOUR = 60;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

type ViewMode = 'month' | 'week' | 'list';

interface CalendarDay {
  readonly date: Date;
  readonly dayOfMonth: number;
  readonly isCurrentMonth: boolean;
  readonly isToday: boolean;
  readonly posts: readonly PostForDate[];
}

interface WeekDay {
  readonly date: Date;
  readonly dayName: string;
  readonly dayNumber: number;
  readonly posts: readonly PostForDate[];
}

interface PostForDate {
  readonly id: string;
  readonly title: string;
  readonly scheduledAt: Date;
  readonly status: 'published' | 'scheduled' | 'queued';
}

interface BlogPostWithQueueMarker extends BlogPost {
  readonly _isQueueItem?: boolean;
}

interface ConflictInfo {
  readonly type: string;
  readonly severity: string;
  readonly message: string;
}

interface ConflictResponse {
  readonly conflicts: readonly Array<{
    readonly conflictType: string;
    readonly severity: string;
    readonly scheduledAt: string;
    readonly suggestedAlternative?: string;
  }>;
}

interface StoreWithInstallDate extends Store {
  readonly installed_at?: string;
  readonly created_at?: string;
}

const formatDate = (date: Date): string => {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const uses12HourFormat = (): boolean => {
  if (typeof navigator === 'undefined' || !navigator.language) {
    return true;
  }
  const testDate = new Date(2024, 0, 1, 13, 0);
  const formatted = testDate.toLocaleTimeString(navigator.language, { hour: 'numeric' });
  return formatted.includes('PM') || formatted.includes('AM') || formatted.includes('pm') || formatted.includes('am');
};

const formatTime = (date: Date): string => {
  if (typeof navigator === 'undefined' || !navigator.language) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  const use12Hour = uses12HourFormat();
  return date.toLocaleTimeString(navigator.language, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: use12Hour,
  });
};

const formatWeekDate = (date: Date): string => {
  return `${DAY_NAMES[date.getDay()]}, ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
};

const getDaysInMonth = (year: number, month: number): number => {
  return new Date(year, month + 1, 0).getDate();
};

const getFirstDayOfMonth = (year: number, month: number): number => {
  const firstDay = new Date(year, month, 1);
  return firstDay.getDay();
};

const jsDayToIndex = (jsDay: number): number => {
  return jsDay === 0 ? 6 : jsDay - 1;
};

const dayIndexToJsDay = (index: number): number => {
  return index === 6 ? 0 : index + 1;
};

const validateJsDay = (jsDay: number): boolean => {
  return Number.isInteger(jsDay) && jsDay >= 0 && jsDay < JS_DAYS_IN_WEEK;
};

const validateDayIndex = (index: number): boolean => {
  return Number.isInteger(index) && index >= 0 && index < JS_DAYS_IN_WEEK;
};

const parseTime = (time: string): { hours: number; minutes: number } | null => {
  if (!time || typeof time !== 'string') {
    return null;
  }
  const parts = time.split(':');
  if (parts.length !== 2) {
    return null;
  }
  const hours = Number.parseInt(parts[0], 10);
  const minutes = Number.parseInt(parts[1], 10);
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    hours < 0 ||
    hours >= HOURS_IN_DAY ||
    minutes < 0 ||
    minutes >= MINUTES_IN_HOUR
  ) {
    return null;
  }
  return { hours, minutes };
};

const formatTimeString = (hours: number, minutes: number): string => {
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
};

const isBlogPostWithQueueMarker = (post: BlogPost | BlogPostWithQueueMarker): post is BlogPostWithQueueMarker => {
  return post !== null && typeof post === 'object' && '_isQueueItem' in post;
};

const getPostsForDate = (date: Date, posts: readonly (BlogPost | BlogPostWithQueueMarker)[]): readonly PostForDate[] => {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  return posts
    .filter((post) => {
      const postDate = post.published_at || post.scheduled_publish_at;
      if (!postDate) {
        return false;
      }
      const d = new Date(postDate);
      if (isNaN(d.getTime())) {
        return false;
      }
      return d >= startOfDay && d <= endOfDay;
    })
    .map((post) => {
      if (post.status === 'published' && post.published_at) {
        return {
          id: post.id,
          title: post.title,
          scheduledAt: new Date(post.published_at),
          status: 'published' as const,
        };
      } else if (isBlogPostWithQueueMarker(post) && post._isQueueItem && post.scheduled_publish_at) {
        return {
          id: post.id,
          title: post.title,
          scheduledAt: new Date(post.scheduled_publish_at),
          status: 'queued' as const,
        };
      } else if (post.scheduled_publish_at) {
        return {
          id: post.id,
          title: post.title,
          scheduledAt: new Date(post.scheduled_publish_at),
          status: 'scheduled' as const,
        };
      } else {
        throw new Error('Post must have a valid date');
      }
    })
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
};

const generateMonthCalendar = (
  year: number,
  month: number,
  posts: readonly (BlogPost | BlogPostWithQueueMarker)[],
  minDate: Date | null = null,
  maxDate: Date | null = null,
): readonly CalendarDay[] => {
  const days: CalendarDay[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const firstDay = getFirstDayOfMonth(year, month);
  const daysInMonth = getDaysInMonth(year, month);
  const daysInPrevMonth = getDaysInMonth(year, month - 1);

  for (let i = firstDay - 1; i >= 0; i--) {
    const date = new Date(year, month - 1, daysInPrevMonth - i);
    date.setHours(0, 0, 0, 0);

    if (minDate && date < minDate) {
      continue;
    }

    const dayPosts = getPostsForDate(date, posts);
    days.push({
      date,
      dayOfMonth: daysInPrevMonth - i,
      isCurrentMonth: false,
      isToday: date.getTime() === today.getTime(),
      posts: dayPosts,
    });
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    date.setHours(0, 0, 0, 0);
    const dayPosts = getPostsForDate(date, posts);
    days.push({
      date,
      dayOfMonth: day,
      isCurrentMonth: true,
      isToday: date.getTime() === today.getTime(),
      posts: dayPosts,
    });
  }

  const totalCells = days.length;
  const remainingCells = CALENDAR_CELLS - totalCells;
  for (let day = 1; day <= remainingCells; day++) {
    const date = new Date(year, month + 1, day);
    date.setHours(0, 0, 0, 0);

    if (maxDate && date > maxDate) {
      continue;
    }

    const dayPosts = getPostsForDate(date, posts);
    days.push({
      date,
      dayOfMonth: day,
      isCurrentMonth: false,
      isToday: date.getTime() === today.getTime(),
      posts: dayPosts,
    });
  }

  return days;
};

const generateWeekCalendar = (startDate: Date, posts: readonly (BlogPost | BlogPostWithQueueMarker)[]): readonly WeekDay[] => {
  const week: WeekDay[] = [];

  for (let i = 0; i < DAYS_IN_WEEK; i++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);
    date.setHours(0, 0, 0, 0);

    const dayPosts = getPostsForDate(date, posts);
    week.push({
      date,
      dayName: DAY_NAMES[date.getDay()],
      dayNumber: date.getDate(),
      posts: dayPosts,
    });
  }

  return week;
};

const getWeekStart = (date: Date): Date => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
};

const isQuotaStatus = (quota: unknown): quota is QuotaStatus => {
  return (
    quota !== null &&
    typeof quota === 'object' &&
    'plan_name' in quota &&
    typeof (quota as QuotaStatus).plan_name === 'string' &&
    'articles_used' in quota &&
    typeof (quota as QuotaStatus).articles_used === 'number'
  );
};

const isQuotaWithError = (quota: unknown): quota is { error: unknown } => {
  return quota !== null && typeof quota === 'object' && 'error' in quota;
};

const isStoreWithInstallDate = (store: Store | null): store is StoreWithInstallDate => {
  return store !== null && typeof store === 'object';
};

const isStoreWithFrequencySettings = (store: Store | null): store is Store & { frequency_settings: Store['frequency_settings'] } => {
  return store !== null && typeof store === 'object' && 'frequency_settings' in store;
};

const extractInstallDate = (store: Store | null): Date | null => {
  if (!isStoreWithInstallDate(store)) {
    return null;
  }
  const installDateStr = store.installed_at || store.created_at;
  if (!installDateStr || typeof installDateStr !== 'string') {
    return null;
  }
  const date = new Date(installDateStr);
  if (isNaN(date.getTime())) {
    return null;
  }
  return date;
};

const extractFrequencySettings = (store: Store | null): { selectedDays: Set<number>; publishTime: string } => {
  if (!isStoreWithFrequencySettings(store)) {
    return { selectedDays: new Set<number>(), publishTime: DEFAULT_PUBLISH_TIME };
  }

  const settings = store.frequency_settings;
  const selectedDays = new Set<number>();

  if (settings?.preferredDays && Array.isArray(settings.preferredDays)) {
    for (const jsDay of settings.preferredDays) {
      if (validateJsDay(jsDay)) {
        const index = jsDayToIndex(jsDay);
        if (validateDayIndex(index)) {
          selectedDays.add(index);
        }
      }
    }
  }

  const publishTime = settings?.preferredTimes?.[0] || DEFAULT_PUBLISH_TIME;
  const parsed = parseTime(publishTime);
  if (parsed) {
    return { selectedDays, publishTime: formatTimeString(parsed.hours, parsed.minutes) };
  }

  return { selectedDays, publishTime: DEFAULT_PUBLISH_TIME };
};

const calculateScheduledDates = (
  queueLength: number,
  selectedDays: Set<number>,
  publishTime: string,
  existingDates: Set<string>,
): Date[] => {
  if (selectedDays.size === 0 || queueLength === 0) {
    return [];
  }

  const parsed = parseTime(publishTime);
  if (!parsed) {
    return [];
  }

  const dates: Date[] = [];
  const now = new Date();
  const jsDays = Array.from(selectedDays)
    .map(dayIndexToJsDay)
    .filter(validateJsDay)
    .sort((a, b) => a - b);

  let currentDate = new Date(now);
  currentDate.setHours(parsed.hours, parsed.minutes, 0, 0);

  if (currentDate <= now) {
    currentDate.setDate(currentDate.getDate() + 1);
  }

  let attempts = 0;

  while (dates.length < queueLength && attempts < MAX_ATTEMPTS) {
    const currentDay = currentDate.getDay();
    if (jsDays.includes(currentDay)) {
      const dateStr = currentDate.toISOString();
      if (!existingDates.has(dateStr)) {
        dates.push(new Date(currentDate));
      }
    }
    currentDate.setDate(currentDate.getDate() + 1);
    attempts++;
  }

  return dates;
};

const buildQueuePostsAsBlogPosts = (
  queue: readonly QueuedArticle[],
  dates: Date[],
): readonly BlogPostWithQueueMarker[] => {
  return queue.slice(0, dates.length).map(
    (article, index): BlogPostWithQueueMarker => ({
      id: article.id,
      store_id: article.store_id,
      title: article.title,
      content: article.content || '',
      status: 'queued' as const,
      published_at: null,
      scheduled_publish_at: dates[index].toISOString(),
      seo_health_score: 0,
      created_at: article.created_at,
      _isQueueItem: true,
    }),
  );
};

const buildConflictMap = (conflicts: readonly ConflictResponse['conflicts'], dateKey: string): Map<string, readonly ConflictInfo[]> => {
  if (conflicts.length === 0) {
    return new Map();
  }

  const conflictMap = new Map<string, ConflictInfo[]>();
  conflictMap.set(
    dateKey,
    conflicts.map((c) => ({
      type: c.conflictType,
      severity: c.severity,
      message:
        c.severity === 'high'
          ? 'High priority conflict detected. Consider rescheduling.'
          : c.severity === 'medium'
            ? 'Potential conflict. Review before scheduling.'
            : 'Minor conflict detected.',
    })),
  );

  return conflictMap;
};

const getConflictMessage = (severity: string): string => {
  switch (severity) {
    case 'high':
      return 'High priority conflict detected. Consider rescheduling.';
    case 'medium':
      return 'Potential conflict. Review before scheduling.';
    default:
      return 'Minor conflict detected.';
  }
};

const truncateTitle = (title: string, maxLength: number): string => {
  if (title.length <= maxLength) {
    return title;
  }
  return `${title.substring(0, maxLength)}...`;
};

export default function Schedule(): JSX.Element {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth());
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const [selectedDays, setSelectedDays] = useState<Set<number>>(new Set([0, 2, 4]));
  const [publishTime, setPublishTime] = useState(DEFAULT_PUBLISH_TIME);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [selectedPostForSchedule, setSelectedPostForSchedule] = useState<BlogPost | null>(null);
  const [modalPublishTime, setModalPublishTime] = useState(DEFAULT_PUBLISH_TIME);
  const [conflicts, setConflicts] = useState<Map<string, readonly ConflictInfo[]>>(new Map());
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [dayValidationError, setDayValidationError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const queryClient = useQueryClient();
  const { showToast } = useAppBridgeToast();

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const schedulePostMutation = useMutation({
    mutationFn: ({ postId, scheduledAt }: { postId: string; scheduledAt: string }) => postsApi.schedule(postId, scheduledAt),
    onSuccess: () => {
      if (!isMountedRef.current) {
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      if (shopDomain) {
        queryClient.invalidateQueries({ queryKey: queryKeys.store(shopDomain) });
      }
      setShowScheduleModal(false);
      setSelectedPostForSchedule(null);
      setSelectedDate(null);
      setModalPublishTime(publishTime);
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

  const handleError = useCallback(
    (error: unknown) => {
      if (!isMountedRef.current) {
        return;
      }
      const errorMessage = formatAPIErrorMessage(error, { action: 'load schedule', resource: 'schedule' });
    },
    [],
  );

  const shopDomain = useMemo(() => getShopDomain(), []);

  const {
    data: store,
    isLoading: storeLoading,
    error: storeError,
    refetch: refetchStore,
  } = useStore(shopDomain ?? '');

  const storeId = useMemo(() => store?.id ?? '', [store?.id]);

  const installDate = useMemo(() => extractInstallDate(store), [store]);

  const minDate = useMemo(() => {
    if (!installDate) {
      return null;
    }
    const min = new Date(installDate);
    min.setDate(1);
    min.setHours(0, 0, 0, 0);
    return min;
  }, [installDate]);

  const maxDate = useMemo(() => {
    const now = new Date();
    const max = new Date(now.getFullYear(), now.getMonth() + MONTHS_IN_YEAR, 0);
    max.setHours(23, 59, 59, 999);
    return max;
  }, []);

  const {
    data: quota,
    isLoading: quotaLoading,
  } = useQuotaStatus(storeId);

  const planName = useMemo(() => {
    if (!isQuotaStatus(quota)) {
      return null;
    }
    return quota.plan_name || null;
  }, [quota]);

  const planFrequencyConfig = useMemo(() => getPlanFrequencyConfig(planName), [planName]);

  const {
    data: allPosts = [],
    isLoading: postsLoading,
    error: postsError,
    refetch: refetchPosts,
  } = usePosts(storeId);

  const {
    data: queue = [],
    isLoading: queueLoading,
  } = useQuery({
    queryKey: ['queue', storeId] as const,
    queryFn: () => queueApi.getQueue(storeId),
    enabled: !!storeId,
    refetchInterval: QUEUE_REFETCH_INTERVAL,
  });

  const scheduledPosts = useMemo(() => {
    return allPosts.filter((p) => p.status === 'scheduled' && p.scheduled_publish_at);
  }, [allPosts]);

  const publishedPosts = useMemo(() => {
    return allPosts.filter((p) => p.status === 'published' && p.published_at);
  }, [allPosts]);

  const existingDates = useMemo(() => {
    return new Set(
      [...scheduledPosts, ...publishedPosts]
        .map((p) => {
          const date = p.published_at || p.scheduled_publish_at;
          if (!date) {
            return null;
          }
          const d = new Date(date);
          if (isNaN(d.getTime())) {
            return null;
          }
          return d.toISOString();
        })
        .filter((d): d is string => d !== null),
    );
  }, [scheduledPosts, publishedPosts]);

  const scheduledDates = useMemo(() => {
    return calculateScheduledDates(queue.length, selectedDays, publishTime, existingDates);
  }, [queue.length, selectedDays, publishTime, existingDates]);

  const queuePostsAsBlogPosts = useMemo(() => {
    return buildQueuePostsAsBlogPosts(queue, scheduledDates);
  }, [queue, scheduledDates]);

  const allRelevantPosts = useMemo(() => {
    return [...scheduledPosts, ...publishedPosts, ...queuePostsAsBlogPosts];
  }, [scheduledPosts, publishedPosts, queuePostsAsBlogPosts]);

  const isLoading = storeLoading || postsLoading || quotaLoading || queueLoading;
  const isError = !!storeError || !!postsError;
  const error = storeError || postsError;

  const monthCalendar = useMemo(() => {
    return generateMonthCalendar(currentYear, currentMonth, allRelevantPosts, minDate, maxDate);
  }, [currentYear, currentMonth, allRelevantPosts, minDate, maxDate]);

  const weekCalendar = useMemo(() => {
    return generateWeekCalendar(weekStart, allRelevantPosts);
  }, [weekStart, allRelevantPosts]);

  const listPosts = useMemo(() => {
    return allRelevantPosts
      .filter((p) => {
        const postDate = p.published_at || p.scheduled_publish_at;
        return !!postDate;
      })
      .sort((a, b) => {
        const dateA = new Date(a.published_at || a.scheduled_publish_at!);
        const dateB = new Date(b.published_at || b.scheduled_publish_at!);
        return dateB.getTime() - dateA.getTime();
      });
  }, [allRelevantPosts]);

  useEffect(() => {
    if (!minDate) {
      return;
    }
    const currentDate = new Date(currentYear, currentMonth, 1);
    if (currentDate < minDate) {
      setCurrentYear(minDate.getFullYear());
      setCurrentMonth(minDate.getMonth());
      setWeekStart(getWeekStart(minDate));
    }
  }, [minDate, currentYear, currentMonth]);

  useEffect(() => {
    if (!store) {
      return;
    }

    const { selectedDays: extractedDays, publishTime: extractedTime } = extractFrequencySettings(store);

    if (extractedDays.size > 0) {
      const validation = validateSelectedDays(extractedDays, planName);
      if (validation.valid) {
        setSelectedDays(extractedDays);
        setDayValidationError(null);
      } else {
        const defaultDays = new Set<number>();
        for (let i = 0; i < Math.min(planFrequencyConfig.maxDays, JS_DAYS_IN_WEEK); i++) {
          defaultDays.add(i);
        }
        setSelectedDays(defaultDays);
        setDayValidationError(validation.error || null);
      }
    }

    if (extractedTime !== DEFAULT_PUBLISH_TIME) {
      setPublishTime(extractedTime);
    }
  }, [store, planName, planFrequencyConfig]);

  useEffect(() => {
    if (!selectedDate || !storeId || !selectedPostForSchedule) {
      return;
    }

    let cancelled = false;

    const checkConflicts = async () => {
      if (!isMountedRef.current || cancelled) {
        return;
      }

      setCheckingConflicts(true);
      try {
        const parsed = parseTime(modalPublishTime);
        if (!parsed) {
          if (isMountedRef.current && !cancelled) {
            setCheckingConflicts(false);
          }
          return;
        }

        const scheduledDateTime = new Date(selectedDate);
        scheduledDateTime.setHours(parsed.hours, parsed.minutes, 0, 0);

        try {
          const data = await postsApi.checkScheduleConflicts(storeId, selectedPostForSchedule.id, scheduledDateTime.toISOString());

          if (!isMountedRef.current || cancelled) {
            return;
          }

          if (data.conflicts && data.conflicts.length > 0) {
            const dateKey = selectedDate.toISOString().split('T')[0];
            const conflictMap = buildConflictMap(data.conflicts, dateKey);
            setConflicts(conflictMap);
          } else {
            setConflicts(new Map());
          }
        } catch (error) {
          if (!isMountedRef.current || cancelled) {
            return;
          }
          const errorMessage = formatAPIErrorMessage(error, { action: 'check conflicts', resource: 'schedule' });
          showToast(errorMessage, { isError: true });
          setConflicts(new Map());
        }
      } catch (error) {
        if (!isMountedRef.current || cancelled) {
          return;
        }
        const errorMessage = formatAPIErrorMessage(error, { action: 'check conflicts', resource: 'schedule' });
        showToast(errorMessage, { isError: true });
      } finally {
        if (isMountedRef.current && !cancelled) {
          setCheckingConflicts(false);
        }
      }
    };

    checkConflicts();

    return () => {
      cancelled = true;
    };
  }, [selectedDate, modalPublishTime, storeId, selectedPostForSchedule, showToast]);

  const handlePreviousMonth = useCallback(() => {
    setCurrentMonth((prev) => {
      if (prev === 0) {
        const newYear = currentYear - 1;
        const newMonth = 11;
        if (minDate) {
          const newDate = new Date(newYear, newMonth, 1);
          if (newDate < minDate) {
            return prev;
          }
        }
        setCurrentYear(newYear);
        return newMonth;
      }
      return prev - 1;
    });
  }, [currentYear, minDate]);

  const handleNextMonth = useCallback(() => {
    setCurrentMonth((prev) => {
      if (prev === 11) {
        const newYear = currentYear + 1;
        const newMonth = 0;
        if (maxDate) {
          const newDate = new Date(newYear, newMonth, 1);
          if (newDate > maxDate) {
            return prev;
          }
        }
        setCurrentYear(newYear);
        return newMonth;
      }
      return prev + 1;
    });
  }, [currentYear, maxDate]);

  const handleToday = useCallback(() => {
    const now = new Date();
    setCurrentMonth(now.getMonth());
    setCurrentYear(now.getFullYear());
    setWeekStart(getWeekStart(now));
  }, []);

  const handlePreviousWeek = useCallback(() => {
    setWeekStart((prev) => {
      const newDate = new Date(prev);
      newDate.setDate(newDate.getDate() - DAYS_IN_WEEK);
      if (minDate && newDate < minDate) {
        return prev;
      }
      return newDate;
    });
  }, [minDate]);

  const handleNextWeek = useCallback(() => {
    setWeekStart((prev) => {
      const newDate = new Date(prev);
      newDate.setDate(newDate.getDate() + DAYS_IN_WEEK);
      if (minDate && newDate < minDate) {
        return prev;
      }
      if (maxDate) {
        const weekEnd = new Date(newDate);
        weekEnd.setDate(weekEnd.getDate() + 6);
        if (weekEnd > maxDate) {
          return prev;
        }
      }
      return newDate;
    });
  }, [maxDate, minDate]);

  const handleDayToggle = useCallback(
    (dayIndex: number) => {
      if (!validateDayIndex(dayIndex)) {
        return;
      }

      setSelectedDays((prev) => {
        const next = new Set(prev);
        if (next.has(dayIndex)) {
          next.delete(dayIndex);
        } else {
          if (next.size >= planFrequencyConfig.maxDays) {
            setDayValidationError(
              `You can only select up to ${planFrequencyConfig.maxDays} day${planFrequencyConfig.maxDays > 1 ? 's' : ''} for your plan (${planFrequencyConfig.displayName})`,
            );
            return prev;
          }
          next.add(dayIndex);
        }

        const validation = validateSelectedDays(next, planName);
        if (validation.valid) {
          setDayValidationError(null);
        } else {
          setDayValidationError(validation.error || null);
        }

        return next;
      });
    },
    [planName, planFrequencyConfig],
  );

  const handleSaveSettings = useCallback(async () => {
    if (!storeId) {
      return;
    }

    const validation = validateSelectedDays(selectedDays, planName);
    if (!validation.valid) {
      setDayValidationError(validation.error || 'Invalid day selection');
      return;
    }

    if (!isMountedRef.current) {
      return;
    }

    setIsSaving(true);
    setDayValidationError(null);

    try {
      const parsed = parseTime(publishTime);
      if (!parsed) {
        throw new Error('Invalid time format');
      }

      const timeString = formatTimeString(parsed.hours, parsed.minutes);
      const frequencySettings = getFrequencySettings(planName, selectedDays, [timeString]);

      const { error: updateError } = await supabase.from('stores').update({ frequency_settings: frequencySettings }).eq('id', storeId);

      if (updateError) {
        throw new Error(updateError.message);
      }

      if (!isMountedRef.current) {
        return;
      }

      queryClient.invalidateQueries({ queryKey: queryKeys.store(shopDomain ?? '') });
      await refetchStore();

      showToast('Schedule settings saved successfully', { isError: false });
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }
      const errorMessage = formatAPIErrorMessage(error, { action: 'save schedule settings', resource: 'schedule' });
      showToast(errorMessage, { isError: true });
    } finally {
      if (isMountedRef.current) {
        setIsSaving(false);
      }
    }
  }, [storeId, planName, selectedDays, publishTime, refetchStore, shopDomain, queryClient, showToast]);

  const handlePostClick = useCallback(() => {
    navigate('/posts');
  }, [navigate]);

  const handleDayClick = useCallback(
    (date: Date) => {
      setSelectedDate(date);
      setModalPublishTime(publishTime);
      const draftPosts = allPosts.filter((p) => p.status === 'draft');
      if (draftPosts.length > 0) {
        setSelectedPostForSchedule(draftPosts[0]);
        setShowScheduleModal(true);
      } else {
        showToast('No articles are available to schedule right now. Articles are automatically generated based on your publishing schedule.', {
          isError: false,
        });
      }
    },
    [allPosts, showToast, publishTime],
  );

  const handleSchedulePost = useCallback(async () => {
    if (!selectedPostForSchedule || !selectedDate) {
      return;
    }

    const parsed = parseTime(modalPublishTime);
    if (!parsed) {
      showToast('Invalid time format', { isError: true });
      return;
    }

    const scheduledDateTime = new Date(selectedDate);
    scheduledDateTime.setHours(parsed.hours, parsed.minutes, 0, 0);

    const dateKey = selectedDate.toISOString().split('T')[0];
    const dayConflicts = conflicts.get(dateKey);
    const hasHighConflict = dayConflicts?.some((c) => c.severity === 'high');

    if (hasHighConflict) {
      const proceed = window.confirm('High priority conflict detected for this time slot. Do you want to schedule anyway?');
      if (!proceed) {
        return;
      }
    }

    schedulePostMutation.mutate({
      postId: selectedPostForSchedule.id,
      scheduledAt: scheduledDateTime.toISOString(),
    });
  }, [selectedPostForSchedule, selectedDate, modalPublishTime, schedulePostMutation, conflicts, showToast]);

  const handleCloseScheduleModal = useCallback(() => {
    setShowScheduleModal(false);
    setSelectedPostForSchedule(null);
    setSelectedDate(null);
    setModalPublishTime(publishTime);
  }, [publishTime]);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
  }, []);

  const handleReload = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, []);

  const handleRetry = useCallback(() => {
    refetchStore();
    refetchPosts();
  }, [refetchStore, refetchPosts]);

  const monthName = useMemo(() => {
    return new Date(currentYear, currentMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }, [currentYear, currentMonth]);

  const weekRange = useMemo(() => {
    return `Week of ${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }, [weekStart]);

  if (isLoading) {
    return (
      <div className="h-screen overflow-hidden bg-gray-50">
        <main className="h-full overflow-y-auto bg-gray-50">
          <header className="bg-white border-b border-gray-200 px-4 sm:px-6 lg:px-8 py-4 sm:py-5 lg:py-6">
            <div className="animate-pulse">
              <div className="h-8 w-64 bg-gray-200 rounded mb-2"></div>
              <div className="h-4 w-96 bg-gray-200 rounded"></div>
            </div>
          </header>
          <div className="p-3 sm:p-4 md:p-5 lg:p-6 xl:p-8">
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 sm:gap-4 md:gap-5 lg:gap-6">
              <div className="lg:col-span-3 bg-white rounded-xl border border-gray-200 shadow-sm animate-pulse p-6">
                <div className="h-6 w-32 bg-gray-200 rounded mb-4"></div>
                <div className="h-64 bg-gray-100 rounded"></div>
              </div>
              <div className="lg:col-span-2 space-y-4">
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm animate-pulse p-6">
                  <div className="h-6 w-32 bg-gray-200 rounded mb-4"></div>
                  <div className="space-y-3">
                    <div className="h-10 bg-gray-100 rounded"></div>
                    <div className="h-32 bg-gray-100 rounded"></div>
                    <div className="h-10 bg-gray-100 rounded"></div>
                  </div>
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
              <p className="text-sm text-red-700 mb-4">{formatAPIErrorMessage(error, { action: 'load schedule', resource: 'schedule' })}</p>
              <div className="flex gap-3">
                <button
                  onClick={handleReload}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
                  type="button"
                >
                  Refresh Page
                </button>
                <button
                  onClick={handleRetry}
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

  return (
    <div className="h-screen overflow-hidden bg-gray-50">
      <main className="h-full overflow-y-auto bg-gray-50">
        <header className="bg-white border-b border-gray-200 px-4 sm:px-6 lg:px-8 py-4 sm:py-5 lg:py-6">
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
              <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-gray-900">Publishing Schedule</h1>
              <p className="text-xs sm:text-sm text-gray-500 mt-1">Configure your automatic publishing settings</p>
            </div>
          </div>
        </header>

        <div className="p-3 sm:p-4 md:p-5 lg:p-6 xl:p-8">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 sm:gap-4 md:gap-5 lg:gap-6">
            <div className="lg:col-span-3 bg-white rounded-xl border border-gray-200 shadow-sm min-w-0">
              <div className="p-3 sm:p-4 md:p-5 lg:p-6 border-b border-gray-200">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 md:gap-4">
                  <h2 className="text-sm sm:text-base md:text-lg font-semibold text-gray-900">Calendar View</h2>
                  <div className="flex items-center gap-1.5 sm:gap-2">
                    <button
                      onClick={() => handleViewModeChange('month')}
                      className={`px-2.5 sm:px-3 py-1 sm:py-1.5 text-[11px] sm:text-xs md:text-sm font-medium rounded-lg touch-manipulation transition-colors ${
                        viewMode === 'month' ? 'bg-purple-600 text-white' : 'text-gray-600 hover:bg-gray-100'
                      }`}
                      type="button"
                    >
                      Month
                    </button>
                    <button
                      onClick={() => handleViewModeChange('week')}
                      className={`px-2.5 sm:px-3 py-1 sm:py-1.5 text-[11px] sm:text-xs md:text-sm font-medium rounded-lg touch-manipulation transition-colors ${
                        viewMode === 'week' ? 'bg-purple-600 text-white' : 'text-gray-600 hover:bg-gray-100'
                      }`}
                      type="button"
                    >
                      Week
                    </button>
                    <button
                      onClick={() => handleViewModeChange('list')}
                      className={`px-2.5 sm:px-3 py-1 sm:py-1.5 text-[11px] sm:text-xs md:text-sm font-medium rounded-lg touch-manipulation transition-colors ${
                        viewMode === 'list' ? 'bg-purple-600 text-white' : 'text-gray-600 hover:bg-gray-100'
                      }`}
                      type="button"
                    >
                      List
                    </button>
                  </div>
                </div>
              </div>
              <div className="p-3 sm:p-4 md:p-5 lg:p-6 overflow-x-auto">
                {viewMode === 'month' && (
                  <div>
                    <div className="mb-3 sm:mb-4 flex items-center justify-between gap-2">
                      <button
                        onClick={handlePreviousMonth}
                        disabled={minDate ? new Date(currentYear, currentMonth, 1) <= minDate : false}
                        className="p-1.5 sm:p-2 hover:bg-gray-100 rounded-lg touch-manipulation transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="Previous month"
                        type="button"
                      >
                        <svg className="w-4 h-4 sm:w-5 sm:h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
                        </svg>
                      </button>
                      <div className="flex items-center gap-2 sm:gap-3 flex-1 justify-center min-w-0">
                        <h3 className="text-sm sm:text-base md:text-lg font-semibold text-gray-900 truncate">{monthName}</h3>
                        <button
                          onClick={handleToday}
                          className="px-2 sm:px-3 py-1 text-[10px] sm:text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg touch-manipulation transition-colors whitespace-nowrap flex-shrink-0"
                          type="button"
                        >
                          Today
                        </button>
                      </div>
                      <button
                        onClick={handleNextMonth}
                        disabled={maxDate ? new Date(currentYear, currentMonth + 1, 1) > maxDate : false}
                        className="p-1.5 sm:p-2 hover:bg-gray-100 rounded-lg touch-manipulation transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="Next month"
                        type="button"
                      >
                        <svg className="w-4 h-4 sm:w-5 sm:h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>

                    <div className="mb-3 sm:mb-4 flex flex-wrap items-center gap-2 sm:gap-3 md:gap-4 text-[10px] sm:text-xs">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded bg-green-500 border-2 border-green-600"></div>
                        <span className="text-gray-600">Published</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded bg-purple-500 border-2 border-purple-600"></div>
                        <span className="text-gray-600">Scheduled</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded bg-blue-500 border-2 border-blue-600 border-dashed"></div>
                        <span className="text-gray-600">Queued</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-7 gap-0.5 sm:gap-1 md:gap-2 mb-1 sm:mb-2">
                      {DAY_NAMES.map((day) => (
                        <div key={day} className="text-center text-[10px] sm:text-xs font-semibold text-gray-500 py-1 sm:py-2">
                          {day}
                        </div>
                      ))}
                    </div>

                    <div className="grid grid-cols-7 gap-1 sm:gap-1 md:gap-2 min-w-0">
                      {monthCalendar.map((day, index) => {
                        const hasPublished = day.posts.some((p) => p.status === 'published');
                        const hasScheduled = day.posts.some((p) => p.status === 'scheduled');
                        const hasQueued = day.posts.some((p) => p.status === 'queued');
                        const borderColor = hasPublished
                          ? 'border-green-500 bg-green-50'
                          : hasScheduled
                            ? 'border-purple-500 bg-purple-50'
                            : hasQueued
                              ? 'border-blue-500 bg-blue-50'
                              : day.isToday
                                ? 'border-orange-500 bg-orange-50'
                                : 'border-gray-200';
                        const borderStyle = hasQueued ? 'border-dashed' : '';
                        const textColor = hasPublished
                          ? 'text-green-900'
                          : hasScheduled
                            ? 'text-purple-900'
                            : hasQueued
                              ? 'text-blue-900'
                              : day.isToday
                                ? 'text-orange-900'
                                : 'text-gray-900';

                        const dateKey = day.date.toISOString().split('T')[0];
                        const dayConflicts = conflicts.get(dateKey);
                        const hasConflict = dayConflicts && dayConflicts.length > 0;
                        const hasHighConflict = dayConflicts?.some((c) => c.severity === 'high');
                        const conflictBorder = hasHighConflict
                          ? 'border-red-500 border-dashed'
                          : hasConflict
                            ? 'border-orange-500 border-dashed'
                            : '';

                        return (
                          <div
                            key={index}
                            className={`aspect-square p-1.5 sm:p-2 border-2 ${borderColor} ${borderStyle} ${conflictBorder} rounded-lg cursor-pointer hover:opacity-80 transition-all touch-manipulation relative group shadow-sm ${
                              !day.isCurrentMonth ? 'opacity-50' : ''
                            }`}
                            onClick={() => {
                              if (day.posts.length > 0) {
                                handlePostClick();
                              } else {
                                handleDayClick(day.date);
                              }
                            }}
                          >
                            <div className="flex items-start justify-between mb-0.5 sm:mb-1">
                              <div className={`text-[11px] sm:text-xs font-semibold ${textColor}`}>{day.dayOfMonth}</div>
                              {day.posts.length > 0 && (
                                <span
                                  className={`px-1 sm:px-1.5 py-0.5 text-[9px] sm:text-[10px] font-medium rounded-full ${
                                    hasPublished
                                      ? 'bg-green-600 text-white'
                                      : hasScheduled
                                        ? 'bg-purple-600 text-white'
                                        : hasQueued
                                          ? 'bg-blue-600 text-white'
                                          : 'bg-gray-600 text-white'
                                  }`}
                                >
                                  {day.posts.length}
                                </span>
                              )}
                            </div>
                            {day.posts.length > 0 && (
                              <div className="mt-0.5 sm:mt-1">
                                <div
                                  className={`text-[9px] sm:text-[10px] font-medium ${
                                    hasPublished ? 'text-green-700' : hasScheduled ? 'text-purple-700' : 'text-blue-700'
                                  }`}
                                >
                                  {formatTime(day.posts[0].scheduledAt)}
                                </div>
                                <div
                                  className={`text-[9px] sm:text-[10px] truncate hidden sm:block ${
                                    hasPublished ? 'text-green-600' : hasScheduled ? 'text-purple-600' : 'text-blue-600'
                                  }`}
                                >
                                  {truncateTitle(day.posts[0].title, MAX_TITLE_PREVIEW_LENGTH)}
                                </div>
                              </div>
                            )}
                            {day.isToday && day.posts.length === 0 && (
                              <div className="text-[9px] sm:text-[10px] text-orange-700 font-medium mt-0.5">Today</div>
                            )}
                            {hasConflict && (
                              <div
                                className={`absolute top-1 right-1 w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${
                                  hasHighConflict ? 'bg-red-500' : 'bg-orange-500'
                                }`}
                                title={dayConflicts?.map((c) => c.message).join(', ')}
                              ></div>
                            )}
                            {day.posts.length > 0 && (
                              <div className="absolute z-10 hidden group-hover:block bottom-full left-1/2 transform -translate-x-1/2 mb-2 w-40 sm:w-48 p-2 bg-gray-900 text-white text-[10px] sm:text-xs rounded-lg shadow-xl">
                                <p className="font-semibold">{day.posts[0].title}</p>
                                <p className="text-gray-300 mt-1">
                                  {day.posts[0].status === 'published'
                                    ? 'Published'
                                    : day.posts[0].status === 'queued'
                                      ? 'Queued'
                                      : 'Scheduled'}{' '}
                                  for {formatTime(day.posts[0].scheduledAt)}
                                </p>
                                <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 translate-y-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {viewMode === 'week' && (
                  <div>
                    <div className="mb-4 flex items-center justify-between">
                      <button
                        onClick={handlePreviousWeek}
                        disabled={minDate ? weekStart <= minDate : false}
                        className="p-2 hover:bg-gray-100 rounded-lg touch-manipulation transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="Previous week"
                        type="button"
                      >
                        <svg className="w-4 h-4 sm:w-5 sm:h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
                        </svg>
                      </button>
                      <div className="flex items-center gap-3">
                        <h3 className="text-base sm:text-lg font-semibold text-gray-900">{weekRange}</h3>
                        <button
                          onClick={handleToday}
                          className="px-3 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg touch-manipulation transition-colors"
                          type="button"
                        >
                          Today
                        </button>
                      </div>
                      <button
                        onClick={handleNextWeek}
                        disabled={
                          maxDate
                            ? (() => {
                                const weekEnd = new Date(weekStart);
                                weekEnd.setDate(weekEnd.getDate() + 6);
                                return weekEnd >= maxDate;
                              })()
                            : false
                        }
                        className="p-2 hover:bg-gray-100 rounded-lg touch-manipulation transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="Next week"
                        type="button"
                      >
                        <svg className="w-4 h-4 sm:w-5 sm:h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>
                    <div className="grid grid-cols-7 gap-2">
                      {weekCalendar.map((day) => {
                        const isToday = day.date.toDateString() === new Date().toDateString();
                        return (
                          <div key={day.date.toISOString()} className="text-center py-2 border-b border-gray-200">
                            <p className="text-xs font-semibold text-gray-500">{day.dayName}</p>
                            <p className={`text-sm font-medium mt-1 ${isToday ? 'text-orange-900' : 'text-gray-900'}`}>{day.dayNumber}</p>
                            {isToday && <p className="text-[10px] text-orange-600 mt-0.5">Today</p>}
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-4 space-y-2">
                      {weekCalendar.map((day) =>
                        day.posts.map((post) => (
                          <div
                            key={post.id}
                            className={`p-3 border-l-4 ${
                              post.status === 'published'
                                ? 'bg-green-50 border-green-500'
                                : post.status === 'queued'
                                  ? 'bg-blue-50 border-blue-500 border-dashed'
                                  : 'bg-purple-50 border-purple-500'
                            } rounded-lg cursor-pointer hover:opacity-80 transition-opacity`}
                            onClick={handlePostClick}
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-xs text-gray-500">{formatWeekDate(day.date)}</p>
                                <p className="text-sm font-semibold text-gray-900 mt-1">{formatTime(post.scheduledAt)}</p>
                                <p className="text-xs text-gray-600 mt-1">{post.title}</p>
                              </div>
                              <span
                                className={`px-2 py-1 text-xs font-medium rounded-full ${
                                  post.status === 'published'
                                    ? 'bg-green-100 text-green-800'
                                    : post.status === 'queued'
                                      ? 'bg-blue-100 text-blue-800'
                                      : 'bg-purple-100 text-purple-800'
                                }`}
                              >
                                {post.status === 'published' ? 'Published' : post.status === 'queued' ? 'Queued' : 'Scheduled'}
                              </span>
                            </div>
                          </div>
                        )),
                      )}
                    </div>
                  </div>
                )}

                {viewMode === 'list' && (
                  <div>
                    <div className="mb-4 flex items-center justify-between">
                      <h3 className="text-base sm:text-lg font-semibold text-gray-900">All Scheduled Articles</h3>
                    </div>
                    <div className="space-y-2">
                      {listPosts.length === 0 ? (
                        <div className="text-center py-8 text-gray-500 text-sm">
                          No scheduled articles yet. Articles are automatically generated based on your publishing schedule.
                        </div>
                      ) : (
                        listPosts.map((post) => {
                          const postDate = new Date(post.published_at || post.scheduled_publish_at!);
                          const isPublished = post.status === 'published';
                          const isQueued = isBlogPostWithQueueMarker(post) && post._isQueueItem;
                          return (
                            <div
                              key={post.id}
                              className={`p-3 border-l-4 ${
                                isPublished
                                  ? 'bg-green-50 border-green-500'
                                  : isQueued
                                    ? 'bg-blue-50 border-blue-500 border-dashed'
                                    : 'bg-purple-50 border-purple-500'
                              } rounded-lg cursor-pointer hover:opacity-80 transition-opacity`}
                              onClick={handlePostClick}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex-1">
                                  <p className="text-xs text-gray-500">{formatDate(postDate)}</p>
                                  <p className="text-sm font-semibold text-gray-900 mt-1">{post.title}</p>
                                  <p className="text-xs text-gray-600 mt-1">
                                    {isPublished ? 'Published' : isQueued ? 'Queued' : 'Scheduled'} at {formatTime(postDate)}
                                  </p>
                                </div>
                                <span
                                  className={`px-2 py-1 text-xs font-medium rounded-full ${
                                    isPublished
                                      ? 'bg-green-100 text-green-800'
                                      : isQueued
                                        ? 'bg-blue-100 text-blue-800'
                                        : 'bg-purple-100 text-purple-800'
                                  }`}
                                >
                                  {isPublished ? 'Published' : isQueued ? 'Queued' : 'Scheduled'}
                                </span>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="lg:col-span-2 space-y-3 sm:space-y-4 md:space-y-5 lg:space-y-6 min-w-0">
              {storeId && (
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
                  <div className="p-3 sm:p-4 md:p-5 lg:p-6">
                    <ArticlesQueue storeId={storeId} showTitle={true} selectedDays={selectedDays} publishTime={publishTime} />
                  </div>
                </div>
              )}

              <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
                <div className="p-3 sm:p-4 md:p-5 lg:p-6 border-b border-gray-200">
                  <h2 className="text-sm sm:text-base md:text-lg font-semibold text-gray-900">Schedule Settings</h2>
                </div>
                <div className="p-3 sm:p-4 md:p-5 lg:p-6">
                  <div className="space-y-3 sm:space-y-4 md:space-y-5 lg:space-y-6">
                    <div>
                      <label className="flex items-center gap-2 text-xs sm:text-sm font-medium text-gray-700 mb-2">
                        Publishing Frequency
                        <HelpIcon
                          content={`Your plan allows ${planFrequencyConfig.maxDays} article${planFrequencyConfig.maxDays > 1 ? 's' : ''} per ${planFrequencyConfig.displayName.toLowerCase()}. You can choose which days to publish within this limit.`}
                        />
                      </label>
                      <div className="w-full px-3 py-2.5 sm:py-2 border border-gray-200 bg-gray-50 rounded-lg text-sm text-gray-700">
                        {planFrequencyConfig.displayName}
                      </div>
                      <p className="text-xs text-gray-500 mt-1">Frequency is determined by your plan. You can select which days to publish.</p>
                    </div>
                    <div>
                      <label className="flex items-center gap-2 text-xs sm:text-sm font-medium text-gray-700 mb-2">
                        Publishing Days
                        <span className="ml-1 text-gray-500 font-normal">
                          ({selectedDays.size} of {planFrequencyConfig.maxDays} selected)
                        </span>
                        <HelpIcon
                          content={`Select which days of the week you want articles to publish. Your plan allows up to ${planFrequencyConfig.maxDays} day${planFrequencyConfig.maxDays > 1 ? 's' : ''} per ${planFrequencyConfig.displayName.toLowerCase()}.`}
                        />
                      </label>
                      <div className="space-y-2">
                        {DAY_LABELS.map((label, index) => {
                          const isDisabled = !selectedDays.has(index) && selectedDays.size >= planFrequencyConfig.maxDays;
                          return (
                            <label
                              key={index}
                              className={`flex items-center touch-manipulation ${isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                            >
                              <input
                                type="checkbox"
                                checked={selectedDays.has(index)}
                                onChange={() => handleDayToggle(index)}
                                disabled={isDisabled}
                                className="w-4 h-4 sm:w-5 sm:h-5 text-purple-600 rounded focus:ring-purple-500 disabled:cursor-not-allowed"
                              />
                              <span className="ml-2 text-xs sm:text-sm text-gray-700">{label}</span>
                            </label>
                          );
                        })}
                      </div>
                      {dayValidationError && (
                        <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{dayValidationError}</div>
                      )}
                      {!dayValidationError && selectedDays.size < planFrequencyConfig.minDays && (
                        <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-700">
                          Please select at least {planFrequencyConfig.minDays} day{planFrequencyConfig.minDays > 1 ? 's' : ''} to save your settings.
                        </div>
                      )}
                    </div>
                    <div>
                      <label htmlFor="publish-time" className="flex items-center gap-2 text-xs sm:text-sm font-medium text-gray-700 mb-2">
                        Time
                        <HelpIcon content="Select the default time when articles should be published. All scheduled articles will use this time unless manually changed." />
                      </label>
                      <input
                        id="publish-time"
                        type="time"
                        value={publishTime}
                        onChange={(e) => setPublishTime(e.target.value)}
                        className="w-full px-3 py-2.5 sm:py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors touch-manipulation"
                      />
                    </div>
                    <button
                      onClick={handleSaveSettings}
                      disabled={isSaving}
                      className="w-full py-2.5 sm:py-2 bg-purple-600 text-white rounded-lg text-sm sm:text-base font-medium hover:bg-purple-700 transition-colors touch-manipulation disabled:opacity-50 disabled:cursor-not-allowed"
                      type="button"
                    >
                      {isSaving ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {showScheduleModal && selectedPostForSchedule && selectedDate && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-2 sm:p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full max-h-[95vh] sm:max-h-[90vh] overflow-y-auto m-2 sm:m-0 p-4 sm:p-6">
              <h2 className="text-lg sm:text-xl font-bold text-gray-900 mb-4">Schedule Article</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Article</label>
                  <p className="text-sm text-gray-900 bg-gray-50 p-2 rounded">{selectedPostForSchedule.title}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Date</label>
                  <p className="text-sm text-gray-900 bg-gray-50 p-2 rounded">
                    {selectedDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
                <div>
                  <label htmlFor="schedule-time" className="block text-sm font-medium text-gray-700 mb-2">
                    Time
                  </label>
                  <input
                    id="schedule-time"
                    type="time"
                    value={modalPublishTime}
                    onChange={(e) => setModalPublishTime(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none"
                  />
                </div>
                {selectedDate && checkingConflicts && <div className="text-xs text-gray-500">Checking for conflicts...</div>}
                {selectedDate && conflicts.has(selectedDate.toISOString().split('T')[0]) && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                    <p className="text-xs font-semibold text-yellow-900 mb-1">Conflict Detected</p>
                    {conflicts.get(selectedDate.toISOString().split('T')[0])?.map((conflict, idx) => (
                      <p
                        key={idx}
                        className={`text-xs ${
                          conflict.severity === 'high' ? 'text-red-700' : conflict.severity === 'medium' ? 'text-orange-700' : 'text-yellow-700'
                        }`}
                      >
                        {conflict.message}
                      </p>
                    ))}
                  </div>
                )}
                <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 pt-4">
                  <button
                    onClick={handleCloseScheduleModal}
                    className="flex-1 px-3 sm:px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors touch-manipulation"
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSchedulePost}
                    disabled={schedulePostMutation.isPending}
                    className="flex-1 px-3 sm:px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation"
                    type="button"
                  >
                    {schedulePostMutation.isPending ? 'Scheduling...' : 'Schedule Article'}
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
