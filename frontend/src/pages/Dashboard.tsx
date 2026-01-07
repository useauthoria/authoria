import { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDashboardData } from '../hooks/useDashboardData';
import { getShopDomain } from '../lib/app-bridge';
import { queueApi, type BlogPost, type QueuedArticle, type Store, type QuotaStatus } from '../lib/api-client';
import { getPlanFrequencyConfig } from '../utils/plan-frequency';
import TrialExpirationBanner from '../components/TrialExpirationBanner';
import PlansModal from '../components/PlansModal';
import { formatAPIErrorMessage } from '../utils/error-messages';
import Tooltip, { HelpIcon } from '../components/Tooltip';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

const REFETCH_INTERVAL = 300000;
const QUEUE_REFETCH_INTERVAL = 30000;
const MAX_ATTEMPTS = 200;
const DEFAULT_PUBLISH_TIME = '14:00';
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const JS_DAYS_IN_WEEK = 7;
const HOURS_IN_DAY = 24;
const MINUTES_IN_HOUR = 60;
const MILLISECONDS_IN_DAY = 24 * 60 * 60 * 1000;
const MAX_TITLE_LENGTH = 20;

interface ScheduledArticle {
  readonly id: string;
  readonly title: string;
  readonly scheduledAt: Date;
  readonly status: 'scheduled' | 'published' | 'queued';
}

interface BlogPostWithQueueMarker extends BlogPost {
  readonly _isQueueItem?: boolean;
}

interface ScheduleSettings {
  readonly selectedDays: Set<number>;
  readonly publishTime: string;
}

interface ScheduleInfo {
  readonly frequency: string;
  readonly days: readonly string[];
  readonly time: string;
  readonly nextPublish: Date | null;
  readonly nextArticleTitle: string | null;
}

interface AnalyticsMetrics {
  readonly chartData: Array<{
    readonly name: string;
    readonly clicks: number;
    readonly impressions: number;
  }>;
}

interface AnalyticsData {
  readonly topPosts?: ReadonlyArray<{
    readonly title?: string;
    readonly clicks?: number;
    readonly impressions?: number;
  }>;
}

interface GroupedScheduledArticles {
  readonly upcoming: readonly ScheduledArticle[];
  readonly thisWeek: readonly ScheduledArticle[];
  readonly later: readonly ScheduledArticle[];
}

const formatDate = (date: Date | string | null | undefined): string => {
  if (!date) {
    return '';
  }
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) {
    return '';
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const articleDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (articleDate.getTime() === today.getTime()) {
    return `Today, ${formatTime(d)}`;
  } else if (articleDate.getTime() === tomorrow.getTime()) {
    return `Tomorrow, ${formatTime(d)}`;
  } else {
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, ${formatTime(d)}`;
  }
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

const groupScheduledArticles = (posts: readonly BlogPostWithQueueMarker[]): GroupedScheduledArticles => {
  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const endOfTomorrow = new Date(now);
  endOfTomorrow.setDate(now.getDate() + 1);
  endOfTomorrow.setHours(23, 59, 59, 999);

  const endOfWeek = new Date(now);
  endOfWeek.setDate(now.getDate() + (JS_DAYS_IN_WEEK - now.getDay()));
  endOfWeek.setHours(23, 59, 59, 999);

  const scheduled: ScheduledArticle[] = posts
    .filter((p) => {
      const postDate = p.published_at || p.scheduled_publish_at;
      if (!postDate) {
        return false;
      }
      return p.status === 'scheduled' || (p.status === 'queued' && p.scheduled_publish_at);
    })
    .map((p) => {
      const postDate = p.published_at || p.scheduled_publish_at;
      if (!postDate) {
        throw new Error('Post date is required');
      }
      if (p._isQueueItem) {
        return {
          id: p.id,
          title: p.title,
          scheduledAt: new Date(postDate),
          status: 'queued' as const,
        };
      } else if (p.status === 'scheduled') {
        return {
          id: p.id,
          title: p.title,
          scheduledAt: new Date(postDate),
          status: 'scheduled' as const,
        };
      } else {
        return {
          id: p.id,
          title: p.title,
          scheduledAt: new Date(postDate),
          status: 'published' as const,
        };
      }
    })
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());

  const upcoming = scheduled.filter((a) => a.scheduledAt <= endOfTomorrow);
  const thisWeek = scheduled.filter((a) => a.scheduledAt > endOfTomorrow && a.scheduledAt <= endOfWeek);
  const later = scheduled.filter((a) => a.scheduledAt > endOfWeek);

  return { upcoming, thisWeek, later };
};

const getShopName = (): string => {
  const domain = getShopDomain();
  if (!domain) {
    return 'Merchant';
  }
  let name = domain;
  if (domain.includes('.')) {
    name = domain.split('.')[0];
  }
  return name
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

const getCurrentDate = (): string => {
  const now = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
  return `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}`;
};

const isQuotaStatus = (quota: unknown): quota is QuotaStatus => {
  return (
    quota !== null &&
    typeof quota === 'object' &&
    'plan_name' in quota &&
    typeof (quota as QuotaStatus).plan_name === 'string' &&
    'articles_used' in quota &&
    typeof (quota as QuotaStatus).articles_used === 'number' &&
    'articles_allowed' in quota &&
    typeof (quota as QuotaStatus).articles_allowed === 'number'
  );
};

const isQuotaWithError = (quota: unknown): quota is { error: unknown } => {
  return quota !== null && typeof quota === 'object' && 'error' in quota;
};

const isStoreWithFrequencySettings = (store: Store | null): store is Store & { frequency_settings: Store['frequency_settings'] } => {
  return store !== null && typeof store === 'object' && 'frequency_settings' in store;
};

const isAnalyticsData = (analytics: unknown): analytics is AnalyticsData => {
  return analytics !== null && typeof analytics === 'object';
};

const extractFrequencySettings = (store: Store | null): ScheduleSettings => {
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

const formatPlanName = (planName: string | null): string => {
  if (!planName || planName === 'Unknown') {
    return 'No Plan';
  }
  return planName
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

const calculateQuotaLimit = (quota: QuotaStatus | null): number => {
  if (!quota) {
    return 30;
  }

  if (quota.articles_allowed_display !== undefined) {
    return quota.articles_allowed_display;
  }

  const isTrial = quota.is_trial || quota.plan_name === 'free_trial';

  if (isTrial) {
    return 6;
  }

  return quota.articles_allowed || 30;
};

const calculateAnalyticsMetrics = (analytics: unknown): AnalyticsMetrics => {
  if (!isAnalyticsData(analytics)) {
    return { chartData: [] };
  }

  const chartData = (analytics.topPosts || [])
    .slice(0, 5)
    .map((post) => {
      const title = post.title || 'Untitled';
      const truncatedTitle = title.length > MAX_TITLE_LENGTH ? `${title.substring(0, MAX_TITLE_LENGTH)}...` : title;
      return {
        name: truncatedTitle,
        clicks: post.clicks || 0,
        impressions: post.impressions || 0,
      };
    });

  return { chartData };
};

const buildScheduleInfo = (
  store: Store | null,
  scheduledPosts: readonly BlogPost[],
  queuePostsAsBlogPosts: readonly BlogPostWithQueueMarker[],
  planFrequencyConfig: ReturnType<typeof getPlanFrequencyConfig>,
): ScheduleInfo => {
  const frequency = planFrequencyConfig.displayName;
  const settings = isStoreWithFrequencySettings(store) ? store.frequency_settings : null;

  let days: string[] = [];

  if (settings?.preferredDays && Array.isArray(settings.preferredDays) && settings.preferredDays.length > 0) {
    const indices = settings.preferredDays
      .filter(validateJsDay)
      .map(jsDayToIndex)
      .filter(validateDayIndex)
      .sort((a, b) => a - b);

    days = indices.map((idx) => DAY_LABELS[idx]);

    if (days.length > planFrequencyConfig.maxDays) {
      days = days.slice(0, planFrequencyConfig.maxDays);
    }
  } else {
    const defaultDayCount = Math.min(planFrequencyConfig.maxDays, JS_DAYS_IN_WEEK);
    days = DAY_LABELS.slice(0, defaultDayCount);
  }

  const time = settings?.preferredTimes?.[0]
    ? (() => {
        const parsed = parseTime(settings.preferredTimes![0]);
        if (parsed) {
          const date = new Date();
          date.setHours(parsed.hours, parsed.minutes);
          return formatTime(date);
        }
        const defaultDate = new Date();
        defaultDate.setHours(14, 0);
        return formatTime(defaultDate);
      })()
    : (() => {
        const defaultDate = new Date();
        defaultDate.setHours(14, 0);
        return formatTime(defaultDate);
      })();

  const allScheduledWithDates = [
    ...(scheduledPosts || []).filter((p) => p.status === 'scheduled' && p.scheduled_publish_at),
    ...queuePostsAsBlogPosts.filter((p) => p.scheduled_publish_at),
  ];
  const nextPost = allScheduledWithDates.sort(
    (a, b) => new Date(a.scheduled_publish_at!).getTime() - new Date(b.scheduled_publish_at!).getTime(),
  )[0];

  return {
    frequency,
    days,
    time,
    nextPublish: nextPost?.scheduled_publish_at ? new Date(nextPost.scheduled_publish_at) : null,
    nextArticleTitle: nextPost?.title || null,
  };
};

export default function Dashboard(): JSX.Element {
  const navigate = useNavigate();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['upcoming']));
  const [isPlansModalOpen, setIsPlansModalOpen] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleError = useCallback((error: unknown) => {
    if (!isMountedRef.current) {
      return;
    }
    const errorMessage = formatAPIErrorMessage(error, { action: 'load dashboard', resource: 'dashboard' });
  }, []);

  const {
    store,
    quota,
    posts,
    scheduledPosts,
    draftPosts,
    analytics,
    isLoading,
    isError,
    error,
    refetch,
  } = useDashboardData({
    onError: handleError,
  });

  const shopName = useMemo(() => getShopName(), []);
  const currentDate = useMemo(() => getCurrentDate(), []);

  const totalArticles = useMemo(() => {
    return (posts?.length || 0) + (scheduledPosts?.length || 0) + (draftPosts?.length || 0);
  }, [posts?.length, scheduledPosts?.length, draftPosts?.length]);

  const publishedCount = useMemo(() => posts?.length || 0, [posts?.length]);
  const draftsCount = useMemo(() => draftPosts?.length || 0, [draftPosts?.length]);

  const planName = useMemo(() => {
    if (!isQuotaStatus(quota)) {
      return null;
    }
    return quota.plan_name || null;
  }, [quota]);

  const formattedPlanName = useMemo(() => {
    if (isLoading) {
      return 'Loading...';
    }
    if (!isQuotaStatus(quota)) {
      return 'No Plan';
    }
    return formatPlanName(quota.plan_name);
  }, [quota, isLoading]);

  const hasNoActivePlan = useMemo(() => {
    if (isLoading) {
      return false;
    }
    if (isQuotaWithError(quota)) {
      return true;
    }
    if (!isQuotaStatus(quota)) {
      return false;
    }

    const name = quota.plan_name || '';
    const isTrial = quota.is_trial || false;
    const isNoPlan = formattedPlanName === 'No Plan';
    const isExpiredTrial = name === 'free_trial' && !isTrial;

    return (isNoPlan && !isTrial) || isExpiredTrial;
  }, [quota, isLoading, formattedPlanName]);

  const planFrequencyConfig = useMemo(() => getPlanFrequencyConfig(planName), [planName]);

  const storeId = useMemo(() => store?.id ?? '', [store?.id]);

  const {
    data: queue = [],
  } = useQuery({
    queryKey: ['queue', storeId] as const,
    queryFn: () => queueApi.getQueue(storeId),
    enabled: !!storeId,
    refetchInterval: QUEUE_REFETCH_INTERVAL,
  });

  const scheduleSettings = useMemo(() => extractFrequencySettings(store), [store]);

  const existingDates = useMemo(() => {
    return new Set(
      [...(scheduledPosts || []), ...(posts || [])]
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
  }, [scheduledPosts, posts]);

  const scheduledDates = useMemo(() => {
    return calculateScheduledDates(queue.length, scheduleSettings.selectedDays, scheduleSettings.publishTime, existingDates);
  }, [queue.length, scheduleSettings.selectedDays, scheduleSettings.publishTime, existingDates]);

  const queuePostsAsBlogPosts = useMemo(() => {
    return buildQueuePostsAsBlogPosts(queue, scheduledDates);
  }, [queue, scheduledDates]);

  const scheduledCount = useMemo(() => {
    return (scheduledPosts?.length || 0) + queuePostsAsBlogPosts.length;
  }, [scheduledPosts?.length, queuePostsAsBlogPosts.length]);

  const { upcoming, thisWeek, later } = useMemo(() => {
    const allScheduled = [...(scheduledPosts || []), ...queuePostsAsBlogPosts];
    return groupScheduledArticles(allScheduled);
  }, [scheduledPosts, queuePostsAsBlogPosts]);

  const schedule = useMemo(() => {
    return buildScheduleInfo(store, scheduledPosts || [], queuePostsAsBlogPosts, planFrequencyConfig);
  }, [store, scheduledPosts, queuePostsAsBlogPosts, planFrequencyConfig]);

  const quotaUsed = useMemo(() => {
    if (!isQuotaStatus(quota)) {
      return 0;
    }
    return quota.articles_used || 0;
  }, [quota]);

  const quotaLimit = useMemo(() => calculateQuotaLimit(isQuotaStatus(quota) ? quota : null), [quota]);

  const analyticsMetrics = useMemo(() => calculateAnalyticsMetrics(analytics), [analytics]);

  const toggleSection = useCallback((section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  const handlePostClick = useCallback(() => {
    navigate('/posts');
  }, [navigate]);

  const handleOpenPlansModal = useCallback(() => {
    setIsPlansModalOpen(true);
  }, []);

  const handleClosePlansModal = useCallback(() => {
    setIsPlansModalOpen(false);
  }, []);

  const handleNavigateToPosts = useCallback(() => {
    navigate('/posts');
  }, [navigate]);

  const handleNavigateToSchedule = useCallback(() => {
    navigate('/schedule');
  }, [navigate]);

  const handleNavigateToAnalytics = useCallback(() => {
    navigate('/analytics');
  }, [navigate]);

  const handleNavigateToSettings = useCallback(() => {
    navigate('/settings');
  }, [navigate]);

  const handleReload = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, []);

  if (isLoading) {
    return (
      <div className="h-screen overflow-hidden bg-gray-50">
        <main className="h-full overflow-y-auto bg-gray-50">
          <header className="bg-white border-b border-gray-200 px-4 sm:px-6 lg:px-8 py-4 sm:py-5 lg:py-6">
            <div className="animate-pulse">
              <div className="h-4 w-32 bg-gray-200 rounded mb-2"></div>
              <div className="h-8 w-48 bg-gray-200 rounded mb-2"></div>
              <div className="h-4 w-64 bg-gray-200 rounded"></div>
            </div>
          </header>
          <div className="p-4 sm:p-6 lg:p-8">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5 lg:gap-6 mb-6 sm:mb-8">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="bg-white rounded-xl p-4 sm:p-5 lg:p-6 border border-gray-200 shadow-sm animate-pulse">
                  <div className="h-4 w-24 bg-gray-200 rounded mb-3"></div>
                  <div className="h-10 w-16 bg-gray-200 rounded"></div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5 lg:gap-6">
              <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm animate-pulse p-6">
                <div className="h-6 w-48 bg-gray-200 rounded mb-4"></div>
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-20 bg-gray-100 rounded-lg"></div>
                  ))}
                </div>
              </div>
              <div className="space-y-4 sm:space-y-5 lg:space-y-6">
                {[1, 2].map((i) => (
                  <div key={i} className="bg-white rounded-xl border border-gray-200 shadow-sm animate-pulse p-6">
                    <div className="h-6 w-32 bg-gray-200 rounded mb-4"></div>
                    <div className="space-y-3">
                      <div className="h-4 w-full bg-gray-100 rounded"></div>
                      <div className="h-4 w-3/4 bg-gray-100 rounded"></div>
                    </div>
                  </div>
                ))}
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
              <p className="text-sm text-red-700 mb-4">{formatAPIErrorMessage(error, { action: 'load dashboard', resource: 'dashboard' })}</p>
              <div className="flex gap-3">
                <button
                  onClick={handleReload}
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

  return (
    <div className="h-screen overflow-hidden bg-gray-50">
      <main className="h-full overflow-y-auto bg-gray-50">
        <header className="bg-white border-b border-gray-200 px-4 sm:px-6 lg:px-8 py-4 sm:py-5 lg:py-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <p className="text-xs sm:text-sm text-gray-500">{currentDate}</p>
              <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-gray-900 mt-1">Hello, {shopName}</h1>
              <p className="text-xs sm:text-sm text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-green-500 font-medium mt-1">
                How can I help you today?
              </p>
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              {hasNoActivePlan ? (
                <button
                  onClick={handleOpenPlansModal}
                  className="px-3 sm:px-4 py-2 sm:py-2.5 bg-purple-600 text-white rounded-lg text-sm sm:text-base font-medium hover:bg-purple-700 transition-colors whitespace-nowrap"
                  type="button"
                >
                  Subscribe
                </button>
              ) : (
                <Tooltip
                  content={`You've used ${quotaUsed} of ${quotaLimit} articles this ${planFrequencyConfig.displayName.toLowerCase()}. Articles are automatically generated based on your publishing schedule.`}
                >
                  <button
                    onClick={handleNavigateToPosts}
                    className="px-3 sm:px-4 py-2 sm:py-2.5 bg-purple-600 text-white rounded-lg text-sm sm:text-base font-medium hover:bg-purple-700 transition-colors whitespace-nowrap"
                    type="button"
                  >
                    {quotaUsed}/{quotaLimit} Articles
                  </button>
                </Tooltip>
              )}
              <button
                onClick={handleNavigateToSettings}
                className="px-3 sm:px-4 py-2 sm:py-2.5 border border-blue-300 text-blue-600 rounded-lg text-sm sm:text-base font-medium hover:bg-blue-50 transition-colors flex items-center gap-1.5 sm:gap-2"
                type="button"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="hidden sm:inline">Settings</span>
              </button>
            </div>
          </div>
        </header>

        <div className="p-4 sm:p-6 lg:p-8">
          {hasNoActivePlan && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 sm:p-5 mb-6">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 sm:w-6 sm:h-6 text-yellow-600 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                <div className="flex-1">
                  <h3 className="text-sm sm:text-base font-semibold text-yellow-900 mb-1">No Active Subscription</h3>
                  <p className="text-sm text-yellow-800 mb-3">
                    You don't have an active subscription. Please subscribe to a plan to continue using the service.
                  </p>
                  <button
                    onClick={handleOpenPlansModal}
                    className="px-4 py-2 bg-yellow-600 text-white rounded-lg text-sm font-medium hover:bg-yellow-700 transition-colors focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:ring-offset-2"
                    type="button"
                  >
                    Subscribe Now
                  </button>
                </div>
              </div>
            </div>
          )}

          {isQuotaStatus(quota) && (
            <TrialExpirationBanner
              quota={quota}
              publishedCount={publishedCount}
              scheduledCount={scheduledCount}
              draftsCount={draftsCount}
              onUpgrade={handleOpenPlansModal}
            />
          )}

          <PlansModal
            isOpen={isPlansModalOpen}
            onClose={handleClosePlansModal}
            currentPlanName={planName}
            storeId={store?.id}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5 lg:gap-6 mb-6 sm:mb-8">
            <div className="bg-white rounded-xl p-4 sm:p-5 lg:p-6 border border-gray-200 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 mb-1">
                    <p className="text-xs sm:text-sm text-gray-500">Total Articles</p>
                    <HelpIcon content="Total count of all articles: published, scheduled, and drafts combined." />
                  </div>
                  <p className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900">{totalArticles}</p>
                </div>
                <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg bg-purple-100 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 sm:w-6 sm:h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl p-4 sm:p-5 lg:p-6 border border-gray-200 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 mb-1">
                    <p className="text-xs sm:text-sm text-gray-500">Published</p>
                    <HelpIcon content="Number of articles that have been published and are live on your blog." />
                  </div>
                  <p className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900">{publishedCount}</p>
                </div>
                <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg bg-green-100 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 sm:w-6 sm:h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl p-4 sm:p-5 lg:p-6 border border-gray-200 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 mb-1">
                    <p className="text-xs sm:text-sm text-gray-500">Scheduled</p>
                    <HelpIcon content="Number of articles scheduled to be published at a future date and time." />
                  </div>
                  <p className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900">{scheduledCount}</p>
                </div>
                <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 sm:w-6 sm:h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl p-4 sm:p-5 lg:p-6 border border-gray-200 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 mb-1">
                    <p className="text-xs sm:text-sm text-gray-500">Drafts</p>
                    <HelpIcon content="Number of articles that are still in draft status, waiting for review or editing." />
                  </div>
                  <p className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900">{draftsCount}</p>
                </div>
                <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg bg-orange-100 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 sm:w-6 sm:h-6 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5 lg:gap-6">
            <section className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm">
              <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
                  <div className="flex items-center gap-2">
                    <svg className="w-5 h-5 text-gray-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    <h2 className="text-base sm:text-lg font-semibold text-gray-900">Scheduled Articles</h2>
                  </div>
                </div>
              </div>
              <div className="p-4 sm:p-5 lg:p-6">
                {upcoming.length > 0 && (
                  <div className="mb-4 sm:mb-6">
                    <h3 className="text-xs sm:text-sm font-semibold text-gray-700 mb-3">UPCOMING ({upcoming.length})</h3>
                    <div className="space-y-2 sm:space-y-3">
                      {upcoming.map((article) => (
                        <article
                          key={article.id}
                          className={`flex items-start gap-2 sm:gap-3 p-3 sm:p-4 rounded-lg border cursor-pointer transition-colors ${
                            article.status === 'queued'
                              ? 'bg-blue-50 border-blue-100 border-dashed hover:bg-blue-100'
                              : 'bg-blue-50 border-blue-100 hover:bg-blue-100'
                          }`}
                          onClick={handlePostClick}
                        >
                          <input
                            type="checkbox"
                            className="mt-1 w-4 h-4 sm:w-5 sm:h-5 text-blue-600 rounded flex-shrink-0"
                            onClick={(e) => e.stopPropagation()}
                            readOnly
                          />
                          <div className="flex-1 min-w-0">
                            <h4 className="text-sm sm:text-base font-medium text-gray-900">{article.title}</h4>
                            <div className="flex flex-col sm:flex-row sm:items-center sm:gap-4 mt-2 gap-2 text-xs sm:text-sm text-gray-500">
                              <span className="flex items-center">
                                <svg className="w-3 h-3 sm:w-4 sm:h-4 mr-1 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                                {formatDate(article.scheduledAt)}
                              </span>
                              <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs font-medium w-fit">Auto-publish</span>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>
                )}

                {thisWeek.length > 0 && (
                  <div className="mb-4 sm:mb-6">
                    <button
                      className="flex items-center justify-between w-full text-left mb-3"
                      onClick={() => toggleSection('thisWeek')}
                      type="button"
                    >
                      <h3 className="text-xs sm:text-sm font-semibold text-gray-700">THIS WEEK ({thisWeek.length})</h3>
                      <svg
                        className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${expandedSections.has('thisWeek') ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {expandedSections.has('thisWeek') && (
                      <div className="space-y-2 sm:space-y-3">
                        {thisWeek.map((article) => (
                          <article
                            key={article.id}
                            className={`flex items-start gap-2 sm:gap-3 p-3 sm:p-4 rounded-lg border cursor-pointer transition-colors ${
                              article.status === 'queued'
                                ? 'bg-blue-50 border-blue-100 border-dashed hover:bg-blue-100'
                                : 'bg-gray-50 border-gray-100 hover:bg-gray-100'
                            }`}
                            onClick={handlePostClick}
                          >
                            <input
                              type="checkbox"
                              className="mt-1 w-4 h-4 sm:w-5 sm:h-5 text-blue-600 rounded flex-shrink-0"
                              onClick={(e) => e.stopPropagation()}
                              readOnly
                            />
                            <div className="flex-1 min-w-0">
                              <h4 className="text-sm sm:text-base font-medium text-gray-900">{article.title}</h4>
                              <div className="flex flex-col sm:flex-row sm:items-center sm:gap-4 mt-2 gap-2 text-xs sm:text-sm text-gray-500">
                                <span className="flex items-center">
                                  <svg className="w-3 h-3 sm:w-4 sm:h-4 mr-1 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                  </svg>
                                  {formatDate(article.scheduledAt)}
                                </span>
                                <span
                                  className={`px-2 py-0.5 rounded text-xs font-medium w-fit ${
                                    article.status === 'queued' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                                  }`}
                                >
                                  {article.status === 'queued' ? 'Queued' : 'Auto-publish'}
                                </span>
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {later.length > 0 && (
                  <div>
                    <button
                      className="flex items-center justify-between w-full text-left mb-3"
                      onClick={() => toggleSection('later')}
                      type="button"
                    >
                      <h3 className="text-xs sm:text-sm font-semibold text-gray-700">LATER ({later.length})</h3>
                      <svg
                        className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${expandedSections.has('later') ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {expandedSections.has('later') && (
                      <div className="space-y-2 sm:space-y-3">
                        {later.map((article) => (
                          <article
                            key={article.id}
                            className={`flex items-start gap-2 sm:gap-3 p-3 sm:p-4 rounded-lg border cursor-pointer transition-colors ${
                              article.status === 'queued'
                                ? 'bg-blue-50 border-blue-100 border-dashed hover:bg-blue-100'
                                : 'bg-gray-50 border-gray-100 hover:bg-gray-100'
                            }`}
                            onClick={handlePostClick}
                          >
                            <input
                              type="checkbox"
                              className="mt-1 w-4 h-4 sm:w-5 sm:h-5 text-blue-600 rounded flex-shrink-0"
                              onClick={(e) => e.stopPropagation()}
                              readOnly
                            />
                            <div className="flex-1 min-w-0">
                              <h4 className="text-sm sm:text-base font-medium text-gray-900">{article.title}</h4>
                              <div className="flex flex-col sm:flex-row sm:items-center sm:gap-4 mt-2 gap-2 text-xs sm:text-sm text-gray-500">
                                <span className="flex items-center">
                                  <svg className="w-3 h-3 sm:w-4 sm:h-4 mr-1 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                  </svg>
                                  {formatDate(article.scheduledAt)}
                                </span>
                                <span
                                  className={`px-2 py-0.5 rounded text-xs font-medium w-fit ${
                                    article.status === 'queued' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                                  }`}
                                >
                                  {article.status === 'queued' ? 'Queued' : 'Auto-publish'}
                                </span>
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {upcoming.length === 0 && thisWeek.length === 0 && later.length === 0 && (
                  <div className="text-center py-8 text-gray-500 text-sm">
                    No scheduled articles yet. Articles are automatically generated based on your publishing schedule.
                  </div>
                )}
              </div>
            </section>

            <aside className="space-y-4 sm:space-y-5 lg:space-y-6">
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
                <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                  <div className="flex items-center gap-2">
                    <svg className="w-5 h-5 text-gray-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <h2 className="text-base sm:text-lg font-semibold text-gray-900">Publishing Schedule</h2>
                  </div>
                </div>
                <div className="p-4 sm:p-5 lg:p-6">
                  <div className="space-y-3 sm:space-y-4">
                    {schedule.nextPublish && (
                      <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
                        <p className="text-xs text-gray-500 mb-1">Next Scheduled Publish</p>
                        <p className="text-sm font-semibold text-gray-900">{formatDate(schedule.nextPublish)}</p>
                        {schedule.nextArticleTitle && <p className="text-xs text-gray-500 mt-1 line-clamp-2">{schedule.nextArticleTitle}</p>}
                      </div>
                    )}
                    <div>
                      <p className="text-xs sm:text-sm text-gray-500 mb-1">Frequency</p>
                      <p className="text-base sm:text-lg font-semibold text-gray-900">{schedule.frequency}</p>
                    </div>
                    <div>
                      <p className="text-xs sm:text-sm text-gray-500 mb-1">Days</p>
                      <div className="flex flex-wrap gap-2">
                        {schedule.days.map((day) => (
                          <span key={day} className="px-2 sm:px-3 py-1 bg-purple-100 text-purple-700 rounded text-xs sm:text-sm font-medium">
                            {day}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs sm:text-sm text-gray-500 mb-1">Time</p>
                      <p className="text-base sm:text-lg font-semibold text-gray-900">{schedule.time}</p>
                    </div>
                    <button
                      onClick={handleNavigateToSchedule}
                      className="block w-full mt-4 py-2.5 sm:py-2 text-sm text-purple-600 font-medium hover:bg-purple-50 rounded-lg transition-colors border border-purple-200 text-center touch-manipulation"
                      type="button"
                    >
                      Edit Schedule
                    </button>
                  </div>
                </div>
              </div>

              {analyticsMetrics.chartData.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
                  <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                    <div className="flex items-center gap-2">
                      <svg className="w-5 h-5 text-gray-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                        />
                      </svg>
                      <h2 className="text-base sm:text-lg font-semibold text-gray-900">Top Performing Articles</h2>
                    </div>
                  </div>
                  <div className="p-4 sm:p-5 lg:p-6">
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={analyticsMetrics.chartData} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis type="number" stroke="#6b7280" fontSize={12} />
                        <YAxis dataKey="name" type="category" stroke="#6b7280" fontSize={10} width={100} />
                        <RechartsTooltip
                          formatter={(value: number, name: string) => [
                            name === 'clicks' ? `${value} clicks` : `${value} impressions`,
                            name === 'clicks' ? 'Clicks' : 'Impressions',
                          ]}
                          contentStyle={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px' }}
                        />
                        <Legend />
                        <Bar dataKey="clicks" fill="#9333ea" name="Clicks" />
                        <Bar dataKey="impressions" fill="#3b82f6" name="Impressions" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
                <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                  <div className="flex items-center gap-2">
                    <svg className="w-5 h-5 text-gray-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    <h2 className="text-base sm:text-lg font-semibold text-gray-900">Quick Actions</h2>
                  </div>
                </div>
                <div className="p-4 sm:p-5 lg:p-6">
                  <div className="space-y-2 sm:space-y-3">
                    <button
                      type="button"
                      onClick={handleNavigateToPosts}
                      className="block w-full text-left px-3 sm:px-4 py-3 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors border border-blue-200 touch-manipulation"
                    >
                      <div className="flex items-center gap-2 sm:gap-3">
                        <svg className="w-5 h-5 text-blue-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <span className="text-sm sm:text-base font-medium text-blue-900">View All Articles</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={handleNavigateToSchedule}
                      className="block w-full text-left px-3 sm:px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200 touch-manipulation"
                    >
                      <div className="flex items-center gap-2 sm:gap-3">
                        <svg className="w-5 h-5 text-gray-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        <span className="text-sm sm:text-base font-medium text-gray-900">Calendar View</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={handleNavigateToAnalytics}
                      className="block w-full text-left px-3 sm:px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200 touch-manipulation"
                    >
                      <div className="flex items-center gap-2 sm:gap-3">
                        <svg className="w-5 h-5 text-gray-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                          />
                        </svg>
                        <span className="text-sm sm:text-base font-medium text-gray-900">View Analytics</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={handleNavigateToSettings}
                      className="block w-full text-left px-3 sm:px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200 touch-manipulation"
                    >
                      <div className="flex items-center gap-2 sm:gap-3">
                        <svg className="w-5 h-5 text-gray-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                          />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        <span className="text-sm sm:text-base font-medium text-gray-900">Settings</span>
                      </div>
                    </button>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}
