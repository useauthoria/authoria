import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDashboardData } from '../hooks/useDashboardData';
import { getShopDomain } from '../lib/app-bridge';
import { queueApi, type BlogPost, type QueuedArticle } from '../lib/api-client';
import { getPlanFrequencyConfig } from '../utils/plan-frequency';
import { useQuery } from '@tanstack/react-query';
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

interface ScheduledArticle {
  id: string;
  title: string;
  scheduledAt: Date;
  status: 'scheduled' | 'published' | 'queued';
}


const REFETCH_INTERVAL = 300000; // 5 minutes

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';

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
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + `, ${formatTime(d)}`;
  }
}

// Detect if user's locale uses 12-hour or 24-hour format
function uses12HourFormat(): boolean {
  const testDate = new Date(2024, 0, 1, 13, 0); // 1 PM
  const formatted = testDate.toLocaleTimeString(navigator.language, { hour: 'numeric' });
  // If it contains 'PM' or 'AM', it's 12-hour format
  return formatted.includes('PM') || formatted.includes('AM') || formatted.includes('pm') || formatted.includes('am');
}

function formatTime(date: Date): string {
  const use12Hour = uses12HourFormat();
  return date.toLocaleTimeString(navigator.language, { 
    hour: 'numeric', 
    minute: '2-digit', 
    hour12: use12Hour 
  });
}

function groupScheduledArticles(posts: readonly (BlogPost | (BlogPost & { _isQueueItem?: boolean }))[]): {
  upcoming: ScheduledArticle[];
  thisWeek: ScheduledArticle[];
  later: ScheduledArticle[];
} {
  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const endOfTomorrow = new Date(now);
  endOfTomorrow.setDate(now.getDate() + 1);
  endOfTomorrow.setHours(23, 59, 59, 999);

  const endOfWeek = new Date(now);
  endOfWeek.setDate(now.getDate() + (7 - now.getDay()));
  endOfWeek.setHours(23, 59, 59, 999);

  const scheduled: ScheduledArticle[] = posts
    .filter((p) => {
      const postDate = p.published_at || p.scheduled_publish_at;
      if (!postDate) return false;
      // Include scheduled posts and queue items with scheduled_publish_at
      return (p.status === 'scheduled' || (p.status === 'queued' && p.scheduled_publish_at));
    })
    .map((p) => {
      const postWithMarker = p as BlogPost & { _isQueueItem?: boolean };
      const postDate = p.published_at || p.scheduled_publish_at!;
      if (postWithMarker._isQueueItem) {
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

  // Upcoming: today or tomorrow (within next ~48 hours)
  const upcoming = scheduled.filter((a) => a.scheduledAt <= endOfTomorrow);

  // This week: after tomorrow but within the current week
  const thisWeek = scheduled.filter((a) => a.scheduledAt > endOfTomorrow && a.scheduledAt <= endOfWeek);

  // Later: beyond this week
  const later = scheduled.filter((a) => a.scheduledAt > endOfWeek);

  return { upcoming, thisWeek, later };
}

function getShopName(): string {
  const domain = getShopDomain();
  if (!domain) return 'Merchant';
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
}

function getCurrentDate(): string {
  const now = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['upcoming']));
  const [isPlansModalOpen, setIsPlansModalOpen] = useState(false);

  const handleError = useCallback((error: Error) => {
    console.error('[Dashboard] Error:', error);
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
  }, [posts, scheduledPosts, draftPosts]);

  const publishedCount = useMemo(() => posts?.length || 0, [posts]);
  const draftsCount = useMemo(() => draftPosts?.length || 0, [draftPosts]);

  const planName = useMemo(() => {
    if (!quota || typeof quota !== 'object' || 'error' in quota) return null;
    return (quota as { plan_name?: string }).plan_name || null;
  }, [quota]);

  // Format plan name for display (same logic as Settings page)
  const formattedPlanName = useMemo(() => {
    if (isLoading) return 'Loading...';
    if (!quota || typeof quota !== 'object' || 'error' in quota) return 'No Plan';
    const name = (quota as { plan_name?: string }).plan_name || 'Unknown';
    if (!name || name === 'Unknown') return 'No Plan';
    return name
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }, [quota, isLoading]);

  // Check if user has no active plan (no plan or not on trial)
  const hasNoActivePlan = useMemo(() => {
    if (isLoading) return false;
    if (!quota || typeof quota !== 'object') return false;
    if ('error' in quota && quota.error) return true;

    const quotaData = quota as { plan_name?: string; is_trial?: boolean };
    const name = quotaData.plan_name || '';
    const isTrial = quotaData.is_trial || false;

    // Show banner if:
    // 1. Formatted plan name is "No Plan" (plan_name is missing/unknown/empty) and not on trial
    // 2. OR plan_name is "free_trial" but is_trial is false (trial expired/not active)
    const isNoPlan = formattedPlanName === 'No Plan';
    const isExpiredTrial = name === 'free_trial' && !isTrial;

    const result = (isNoPlan && !isTrial) || isExpiredTrial;

    return result;
  }, [quota, isLoading, formattedPlanName]);

  const planFrequencyConfig = useMemo(() => getPlanFrequencyConfig(planName), [planName]);

  const storeId = store?.id ?? '';

  // Fetch queue articles
  const {
    data: queue = [],
  } = useQuery({
    queryKey: ['queue', storeId],
    queryFn: () => queueApi.getQueue(storeId),
    enabled: !!storeId,
    refetchInterval: 30000,
  });

  // Get schedule settings from store
  const scheduleSettings = useMemo(() => {
    if (!store) return { selectedDays: new Set<number>(), publishTime: '14:00' };
    
    const settings = (store as { frequency_settings?: unknown }).frequency_settings as {
      preferredDays?: number[];
      preferredTimes?: string[];
    } | null | undefined;
    
    // Convert JS day format (Sun=0, Mon=1, ..., Sat=6) to our index format (Mon=0, ..., Sun=6)
    const jsDayToIndex = (jsDay: number): number => jsDay === 0 ? 6 : jsDay - 1;
    
    const selectedDays = new Set<number>();
    if (settings?.preferredDays) {
      settings.preferredDays.forEach((jsDay) => {
        const index = jsDayToIndex(jsDay);
        if (index >= 0 && index < 7) {
          selectedDays.add(index);
        }
      });
    }
    
    const publishTime = settings?.preferredTimes?.[0] || '14:00';
    const [hours, minutes] = publishTime.split(':').map(Number);
    const formattedTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    
    return { selectedDays, publishTime: formattedTime };
  }, [store]);

  // Convert queue items to BlogPost-like format with calculated scheduled dates
  const queuePostsAsBlogPosts = useMemo(() => {
    if (!scheduleSettings.selectedDays || scheduleSettings.selectedDays.size === 0 || queue.length === 0) return [];
    
    // Convert our day index (Mon=0, ..., Sun=6) to JS Date.getDay() format (Sun=0, Mon=1, ..., Sat=6)
    const dayIndexToJsDay = (index: number): number => index === 6 ? 0 : index + 1;
    
    // Get existing scheduled/published dates to avoid conflicts
    const existingDates = new Set(
      [...(scheduledPosts || []), ...(posts || [])]
        .map((p) => {
          const date = p.published_at || p.scheduled_publish_at;
          if (!date) return null;
          const d = new Date(date);
          return d.toISOString();
        })
        .filter((d): d is string => d !== null)
    );
    
    // Calculate scheduled dates for queue items, avoiding conflicts
    const dates: Date[] = [];
    const now = new Date();
    const [hours, minutes] = scheduleSettings.publishTime.split(':').map(Number);
    const jsDays = Array.from(scheduleSettings.selectedDays).map(dayIndexToJsDay).sort((a, b) => a - b);
    
    let currentDate = new Date(now);
    currentDate.setHours(hours, minutes, 0, 0);
    
    if (currentDate <= now) {
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    let attempts = 0;
    const maxAttempts = 200;
    
    while (dates.length < queue.length && attempts < maxAttempts) {
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
    
    // Convert queue items to BlogPost format with a special marker
    return queue.slice(0, dates.length).map((article, index): BlogPost & { _isQueueItem?: boolean } => ({
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
    }));
  }, [queue, scheduleSettings.selectedDays, scheduleSettings.publishTime, scheduledPosts, posts]);

  const scheduledCount = useMemo(() => {
    return (scheduledPosts?.length || 0) + queuePostsAsBlogPosts.length;
  }, [scheduledPosts, queuePostsAsBlogPosts]);

  const { upcoming, thisWeek, later } = useMemo(() => {
    const allScheduled = [...(scheduledPosts || []), ...queuePostsAsBlogPosts];
    return groupScheduledArticles(allScheduled);
  }, [scheduledPosts, queuePostsAsBlogPosts]);

  const schedule = useMemo(() => {
    // Get plan-based frequency configuration (must match Schedule page)
    const frequency = planFrequencyConfig.displayName;

    // Get days from frequency_settings
    const settings = (store as { frequency_settings?: unknown })?.frequency_settings as {
      preferredDays?: number[];
      preferredTimes?: string[];
    } | null | undefined;

    // Day labels matching Schedule page: Mon=0, Tue=1, ..., Sun=6
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    let days: string[] = [];

    if (settings?.preferredDays && settings.preferredDays.length > 0) {
      // Convert JS day format (Sun=0, Mon=1, ..., Sat=6) to our index format (Mon=0, ..., Sun=6)
      // This matches the Schedule page conversion logic
      const jsDayToIndex = (jsDay: number): number => jsDay === 0 ? 6 : jsDay - 1;
      const indices = settings.preferredDays
        .map(jsDayToIndex)
        .filter((idx) => idx >= 0 && idx < 7)
        .sort((a, b) => a - b); // Sort by index (Mon=0 first, Sun=6 last)

      days = indices.map((idx) => dayLabels[idx]);

      // Ensure days count matches plan limits (enforce max)
      if (days.length > planFrequencyConfig.maxDays) {
        days = days.slice(0, planFrequencyConfig.maxDays);
      }
    } else {
      // Default days based on plan frequency (Monday first, matching Schedule page)
      const defaultDayCount = Math.min(planFrequencyConfig.maxDays, 7);
      days = dayLabels.slice(0, defaultDayCount); // Mon, Tue, Wed, etc. (Monday first)
    }

    // Get time from settings
    const time = settings?.preferredTimes?.[0]
      ? (() => {
        const [hours, minutes] = settings.preferredTimes![0].split(':').map(Number);
        const date = new Date();
        date.setHours(hours, minutes);
        return formatTime(date);
      })()
      : formatTime((() => { const d = new Date(); d.setHours(14, 0); return d; })());

    // Get next scheduled post (including queue articles)
    const allScheduledWithDates = [
      ...(scheduledPosts || []).filter((p) => p.status === 'scheduled' && p.scheduled_publish_at),
      ...queuePostsAsBlogPosts.filter((p) => p.scheduled_publish_at),
    ];
    const nextPost = allScheduledWithDates
      .sort((a, b) => new Date(a.scheduled_publish_at!).getTime() - new Date(b.scheduled_publish_at!).getTime())[0];

    return {
      frequency,
      days,
      time,
      nextPublish: nextPost?.scheduled_publish_at ? new Date(nextPost.scheduled_publish_at) : null,
      nextArticleTitle: nextPost?.title || null,
    };
  }, [store, scheduledPosts, queuePostsAsBlogPosts, planFrequencyConfig]);

  // Articles generated (from article_usage table)
  const quotaUsed = useMemo(() => {
    if (!quota) return 0;
    return quota.articles_used || 0;
  }, [quota]);

  // Plan limit: For free trial show total (6), for other plans show monthly limit
  const quotaLimit = useMemo(() => {
    if (!quota) return 30;

    // Use articles_allowed_display if available (from updated API)
    // This field is set by the database function: 6 for trial, monthly for paid
    if (quota.articles_allowed_display !== undefined) {
      return quota.articles_allowed_display;
    }

    // Fallback: calculate based on plan
    const planName = quota.plan_name;
    const isTrial = quota.is_trial || planName === 'free_trial';

    // For free trial: show total articles in trial period (6 articles in 14 days)
    if (isTrial) {
      return 6; // Total articles in 14-day trial (3 per week * 2 weeks)
    }

    // For other plans: show monthly limit
    // The quota API returns articles_allowed which is already monthly for paid plans
    return quota.articles_allowed || 30;
  }, [quota]);

  // Calculate analytics metrics from real data
  const analyticsMetrics = useMemo(() => {
    if (!analytics || typeof analytics !== 'object') {
      return {
        chartData: [],
      };
    }

    const analyticsData = analytics as {
      topPosts?: Array<{ title?: string; clicks?: number; impressions?: number }>;
    };

    // Prepare chart data for top posts
    const chartData = (analyticsData.topPosts || [])
      .slice(0, 5)
      .map((post) => ({
        name: post.title?.substring(0, 20) + (post.title && post.title.length > 20 ? '...' : '') || 'Untitled',
        clicks: post.clicks || 0,
        impressions: post.impressions || 0,
      }));

    return {
      chartData,
    };
  }, [analytics]);

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


  // Loading state
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

  // Error state
  if (isError && error && !store) {
    return (
      <div className="h-screen overflow-hidden bg-gray-50">
        <main className="h-full overflow-y-auto bg-gray-50">
          <div className="p-4 sm:p-6 lg:p-8">
            <div className="bg-red-50 border border-red-200 rounded-xl p-6 max-w-2xl mx-auto">
              <h2 className="text-lg font-semibold text-red-900 mb-2">Setup Required</h2>
              <p className="text-sm text-red-700 mb-4">
                {formatAPIErrorMessage(error, { action: 'load dashboard', resource: 'dashboard' })}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => window.location.reload()}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
                >
                  Refresh Page
                </button>
                <button
                  onClick={() => refetch()}
                  className="px-4 py-2 border border-red-300 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 transition-colors"
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
                  onClick={() => setIsPlansModalOpen(true)}
                  className="px-3 sm:px-4 py-2 sm:py-2.5 bg-purple-600 text-white rounded-lg text-sm sm:text-base font-medium hover:bg-purple-700 transition-colors whitespace-nowrap"
                >
                  Subscribe
                </button>
              ) : (
                <Tooltip content={`You've used ${quotaUsed} of ${quotaLimit} articles this ${planFrequencyConfig.displayName.toLowerCase()}. Articles are automatically generated based on your publishing schedule.`}>
                  <button
                    onClick={() => navigate('/posts')}
                    className="px-3 sm:px-4 py-2 sm:py-2.5 bg-purple-600 text-white rounded-lg text-sm sm:text-base font-medium hover:bg-purple-700 transition-colors whitespace-nowrap"
                  >
                    {quotaUsed}/{quotaLimit} Articles
                  </button>
                </Tooltip>
              )}
              <button
                onClick={() => navigate('/settings')}
                className="px-3 sm:px-4 py-2 sm:py-2.5 border border-blue-300 text-blue-600 rounded-lg text-sm sm:text-base font-medium hover:bg-blue-50 transition-colors flex items-center gap-1.5 sm:gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="hidden sm:inline">Settings</span>
              </button>
            </div>
          </div>
        </header>

        <div className="p-4 sm:p-6 lg:p-8">
          {/* No Active Subscription Banner */}
          {hasNoActivePlan && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 sm:p-5 mb-6">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 sm:w-6 sm:h-6 text-yellow-600 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <div className="flex-1">
                  <h3 className="text-sm sm:text-base font-semibold text-yellow-900 mb-1">No Active Subscription</h3>
                  <p className="text-sm text-yellow-800 mb-3">
                    You don't have an active subscription. Please subscribe to a plan to continue using the service.
                  </p>
                  <button
                    onClick={() => setIsPlansModalOpen(true)}
                    className="px-4 py-2 bg-yellow-600 text-white rounded-lg text-sm font-medium hover:bg-yellow-700 transition-colors focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:ring-offset-2"
                  >
                    Subscribe Now
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Trial Expiration Banner */}
          {quota && typeof quota === 'object' && !('error' in quota) && (
            <TrialExpirationBanner
              quota={quota}
              publishedCount={publishedCount}
              scheduledCount={scheduledCount}
              draftsCount={draftsCount}
              onUpgrade={() => setIsPlansModalOpen(true)}
            />
          )}

          {/* Plans Modal */}
          <PlansModal
            isOpen={isPlansModalOpen}
            onClose={() => setIsPlansModalOpen(false)}
            currentPlanName={planName}
            storeId={store?.id}
          />

          {/* Stats Cards */}
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

          {/* Main Content */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5 lg:gap-6">
            {/* Scheduled Articles Section */}
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
                {/* Upcoming */}
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

                {/* This Week */}
                {thisWeek.length > 0 && (
                  <div className="mb-4 sm:mb-6">
                    <button
                      className="flex items-center justify-between w-full text-left mb-3"
                      onClick={() => toggleSection('thisWeek')}
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
                                <span className={`px-2 py-0.5 rounded text-xs font-medium w-fit ${
                                  article.status === 'queued'
                                    ? 'bg-blue-100 text-blue-700'
                                    : 'bg-green-100 text-green-700'
                                }`}>
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

                {/* Later */}
                {later.length > 0 && (
                  <div>
                    <button
                      className="flex items-center justify-between w-full text-left mb-3"
                      onClick={() => toggleSection('later')}
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
                                <span className={`px-2 py-0.5 rounded text-xs font-medium w-fit ${
                                  article.status === 'queued'
                                    ? 'bg-blue-100 text-blue-700'
                                    : 'bg-green-100 text-green-700'
                                }`}>
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

            {/* Sidebar */}
            <aside className="space-y-4 sm:space-y-5 lg:space-y-6">
              {/* Publishing Schedule */}
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
                        {schedule.nextArticleTitle && (
                          <p className="text-xs text-gray-500 mt-1 line-clamp-2">{schedule.nextArticleTitle}</p>
                        )}
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
                      onClick={() => navigate('/schedule')}
                      className="block w-full mt-4 py-2.5 sm:py-2 text-sm text-purple-600 font-medium hover:bg-purple-50 rounded-lg transition-colors border border-purple-200 text-center touch-manipulation"
                    >
                      Edit Schedule
                    </button>
                  </div>
                </div>
              </div>

              {/* Article Performance */}
              {analyticsMetrics.chartData.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
                  <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                    <div className="flex items-center gap-2">
                      <svg className="w-5 h-5 text-gray-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
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

              {/* Quick Actions */}
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
                      onClick={() => navigate('/posts')}
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
                      onClick={() => navigate('/schedule')}
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
                      onClick={() => navigate('/analytics')}
                      className="block w-full text-left px-3 sm:px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200 touch-manipulation"
                    >
                      <div className="flex items-center gap-2 sm:gap-3">
                        <svg className="w-5 h-5 text-gray-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                        </svg>
                        <span className="text-sm sm:text-base font-medium text-gray-900">View Analytics</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate('/settings')}
                      className="block w-full text-left px-3 sm:px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200 touch-manipulation"
                    >
                      <div className="flex items-center gap-2 sm:gap-3">
                        <svg className="w-5 h-5 text-gray-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
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
