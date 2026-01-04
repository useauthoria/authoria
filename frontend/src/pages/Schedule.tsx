import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore, usePosts, useQuotaStatus, queryKeys } from '../lib/api-cache';
import { getShopDomain } from '../lib/app-bridge';
import { supabase, postsApi, queueApi, type BlogPost, type QueuedArticle } from '../lib/api-client';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { getPlanFrequencyConfig, validateSelectedDays, getFrequencySettings } from '../utils/plan-frequency';
import { useAppBridgeToast } from '../hooks/useAppBridge';
import ArticlesQueue from '../components/ArticlesQueue';
import { formatAPIErrorMessage } from '../utils/error-messages';
import { HelpIcon } from '../components/Tooltip';

const REFETCH_INTERVAL = 300000; // 5 minutes

type ViewMode = 'month' | 'week' | 'list';

interface CalendarDay {
  date: Date;
  dayOfMonth: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  posts: Array<{
    id: string;
    title: string;
    scheduledAt: Date;
    status: 'published' | 'scheduled';
  }>;
}

interface WeekDay {
  date: Date;
  dayName: string;
  dayNumber: number;
  posts: Array<{
    id: string;
    title: string;
    scheduledAt: Date;
    status: 'published' | 'scheduled';
  }>;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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

function formatWeekDate(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[date.getDay()]}, ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  const firstDay = new Date(year, month, 1);
  return firstDay.getDay();
}

function generateMonthCalendar(
  year: number, 
  month: number, 
  posts: readonly BlogPost[],
  minDate: Date | null = null,
  maxDate: Date | null = null
): CalendarDay[] {
  const days: CalendarDay[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const firstDay = getFirstDayOfMonth(year, month);
  const daysInMonth = getDaysInMonth(year, month);
  const daysInPrevMonth = getDaysInMonth(year, month - 1);
  
  // Previous month's trailing days (only show if not before minDate)
  for (let i = firstDay - 1; i >= 0; i--) {
    const date = new Date(year, month - 1, daysInPrevMonth - i);
    date.setHours(0, 0, 0, 0);
    
    // Skip if before minDate
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
  
  // Current month's days
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
  
  // Next month's leading days to fill the grid (only show if not after maxDate)
  const totalCells = days.length;
  const remainingCells = 42 - totalCells; // 6 rows * 7 days
  for (let day = 1; day <= remainingCells; day++) {
    const date = new Date(year, month + 1, day);
    date.setHours(0, 0, 0, 0);
    
    // Skip if after maxDate
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
}

function getPostsForDate(date: Date, posts: readonly BlogPost[]): Array<{
  id: string;
  title: string;
  scheduledAt: Date;
  status: 'published' | 'scheduled';
}> {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  return posts
    .filter((post) => {
      const postDate = post.published_at || post.scheduled_publish_at;
      if (!postDate) return false;
      const d = new Date(postDate);
      return d >= startOfDay && d <= endOfDay;
    })
    .map((post) => ({
      id: post.id,
      title: post.title,
      scheduledAt: new Date(post.published_at || post.scheduled_publish_at!),
      status: (post.status === 'published' ? 'published' : 'scheduled') as 'scheduled' | 'published',
    }))
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

function generateWeekCalendar(startDate: Date, posts: readonly BlogPost[]): WeekDay[] {
  const week: WeekDay[] = [];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  
  for (let i = 0; i < 7; i++) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);
    date.setHours(0, 0, 0, 0);
    
    const dayPosts = getPostsForDate(date, posts);
    week.push({
      date,
      dayName: dayNames[date.getDay()],
      dayNumber: date.getDate(),
      posts: dayPosts,
    });
  }
  
  return week;
}

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday as start
  return new Date(d.setDate(diff));
}

// Map day indices: Monday=0, Tuesday=1, ..., Sunday=6
// But JavaScript Date.getDay() returns: Sunday=0, Monday=1, ..., Saturday=6
// So we need to convert: JS day 1 (Mon) -> our index 0, JS day 0 (Sun) -> our index 6
function jsDayToIndex(jsDay: number): number {
  return jsDay === 0 ? 6 : jsDay - 1;
}


export default function Schedule() {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth());
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const [selectedDays, setSelectedDays] = useState<Set<number>>(new Set([1, 3, 5])); // Mon, Wed, Fri
  const [publishTime, setPublishTime] = useState('14:00');
  const [isSaving, setIsSaving] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [selectedPostForSchedule, setSelectedPostForSchedule] = useState<BlogPost | null>(null);
  const [conflicts, setConflicts] = useState<Map<string, Array<{ type: string; severity: string; message: string }>>>(new Map());
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [dayValidationError, setDayValidationError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { showToast } = useAppBridgeToast();

  const schedulePostMutation = useMutation({
    mutationFn: ({ postId, scheduledAt }: { postId: string; scheduledAt: string }) =>
      postsApi.schedule(postId, scheduledAt),
    onSuccess: () => {
      // Invalidate all post queries to update Dashboard and Articles pages
      queryClient.invalidateQueries({ queryKey: ['posts'] });
      // Also invalidate store cache to update Dashboard schedule display
      if (shopDomain) {
        queryClient.invalidateQueries({ queryKey: queryKeys.store(shopDomain) });
      }
      setShowScheduleModal(false);
      setSelectedPostForSchedule(null);
      setSelectedDate(null);
      showToast('Article scheduled successfully', { isError: false });
    },
    onError: (error) => {
      console.error('Failed to schedule article:', error);
      const errorMessage = formatAPIErrorMessage(error, { action: 'schedule article', resource: 'article' });
      showToast(errorMessage, { isError: true });
    },
  });

  const handleError = useCallback((error: Error) => {
    console.error('[Schedule] Error:', error);
  }, []);

  const shopDomain = useMemo(() => getShopDomain(), []);

  const {
    data: store,
    isLoading: storeLoading,
    error: storeError,
    refetch: refetchStore,
  } = useStore(shopDomain ?? '');

  const storeId = (store as { id?: string } | null)?.id ?? '';

  // Get install date (installed_at or created_at)
  const installDate = useMemo(() => {
    if (!store) return null;
    const storeData = store as { installed_at?: string; created_at?: string } | null;
    const installDateStr = storeData?.installed_at || storeData?.created_at;
    if (!installDateStr) return null;
    return new Date(installDateStr);
  }, [store]);

  // Calculate min and max dates for calendar
  const minDate = useMemo(() => {
    if (!installDate) return null;
    const min = new Date(installDate);
    min.setDate(1); // Start of month
    min.setHours(0, 0, 0, 0);
    return min;
  }, [installDate]);

  const maxDate = useMemo(() => {
    const now = new Date();
    const max = new Date(now.getFullYear(), now.getMonth() + 12, 0); // Last day of month +12 months
    max.setHours(23, 59, 59, 999);
    return max;
  }, []);

  const {
    data: quota,
    isLoading: quotaLoading,
  } = useQuotaStatus(storeId);

  const planName = useMemo(() => {
    if (!quota || typeof quota !== 'object' || 'error' in quota) return null;
    return (quota as { plan_name?: string }).plan_name || null;
  }, [quota]);

  const planFrequencyConfig = useMemo(() => getPlanFrequencyConfig(planName), [planName]);

  const {
    data: allPosts = [],
    isLoading: postsLoading,
    error: postsError,
    refetch: refetchPosts,
  } = usePosts(storeId);

  // Fetch queue articles
  const {
    data: queue = [],
    isLoading: queueLoading,
  } = useQuery({
    queryKey: ['queue', storeId],
    queryFn: () => queueApi.getQueue(storeId),
    enabled: !!storeId,
    refetchInterval: 30000,
  });

  const scheduledPosts = useMemo(() => {
    return allPosts.filter((p) => p.status === 'scheduled' && p.scheduled_publish_at);
  }, [allPosts]);

  const publishedPosts = useMemo(() => {
    return allPosts.filter((p) => p.status === 'published' && p.published_at);
  }, [allPosts]);

  // Convert queue items to BlogPost-like format with calculated scheduled dates
  const queuePostsAsBlogPosts = useMemo(() => {
    if (!selectedDays || selectedDays.size === 0 || queue.length === 0) return [];
    
    // Convert our day index (Mon=0, ..., Sun=6) to JS Date.getDay() format (Sun=0, Mon=1, ..., Sat=6)
    const dayIndexToJsDay = (index: number): number => index === 6 ? 0 : index + 1;
    
    // Calculate scheduled dates for queue items
    const dates: Date[] = [];
    const now = new Date();
    const [hours, minutes] = publishTime.split(':').map(Number);
    const jsDays = Array.from(selectedDays).map(dayIndexToJsDay).sort((a, b) => a - b);
    
    let currentDate = new Date(now);
    currentDate.setHours(hours, minutes, 0, 0);
    
    if (currentDate <= now) {
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    let attempts = 0;
    const maxAttempts = 100;
    
    while (dates.length < queue.length && attempts < maxAttempts) {
      const currentDay = currentDate.getDay();
      if (jsDays.includes(currentDay)) {
        dates.push(new Date(currentDate));
      }
      currentDate.setDate(currentDate.getDate() + 1);
      attempts++;
    }
    
    // Convert queue items to BlogPost format
    return queue.slice(0, dates.length).map((article, index): BlogPost => ({
      id: article.id,
      store_id: article.store_id,
      title: article.title,
      content: article.content || '',
      status: 'queued' as const,
      published_at: null,
      scheduled_publish_at: dates[index].toISOString(),
      seo_health_score: 0,
      created_at: article.created_at,
    }));
  }, [queue, selectedDays, publishTime]);

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
        return dateB.getTime() - dateA.getTime(); // Most recent first
      });
  }, [allRelevantPosts]);


  // Initialize calendar to install date if current date is before it
  useEffect(() => {
    if (minDate) {
      const currentDate = new Date(currentYear, currentMonth, 1);
      if (currentDate < minDate) {
        setCurrentYear(minDate.getFullYear());
        setCurrentMonth(minDate.getMonth());
        setWeekStart(getWeekStart(minDate));
      }
    }
  }, [minDate]); // Only run when minDate changes (when store loads)

  // Load schedule settings from store
  useEffect(() => {
    if (!store) return;
    
    const settings = (store as { frequency_settings?: unknown }).frequency_settings as {
      interval?: string;
      count?: number;
      preferredDays?: number[];
      preferredTimes?: string[];
    } | null | undefined;
    
    if (settings) {
      if (settings.preferredDays) {
        // Convert JS day format (Sun=0, Mon=1, ..., Sat=6) to our index format (Mon=0, ..., Sun=6)
        const ourIndices = settings.preferredDays.map((jsDay) => jsDayToIndex(jsDay));
        const newSelectedDays = new Set(ourIndices);
        
        // Validate against plan limits
        const validation = validateSelectedDays(newSelectedDays, planName);
        if (validation.valid) {
          setSelectedDays(newSelectedDays);
          setDayValidationError(null);
        } else {
          // If saved days don't match plan, use plan defaults
          const defaultDays = new Set<number>();
          for (let i = 0; i < Math.min(planFrequencyConfig.maxDays, 7); i++) {
            defaultDays.add(i);
          }
          setSelectedDays(defaultDays);
          setDayValidationError(validation.error || null);
        }
      }
      
      if (settings.preferredTimes?.[0]) {
        const time = settings.preferredTimes[0];
        const [hours, minutes] = time.split(':').map(Number);
        setPublishTime(`${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`);
      }
    }
    
  }, [store, storeId, planName, planFrequencyConfig]);
  
  // Check for conflicts when date is selected
  useEffect(() => {
    if (!selectedDate || !storeId || !selectedPostForSchedule) return;
    
    const checkConflicts = async () => {
      setCheckingConflicts(true);
      try {
        const [hours, minutes] = publishTime.split(':').map(Number);
        const scheduledDateTime = new Date(selectedDate);
        scheduledDateTime.setHours(hours, minutes, 0, 0);
        
        // Call conflict detection API
        try {
          const data = await postsApi.checkScheduleConflicts(
            storeId,
            selectedPostForSchedule.id,
            scheduledDateTime.toISOString()
          );
          
          if (data.conflicts && data.conflicts.length > 0) {
            const conflictMap = new Map<string, Array<{ type: string; severity: string; message: string }>>();
            const dateKey = selectedDate.toISOString().split('T')[0];
            conflictMap.set(dateKey, data.conflicts.map((c) => ({
              type: c.conflictType,
              severity: c.severity,
              message: c.severity === 'high' 
                ? 'High priority conflict detected. Consider rescheduling.'
                : c.severity === 'medium'
                ? 'Potential conflict. Review before scheduling.'
                : 'Minor conflict detected.',
            })));
            setConflicts(conflictMap);
          } else {
            setConflicts(new Map());
          }
        } catch (error) {
          console.error('Failed to check conflicts:', error);
          setConflicts(new Map());
        }
      } catch (error) {
        console.error('Failed to check conflicts:', error);
      } finally {
        setCheckingConflicts(false);
      }
    };
    
    checkConflicts();
  }, [selectedDate, publishTime, storeId, selectedPostForSchedule]);

  const handlePreviousMonth = useCallback(() => {
    setCurrentMonth((prev) => {
      if (prev === 0) {
        const newYear = currentYear - 1;
        const newMonth = 11;
        // Check if new date is before min date
        if (minDate) {
          const newDate = new Date(newYear, newMonth, 1);
          if (newDate < minDate) {
            return prev; // Don't allow going before install date
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
        // Check if new date is after max date
        if (maxDate) {
          const newDate = new Date(newYear, newMonth, 1);
          if (newDate > maxDate) {
            return prev; // Don't allow going beyond +12 months
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
      newDate.setDate(newDate.getDate() - 7);
      // Check if new date is before min date
      if (minDate && newDate < minDate) {
        return prev; // Don't allow going before install date
      }
      return newDate;
    });
  }, [minDate]);

  const handleNextWeek = useCallback(() => {
    setWeekStart((prev) => {
      const newDate = new Date(prev);
      newDate.setDate(newDate.getDate() + 7);
      // Check if new date is after max date
      if (maxDate) {
        const weekEnd = new Date(newDate);
        weekEnd.setDate(weekEnd.getDate() + 6);
        if (weekEnd > maxDate) {
          return prev; // Don't allow going beyond +12 months
        }
      }
      return newDate;
    });
  }, [maxDate]);

  const handleDayToggle = useCallback((dayIndex: number) => {
    setSelectedDays((prev) => {
      const next = new Set(prev);
      if (next.has(dayIndex)) {
        next.delete(dayIndex);
      } else {
        // Check if adding this day would exceed the limit
        if (next.size >= planFrequencyConfig.maxDays) {
          setDayValidationError(
            `You can only select up to ${planFrequencyConfig.maxDays} day${planFrequencyConfig.maxDays > 1 ? 's' : ''} for your plan (${planFrequencyConfig.displayName})`
          );
          return prev; // Don't add the day
        }
        next.add(dayIndex);
      }
      
      // Validate the new selection
      const validation = validateSelectedDays(next, planName);
      if (validation.valid) {
        setDayValidationError(null);
      } else {
        setDayValidationError(validation.error || null);
      }
      
      return next;
    });
  }, [planName, planFrequencyConfig]);

  const handleSaveSettings = useCallback(async () => {
    if (!storeId) return;
    
    // Validate days before saving
    const validation = validateSelectedDays(selectedDays, planName);
    if (!validation.valid) {
      setDayValidationError(validation.error || 'Invalid day selection');
      return;
    }
    
    setIsSaving(true);
    setDayValidationError(null);
    
    try {
      const [hours, minutes] = publishTime.split(':').map(Number);
      const timeString = `${hours}:${minutes.toString().padStart(2, '0')}`;
      
      // Get frequency settings based on plan (without timezone)
      const frequencySettings = getFrequencySettings(planName, selectedDays, [timeString]);
      
      // Update store frequency_settings via Supabase
      const { error: updateError } = await supabase
        .from('stores')
        .update({ 
          frequency_settings: frequencySettings,
        })
        .eq('id', storeId);
      
      if (updateError) {
        throw new Error(updateError.message);
      }
      
      // Invalidate store cache so Dashboard and other pages get updated data
      queryClient.invalidateQueries({ queryKey: queryKeys.store(shopDomain ?? '') });
      await refetchStore();
      
      showToast('Schedule settings saved successfully', { isError: false });
    } catch (error) {
      console.error('[Schedule] Failed to save settings:', error);
      const errorMessage = formatAPIErrorMessage(error, { action: 'save schedule settings', resource: 'schedule' });
      handleError(error instanceof Error ? error : new Error(errorMessage));
      showToast(errorMessage, { isError: true });
    } finally {
      setIsSaving(false);
    }
  }, [storeId, planName, selectedDays, publishTime, refetchStore, handleError, shopDomain, queryClient, showToast]);

  const handlePostClick = useCallback(() => {
    navigate('/posts');
  }, [navigate]);

  const handleDayClick = useCallback((date: Date) => {
    setSelectedDate(date);
    // Find draft posts that can be scheduled
    const draftPosts = allPosts.filter((p) => p.status === 'draft');
    if (draftPosts.length > 0) {
      setSelectedPostForSchedule(draftPosts[0]);
      setShowScheduleModal(true);
    } else {
      // Show message that no draft posts are available
      showToast('No articles are available to schedule right now. Articles are automatically generated based on your publishing schedule.', { isError: false });
    }
  }, [allPosts, showToast]);

  const handleSchedulePost = useCallback(async () => {
    if (!selectedPostForSchedule || !selectedDate) return;

    const [hours, minutes] = publishTime.split(':').map(Number);
    const scheduledDateTime = new Date(selectedDate);
    scheduledDateTime.setHours(hours, minutes, 0, 0);

    // Check for conflicts before scheduling
    const dateKey = selectedDate.toISOString().split('T')[0];
    const dayConflicts = conflicts.get(dateKey);
    const hasHighConflict = dayConflicts?.some((c) => c.severity === 'high');
    
    if (hasHighConflict) {
      const proceed = confirm(
        'High priority conflict detected for this time slot. Do you want to schedule anyway?'
      );
      if (!proceed) return;
    }

    schedulePostMutation.mutate({
      postId: selectedPostForSchedule.id,
      scheduledAt: scheduledDateTime.toISOString(),
    });
  }, [selectedPostForSchedule, selectedDate, publishTime, schedulePostMutation, conflicts]);

  const monthName = useMemo(() => {
    return new Date(currentYear, currentMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }, [currentYear, currentMonth]);

  const weekRange = useMemo(() => {
    return `Week of ${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }, [weekStart]);

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const dayLabels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  // Loading state
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

  // Error state
  if (isError && error && !store) {
    return (
      <div className="h-screen overflow-hidden bg-gray-50">
        <main className="h-full overflow-y-auto bg-gray-50">
          <div className="p-4 sm:p-6 lg:p-8">
            <div className="bg-red-50 border border-red-200 rounded-xl p-6 max-w-2xl mx-auto">
              <h2 className="text-lg font-semibold text-red-900 mb-2">Setup Required</h2>
              <p className="text-sm text-red-700 mb-4">
                {formatAPIErrorMessage(error, { action: 'load schedule', resource: 'schedule' })}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => window.location.reload()}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
                >
                  Refresh Page
                </button>
                <button
                  onClick={() => {
                    refetchStore();
                    refetchPosts();
                  }}
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
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              onClick={() => navigate('/dashboard')}
              className="text-gray-600 hover:text-gray-900 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 rounded"
              aria-label="Back to dashboard"
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
            {/* Calendar View */}
            <div className="lg:col-span-3 bg-white rounded-xl border border-gray-200 shadow-sm min-w-0">
              <div className="p-3 sm:p-4 md:p-5 lg:p-6 border-b border-gray-200">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 md:gap-4">
                  <h2 className="text-sm sm:text-base md:text-lg font-semibold text-gray-900">Calendar View</h2>
                  <div className="flex items-center gap-1.5 sm:gap-2">
                    <button
                      onClick={() => setViewMode('month')}
                      className={`px-2.5 sm:px-3 py-1 sm:py-1.5 text-[11px] sm:text-xs md:text-sm font-medium rounded-lg touch-manipulation transition-colors ${
                        viewMode === 'month'
                          ? 'bg-purple-600 text-white'
                          : 'text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      Month
                    </button>
                    <button
                      onClick={() => setViewMode('week')}
                      className={`px-2.5 sm:px-3 py-1 sm:py-1.5 text-[11px] sm:text-xs md:text-sm font-medium rounded-lg touch-manipulation transition-colors ${
                        viewMode === 'week'
                          ? 'bg-purple-600 text-white'
                          : 'text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      Week
                    </button>
                    <button
                      onClick={() => setViewMode('list')}
                      className={`px-2.5 sm:px-3 py-1 sm:py-1.5 text-[11px] sm:text-xs md:text-sm font-medium rounded-lg touch-manipulation transition-colors ${
                        viewMode === 'list'
                          ? 'bg-purple-600 text-white'
                          : 'text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      List
                    </button>
                  </div>
                </div>
              </div>
              <div className="p-3 sm:p-4 md:p-5 lg:p-6 overflow-x-auto">
                {/* Month View */}
                {viewMode === 'month' && (
                  <div>
                    {/* Month Navigation */}
                    <div className="mb-3 sm:mb-4 flex items-center justify-between gap-2">
                      <button
                        onClick={handlePreviousMonth}
                        disabled={minDate ? new Date(currentYear, currentMonth, 1) <= minDate : false}
                        className="p-1.5 sm:p-2 hover:bg-gray-100 rounded-lg touch-manipulation transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="Previous month"
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
                        >
                          Today
                        </button>
                      </div>
                      <button
                        onClick={handleNextMonth}
                        disabled={maxDate ? new Date(currentYear, currentMonth + 1, 1) > maxDate : false}
                        className="p-1.5 sm:p-2 hover:bg-gray-100 rounded-lg touch-manipulation transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="Next month"
                      >
                        <svg className="w-4 h-4 sm:w-5 sm:h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>

                    {/* Legend */}
                    <div className="mb-3 sm:mb-4 flex flex-wrap items-center gap-2 sm:gap-3 md:gap-4 text-[10px] sm:text-xs">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded bg-green-500 border-2 border-green-600"></div>
                        <span className="text-gray-600">Published</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded bg-purple-500 border-2 border-purple-600"></div>
                        <span className="text-gray-600">Scheduled</span>
                      </div>
                    </div>

                    {/* Day Headers */}
                    <div className="grid grid-cols-7 gap-0.5 sm:gap-1 md:gap-2 mb-1 sm:mb-2">
                      {dayNames.map((day) => (
                        <div key={day} className="text-center text-[10px] sm:text-xs font-semibold text-gray-500 py-1 sm:py-2">
                          {day}
                        </div>
                      ))}
                    </div>

                    {/* Calendar Grid */}
                    <div className="grid grid-cols-7 gap-1 sm:gap-1 md:gap-2 min-w-0">
                      {monthCalendar.map((day, index) => {
                        const hasPublished = day.posts.some((p) => p.status === 'published');
                        const hasScheduled = day.posts.some((p) => p.status === 'scheduled');
                        const borderColor = hasPublished
                          ? 'border-green-500 bg-green-50'
                          : hasScheduled
                          ? 'border-purple-500 bg-purple-50'
                          : day.isToday
                          ? 'border-orange-500 bg-orange-50'
                          : 'border-gray-200';
                        const textColor = hasPublished
                          ? 'text-green-900'
                          : hasScheduled
                          ? 'text-purple-900'
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
                            className={`aspect-square p-1.5 sm:p-2 border-2 ${borderColor} ${conflictBorder} rounded-lg cursor-pointer hover:opacity-80 transition-all touch-manipulation relative group shadow-sm ${
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
                                      : 'bg-gray-600 text-white'
                                  }`}
                                >
                                  {day.posts.length}
                                </span>
                              )}
                            </div>
                            {day.posts.length > 0 && (
                              <div className="mt-0.5 sm:mt-1">
                                <div className={`text-[9px] sm:text-[10px] font-medium ${hasPublished ? 'text-green-700' : 'text-purple-700'}`}>
                                  {formatTime(day.posts[0].scheduledAt)}
                                </div>
                                <div
                                  className={`text-[9px] sm:text-[10px] truncate hidden sm:block ${
                                    hasPublished ? 'text-green-600' : 'text-purple-600'
                                  }`}
                                >
                                  {day.posts[0].title.length > 20 ? `${day.posts[0].title.substring(0, 20)}...` : day.posts[0].title}
                                </div>
                              </div>
                            )}
                            {day.isToday && day.posts.length === 0 && (
                              <div className="text-[9px] sm:text-[10px] text-orange-700 font-medium mt-0.5">Today</div>
                            )}
                            {hasConflict && (
                              <div className={`absolute top-1 right-1 w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${
                                hasHighConflict ? 'bg-red-500' : 'bg-orange-500'
                              }`} title={dayConflicts?.map((c) => c.message).join(', ')}></div>
                            )}
                            {/* Tooltip */}
                            {day.posts.length > 0 && (
                              <div className="absolute z-10 hidden group-hover:block bottom-full left-1/2 transform -translate-x-1/2 mb-2 w-40 sm:w-48 p-2 bg-gray-900 text-white text-[10px] sm:text-xs rounded-lg shadow-xl">
                                <p className="font-semibold">{day.posts[0].title}</p>
                                <p className="text-gray-300 mt-1">
                                  {day.posts[0].status === 'published' ? 'Published' : 'Scheduled'} for {formatTime(day.posts[0].scheduledAt)}
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

                {/* Week View */}
                {viewMode === 'week' && (
                  <div>
                    <div className="mb-4 flex items-center justify-between">
                      <button
                        onClick={handlePreviousWeek}
                        disabled={minDate ? weekStart <= minDate : false}
                        className="p-2 hover:bg-gray-100 rounded-lg touch-manipulation transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="Previous week"
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
                        >
                          Today
                        </button>
                      </div>
                      <button
                        onClick={handleNextWeek}
                        disabled={maxDate ? (() => {
                          const weekEnd = new Date(weekStart);
                          weekEnd.setDate(weekEnd.getDate() + 6);
                          return weekEnd >= maxDate;
                        })() : false}
                        className="p-2 hover:bg-gray-100 rounded-lg touch-manipulation transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        aria-label="Next week"
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
                            <p className={`text-sm font-medium mt-1 ${isToday ? 'text-orange-900' : 'text-gray-900'}`}>
                              {day.dayNumber}
                            </p>
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
                            className={`p-3 ${
                              post.status === 'published' ? 'bg-green-50 border-l-4 border-green-500' : 'bg-purple-50 border-l-4 border-purple-500'
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
                                    : 'bg-purple-100 text-purple-800'
                                }`}
                              >
                                {post.status === 'published' ? 'Published' : 'Scheduled'}
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {/* List View */}
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
                          return (
                            <div
                              key={post.id}
                              className={`p-3 ${
                                isPublished ? 'bg-green-50 border-l-4 border-green-500' : 'bg-purple-50 border-l-4 border-purple-500'
                              } rounded-lg cursor-pointer hover:opacity-80 transition-opacity`}
                              onClick={handlePostClick}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex-1">
                                  <p className="text-xs text-gray-500">{formatDate(postDate)}</p>
                                  <p className="text-sm font-semibold text-gray-900 mt-1">{post.title}</p>
                                  <p className="text-xs text-gray-600 mt-1">
                                    {isPublished ? 'Published' : 'Scheduled'} at {formatTime(postDate)}
                                  </p>
                                </div>
                                <span
                                  className={`px-2 py-1 text-xs font-medium rounded-full ${
                                    isPublished ? 'bg-green-100 text-green-800' : 'bg-purple-100 text-purple-800'
                                  }`}
                                >
                                  {isPublished ? 'Published' : 'Scheduled'}
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

            {/* Sidebar */}
            <div className="lg:col-span-2 space-y-3 sm:space-y-4 md:space-y-5 lg:space-y-6 min-w-0">
              {/* Articles Queue */}
              {storeId && (
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
                  <div className="p-3 sm:p-4 md:p-5 lg:p-6">
                    <ArticlesQueue 
                      storeId={storeId} 
                      showTitle={true} 
                      selectedDays={selectedDays}
                      publishTime={publishTime}
                    />
                  </div>
                </div>
              )}

              {/* Schedule Settings */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
                <div className="p-3 sm:p-4 md:p-5 lg:p-6 border-b border-gray-200">
                  <h2 className="text-sm sm:text-base md:text-lg font-semibold text-gray-900">Schedule Settings</h2>
                </div>
                <div className="p-3 sm:p-4 md:p-5 lg:p-6">
                  <div className="space-y-3 sm:space-y-4 md:space-y-5 lg:space-y-6">
                    <div>
                      <label className="flex items-center gap-2 text-xs sm:text-sm font-medium text-gray-700 mb-2">
                        Publishing Frequency
                        <HelpIcon content={`Your plan allows ${planFrequencyConfig.maxDays} article${planFrequencyConfig.maxDays > 1 ? 's' : ''} per ${planFrequencyConfig.displayName.toLowerCase()}. You can choose which days to publish within this limit.`} />
                      </label>
                      <div className="w-full px-3 py-2.5 sm:py-2 border border-gray-200 bg-gray-50 rounded-lg text-sm text-gray-700">
                        {planFrequencyConfig.displayName}
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        Frequency is determined by your plan. You can select which days to publish.
                      </p>
                    </div>
                    <div>
                      <label className="flex items-center gap-2 text-xs sm:text-sm font-medium text-gray-700 mb-2">
                        Publishing Days
                        <span className="ml-1 text-gray-500 font-normal">
                          ({selectedDays.size} of {planFrequencyConfig.maxDays} selected)
                        </span>
                        <HelpIcon content={`Select which days of the week you want articles to publish. Your plan allows up to ${planFrequencyConfig.maxDays} day${planFrequencyConfig.maxDays > 1 ? 's' : ''} per ${planFrequencyConfig.displayName.toLowerCase()}.`} />
                      </label>
                      <div className="space-y-2">
                        {dayLabels.map((label, index) => {
                          // index is 0-6 where 0=Monday, 6=Sunday
                          const isDisabled = !selectedDays.has(index) && selectedDays.size >= planFrequencyConfig.maxDays;
                          return (
                            <label 
                              key={index} 
                              className={`flex items-center touch-manipulation ${
                                isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
                              }`}
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
                        <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                          {dayValidationError}
                        </div>
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
                    >
                      {isSaving ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>

        {/* Schedule Article Modal */}
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
                    value={publishTime}
                    onChange={(e) => setPublishTime(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none"
                  />
                </div>
                {selectedDate && checkingConflicts && (
                  <div className="text-xs text-gray-500">Checking for conflicts...</div>
                )}
                {selectedDate && conflicts.has(selectedDate.toISOString().split('T')[0]) && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                    <p className="text-xs font-semibold text-yellow-900 mb-1">Conflict Detected</p>
                    {conflicts.get(selectedDate.toISOString().split('T')[0])?.map((conflict, idx) => (
                      <p key={idx} className={`text-xs ${
                        conflict.severity === 'high' ? 'text-red-700' : 
                        conflict.severity === 'medium' ? 'text-orange-700' : 
                        'text-yellow-700'
                      }`}>
                        {conflict.message}
                      </p>
                    ))}
                  </div>
                )}
                <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 pt-4">
                  <button
                    onClick={() => {
                      setShowScheduleModal(false);
                      setSelectedPostForSchedule(null);
                      setSelectedDate(null);
                    }}
                    className="flex-1 px-3 sm:px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors touch-manipulation"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSchedulePost}
                    disabled={schedulePostMutation.isPending}
                    className="flex-1 px-3 sm:px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation"
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

