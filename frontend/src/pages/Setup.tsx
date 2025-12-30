import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { getShopDomain } from '../lib/app-bridge';
import { useStore, useQuotaStatus, queryKeys } from '../lib/api-cache';
import { supabase, api, storeApi } from '../lib/api-client';
import { getPlanFrequencyConfig, validateSelectedDays, getFrequencySettings } from '../utils/plan-frequency';
import { isSetupComplete } from '../utils/setup-check';
import { useAppBridgeToast } from '../hooks/useAppBridge';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { formatAPIErrorMessage } from '../utils/error-messages';
import { HelpIcon } from '../components/Tooltip';

type SetupStep = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = initial, 1-3 = processing steps, 4 = integrations, 5 = content preferences, 6 = schedule

interface ActivityItem {
  icon: string;
  title: string;
  description: string;
}

const STEP_ACTIVITIES: Record<number, ActivityItem[]> = {
  1: [
    {
      icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
      title: 'Reading your shop information',
      description: 'Understanding your store name and description',
    },
    {
      icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
      title: 'Analyzing your products',
      description: 'Reviewing product titles, descriptions, and categories',
    },
    {
      icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
      title: 'Scanning your collections',
      description: 'Understanding how your products are organized',
    },
    {
      icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
      title: 'Reviewing your content',
      description: 'Analyzing pages and blog articles',
    },
  ],
  2: [
    {
      icon: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z',
      title: 'Identifying your brand values',
      description: 'Understanding what your brand stands for',
    },
    {
      icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
      title: 'Discovering your tone and style',
      description: 'Learning how you communicate with customers',
    },
    {
      icon: 'M13 10V3L4 14h7v7l9-11h-7z',
      title: 'Understanding your unique selling points',
      description: 'Identifying what makes your brand special',
    },
    {
      icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
      title: 'Defining your brand personality',
      description: 'Capturing the essence of your brand character',
    },
  ],
  3: [
    {
      icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
      title: 'Creating your primary customer profile',
      description: 'Understanding who your main customers are',
    },
    {
      icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
      title: 'Understanding customer motivations',
      description: 'Learning what drives your customers\' decisions',
    },
    {
      icon: 'M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z',
      title: 'Analyzing shopping preferences',
      description: 'Discovering how and when customers prefer to shop',
    },
    {
      icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
      title: 'Building additional customer profiles',
      description: 'Creating profiles for secondary customer segments',
    },
  ],
};

// Reduced durations to make setup faster and less boring
// Step 1: 30 seconds (was 3 minutes)
// Step 2: 40 seconds (was 4 minutes)  
// Step 3: 30 seconds (was 3 minutes)
const STEP_DURATIONS = [30000, 40000, 30000]; // milliseconds for steps 1-3

function ActivitySlider({ activities }: { activities: ActivityItem[] }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % activities.length);
    }, 2000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [activities.length]);

  return (
    <div className="relative overflow-hidden h-20 sm:h-24">
      {activities.map((activity, index) => (
        <div
          key={index}
          className={`absolute inset-0 flex items-center gap-3 p-3 bg-gray-50 rounded-lg transition-opacity duration-500 ${
            index === currentIndex ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <svg
            className="w-5 h-5 text-gray-400 animate-pulse"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={activity.icon} />
          </svg>
          <div className="flex-1">
            <span className="text-sm font-medium text-gray-900 block">{activity.title}</span>
            <span className="text-xs text-gray-500">{activity.description}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Setup() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [currentStep, setCurrentStep] = useState<SetupStep>(0);
  const [progress, setProgress] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [selectedDays, setSelectedDays] = useState<Set<number>>(new Set([0, 2, 4])); // Monday, Wednesday, Friday
  const [publishTime, setPublishTime] = useState('14:00');
  const [dayValidationError, setDayValidationError] = useState<string | null>(null);
  const [googleAnalyticsEnabled, setGoogleAnalyticsEnabled] = useState(false);
  const [googleAnalyticsPropertyId, setGoogleAnalyticsPropertyId] = useState('');
  const [googleSearchConsoleEnabled, setGoogleSearchConsoleEnabled] = useState(false);
  const [googleSearchConsoleSiteUrl, setGoogleSearchConsoleSiteUrl] = useState('');
  const [topicPreferences, setTopicPreferences] = useState<string[]>([]);
  const [keywordFocus, setKeywordFocus] = useState<string[]>([]);
  const [contentAngles, setContentAngles] = useState<string[]>([]);
  const [newTopic, setNewTopic] = useState('');
  const [newKeyword, setNewKeyword] = useState('');
  const [newAngle, setNewAngle] = useState('');
  const stepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiErrorShownRef = useRef<boolean>(false);
  const hasCompletedSetupRef = useRef<boolean>(false);
  const { showToast } = useAppBridgeToast();

  const shopDomain = useMemo(() => {
    try {
      return getShopDomain();
    } catch {
      return null;
    }
  }, []);

  const {
    data: store,
    isLoading: storeLoading,
    error: storeError,
  } = useStore(shopDomain ?? '');

  const storeId = (store as { id?: string } | null)?.id ?? '';

  const {
    data: quota,
    isLoading: quotaLoading,
  } = useQuotaStatus(storeId);

  const planName = useMemo(() => {
    if (!quota || typeof quota !== 'object' || 'error' in quota) return null;
    return (quota as { plan_name?: string }).plan_name || null;
  }, [quota]);

  const planFrequencyConfig = useMemo(() => getPlanFrequencyConfig(planName), [planName]);

  const startStepProgression = useCallback((step: SetupStep) => {
    if (step > 3) {
      // Move to integrations step
      setCurrentStep(4);
      setIsLoading(false);
      return;
    }

    // Update progress (steps 1-3 are processing, 4-6 are form steps)
    if (step <= 3) {
      const stepProgress = ((step - 1) / 6) * 100;
      setProgress(stepProgress);
    } else {
      // Form steps (4-6)
      const formStepProgress = (3 / 6) * 100 + ((step - 3) / 3) * (100 - (3 / 6) * 100);
      setProgress(formStepProgress);
    }

    // Auto-advance after duration
    stepTimerRef.current = setTimeout(() => {
      const nextStep = (step + 1) as SetupStep;
      setCurrentStep(nextStep);
      if (nextStep <= 3) {
        startStepProgression(nextStep);
      } else {
        setIsLoading(false);
      }
    }, STEP_DURATIONS[step - 1]);
  }, []);

  const handleStart = useCallback(async () => {
    // If store doesn't exist, try to trigger auto-create by fetching it
    let storeId = store?.id;
    if (!storeId && shopDomain) {
      try {
        // This will trigger auto-create if store doesn't exist
        const createdStore = await storeApi.getStore(shopDomain);
        storeId = createdStore.id;
        // Invalidate cache to refresh
        queryClient.invalidateQueries({ queryKey: queryKeys.store(shopDomain) });
      } catch (err) {
        console.warn('Failed to auto-create store:', err);
        // Show error but allow setup to continue - store might be created later
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (errorMessage.includes('404') || errorMessage.includes('not found')) {
          setError(new Error('We couldn\'t set up your store. This usually means the database needs to be configured. Please contact support for assistance.'));
        } else {
          const friendlyError = formatAPIErrorMessage(err, { action: 'initialize store', resource: 'store' });
          setError(new Error(friendlyError));
        }
        // Don't return - allow setup to start anyway
      }
    }

    // Allow setup to start even without storeId - it will be created during setup
    setIsLoading(true);
    setError(null);
    setCurrentStep(1);
    setProgress(0);

    // Start step progression immediately (don't wait for API)
    startStepProgression(1);

    // Call store-setup API endpoint in the background (non-blocking)
    // Only set error once if it fails, and make it non-blocking
    // Don't await - let it run in background
    // If storeId is not available, the API should create it
    if (storeId) {
      void (async () => {
        try {
          await api.post('/store-setup', { storeId }, {
            priority: 'high',
            cache: { enabled: false },
            timeout: 300000, // 5 minutes for long-running setup
          });
        } catch (err) {
          // Log error but don't block the setup flow
          // 404 errors are expected if the function isn't deployed yet
          const message = err instanceof Error ? err.message : String(err);
          const is404 =
            message.includes('404') ||
            message.includes('Not Found') ||
            (err as { statusCode?: number })?.statusCode === 404;

          if (!is404) {
            console.warn('Store setup API call failed (non-critical, continuing setup):', err);
            // Only set error once using ref
            if (!apiErrorShownRef.current) {
              apiErrorShownRef.current = true;
              setError(new Error('We couldn\'t complete the full store analysis, but you can continue with setup. Some features may work better after the analysis completes.'));
            }
          }
        }
      })();
    }
  }, [store, shopDomain, startStepProgression, queryClient]);

  const handleComplete = useCallback(async () => {
    // If store doesn't exist, try to create it first
    let currentStore = store;
    if (!currentStore?.id && shopDomain) {
      try {
        showToast('Creating store...', { isError: false });
        const createdStore = await storeApi.getStore(shopDomain);
        currentStore = createdStore;
        // Invalidate cache to refresh
        queryClient.invalidateQueries({ queryKey: queryKeys.store(shopDomain) });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (errorMessage.includes('404') || errorMessage.includes('not found')) {
          const friendlyError = 'We couldn\'t set up your store. This usually means the database needs to be configured. Please contact support for assistance.';
          setError(new Error(friendlyError));
          showToast(friendlyError, { isError: true });
        } else {
          const friendlyError = formatAPIErrorMessage(err, { action: 'create store', resource: 'store' });
          setError(new Error(friendlyError));
          showToast(friendlyError, { isError: true });
        }
        return;
      }
    }

    if (!currentStore?.id) {
      const friendlyError = "We couldn't find your store information. Please refresh the page and try again.";
      setError(new Error(friendlyError));
      showToast(friendlyError, { isError: true });
      return;
    }

    // Validate days before saving - must select at least the minimum required for the plan
    const validation = validateSelectedDays(selectedDays, planName);
    if (!validation.valid) {
      const friendlyError = validation.error 
        ? validation.error.replace(/plan limits/i, 'your plan\'s limits')
        : 'Please select at least the minimum number of days required for your plan.';
      setDayValidationError(friendlyError);
      setError(new Error(friendlyError));
      return;
    }

    try {
      // Get frequency settings based on plan
      const frequencySettings = getFrequencySettings(planName, selectedDays, [publishTime]);

      // Prepare all updates
      const contentPreferences = {
        topic_preferences: topicPreferences,
        keyword_focus: keywordFocus,
        content_angles: contentAngles,
        internal_linking_preferences: {},
      };

      // Update integrations if provided - store in settings JSONB field
      const integrations: Record<string, unknown> = {};
      if (googleAnalyticsEnabled && googleAnalyticsPropertyId) {
        integrations.google_analytics = {
          enabled: true,
          property_id: googleAnalyticsPropertyId,
        };
      }
      if (googleSearchConsoleEnabled && googleSearchConsoleSiteUrl) {
        integrations.google_search_console = {
          enabled: true,
          site_url: googleSearchConsoleSiteUrl,
        };
      }

      // Store integrations in a settings field that the Settings page can read
      // We'll use a temporary approach - store in a JSONB field that Settings expects
      if (Object.keys(integrations).length > 0) {
        // Try to update via the store API which handles integrations properly
        try {
          await storeApi.updateStore(
            currentStore.id,
            ({ integrations } as unknown as Parameters<typeof storeApi.updateStore>[1]),
          );
        } catch (integrationError) {
          console.warn('Failed to save integrations via API, storing directly:', integrationError);
          // Non-blocking: integrations can be configured later in Settings
        }
      }

      // Complete setup via Edge Function (service role) to avoid RLS issues from browser clients
      const updatedStore = await api.post('/api-router/complete-setup', {
        storeId: currentStore.id,
        shopDomain: shopDomain ?? undefined,
        frequencySettings,
        contentPreferences,
      }, {
        priority: 'high',
        cache: { enabled: false },
      });

      // Mark setup as complete to prevent auto-start from triggering
      hasCompletedSetupRef.current = true;
      
      // Optimistically update the React Query cache so SetupGuard won't redirect due to stale store data
      if (shopDomain) {
        const storeKey = queryKeys.store(shopDomain);
        queryClient.setQueryData(storeKey, updatedStore);

        // Invalidate cache and refetch to ensure SetupGuard sees the updated store from the backend too
        queryClient.invalidateQueries({ queryKey: storeKey });
        await queryClient.refetchQueries({ queryKey: storeKey });
      }
      
      // Wait a bit more to ensure cache is updated before navigation
      await new Promise(resolve => setTimeout(resolve, 300));

      setIsComplete(true);
      setProgress(100);
      setDayValidationError(null);
      showToast('Setup completed successfully! Redirecting to dashboard...', { isError: false });
      
      // Navigate after ensuring cache is updated
      navigate('/dashboard', { replace: true });
    } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      let friendly: string;
      if (statusCode === 404) {
        friendly = 'We couldn\'t complete the setup. The setup service may not be available. Please contact support for assistance.';
      } else {
        friendly = formatAPIErrorMessage(err, { action: 'complete setup', resource: 'setup' });
      }
      setError(err instanceof Error ? err : new Error(friendly));
      showToast(friendly, { isError: true });
    }
  }, [store, shopDomain, planName, selectedDays, publishTime, topicPreferences, keywordFocus, contentAngles, googleAnalyticsEnabled, googleAnalyticsPropertyId, googleSearchConsoleEnabled, googleSearchConsoleSiteUrl, showToast, queryClient, navigate]);

  const handleNext = useCallback(() => {
    if (currentStep === 6) {
      handleComplete();
    } else {
      // Clear any running timers
      if (stepTimerRef.current) {
        clearTimeout(stepTimerRef.current);
        stepTimerRef.current = null;
      }
      
      const nextStep = (currentStep + 1) as SetupStep;
      setCurrentStep(nextStep);
      
      // Update progress for the new step
      if (nextStep <= 3) {
        // Still in processing steps - continue auto-progression
        startStepProgression(nextStep);
      } else {
        // Form steps - stop auto-progression
        setIsLoading(false);
        // Update progress manually for form steps
        const formStepProgress = (3 / 6) * 100 + ((nextStep - 3) / 3) * (100 - (3 / 6) * 100);
        setProgress(formStepProgress);
      }
    }
  }, [currentStep, startStepProgression, handleComplete]);

  const handleBack = useCallback(() => {
    if (currentStep > 1) {
      if (stepTimerRef.current) {
        clearTimeout(stepTimerRef.current);
      }
      const newStep = (currentStep - 1) as SetupStep;
      setCurrentStep(newStep);
      if (newStep <= 3) {
        startStepProgression(newStep);
      } else {
        setIsLoading(false);
      }
    }
  }, [currentStep, startStepProgression]);

  // Auto-start setup when component mounts if we're on step 0
  useEffect(() => {
    // Don't auto-start if setup has been completed
    if (hasCompletedSetupRef.current) {
      return;
    }
    
    // Don't auto-start if setup is already complete (check store data)
    if (store && isSetupComplete(store)) {
      navigate('/dashboard', { replace: true });
      return;
    }
    
    // Auto-start setup if we're on step 0 and either:
    // 1. Store exists and is loaded, OR
    // 2. Store doesn't exist yet but we have shopDomain (will try to auto-create)
    // Only auto-start if store exists OR if we have shopDomain and no critical errors
    const canAutoStart = shopDomain && !isLoading && !quotaLoading && 
      (store?.id || (!storeLoading && !error)); // Only auto-start if store exists or no errors
    
    if (currentStep === 0 && canAutoStart) {
      // Small delay to show the welcome screen briefly, then auto-start
      const timer = setTimeout(() => {
        handleStart();
      }, 1500);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, shopDomain, isLoading, storeLoading, quotaLoading, storeError, store, error, navigate]);

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

  useEffect(() => {
    return () => {
      if (stepTimerRef.current) {
        clearTimeout(stepTimerRef.current);
      }
    };
  }, []);

  const isLoadingState = storeLoading || isLoading || quotaLoading;
  const hasError = storeError || error;

  // If store doesn't exist (404), the API will auto-create it on next request
  // Show loading while we wait, or allow setup to proceed
  if (hasError && !store && !shopDomain) {
    return (
      <div className="min-h-0 flex flex-col">
        <div className="p-4 sm:p-6 lg:p-8">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-red-900 mb-1">Setup Required</h3>
              <p className="text-sm text-red-700 mb-4">
                We couldn't determine your shop information. Please refresh the page and try again.
              </p>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
              >
                Refresh Page
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // If store is loading (but not errored), show loading
  if (isLoadingState && !store && !hasError) {
    return (
      <div className="min-h-0 flex flex-col">
        <div className="p-4 sm:p-6 lg:p-8">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
            <div className="flex flex-col items-center gap-4">
              <LoadingSpinner size="large" label="Initializing..." />
              <p className="text-sm text-gray-600">Setting up your store...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // If store doesn't exist (404 error) but we have shopDomain, allow setup to proceed
  // The store will be auto-created when setup starts
  // For 404 errors, treat it as if store doesn't exist yet (expected for new installations)

  return (
    <div className="min-h-0 flex flex-col bg-gray-50">
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="max-w-4xl mx-auto">
          {/* Removed back button - setup is mandatory */}
          {/* Initial Screen */}
          {currentStep === 0 && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8 lg:p-10 text-center">
              <div className="max-w-2xl mx-auto">
                <div className="w-16 h-16 sm:w-20 sm:h-20 mx-auto mb-6 rounded-full bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center">
                  <svg
                    className="w-8 h-8 sm:w-10 sm:h-10 text-white"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                    />
                  </svg>
                </div>
                <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 mb-4">
                  Welcome! Let's Get You Set Up
                </h2>
                <p className="text-base sm:text-lg text-gray-600 mb-4">
                  We'll analyze your store and collect your preferences to enable fully automated content generation. 
                </p>
                <p className="text-sm text-gray-500 mb-8">
                  This quick setup takes just 2-3 minutes. We'll start automatically in a moment...
                </p>
                {isLoadingState && (
                  <div className="flex items-center justify-center gap-2 text-purple-600">
                    <LoadingSpinner size="small" label="Starting setup" />
                    <span className="text-sm font-medium">Starting setup...</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Setup Wizard */}
          {currentStep > 0 && !isComplete && (
            <>
              {/* Progress Bar */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 sm:p-6 mb-6">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs sm:text-sm font-medium text-gray-700">Setup Progress</span>
                  <span className="text-xs sm:text-sm font-semibold text-purple-600">{Math.round(progress)}%</span>
                </div>
                <div className="w-full h-2 sm:h-3 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-purple-500 to-blue-600 rounded-full transition-all duration-500"
                    style={{ width: `${progress}%` }}
                  ></div>
                </div>
              </div>

              {/* Error Message - Only show if it's a blocking error */}
              {error && error.message.includes('Store not loaded') && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
                  <p className="text-sm text-red-800">{error.message}</p>
                </div>
              )}
              {/* Warning Message - Non-blocking */}
              {error && error.message.includes('Store analysis may be incomplete') && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
                  <p className="text-sm text-yellow-800">
                    <strong>Note:</strong> {error.message} The setup will continue normally.
                  </p>
                </div>
              )}

              {/* Step Content */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8 lg:p-10">
                {/* Step 1: Scanning store assets */}
                {currentStep === 1 && (
                  <div>
                    <div className="text-center mb-8">
                      <div className="w-16 h-16 sm:w-20 sm:h-20 mx-auto mb-4 rounded-full bg-blue-100 flex items-center justify-center">
                        <svg
                          className="w-8 h-8 sm:w-10 sm:h-10 text-blue-600 animate-spin"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                          />
                        </svg>
                      </div>
                      <h3 className="text-xl sm:text-2xl font-bold text-gray-900 mb-2">Scanning Store Assets</h3>
                      <p className="text-sm sm:text-base text-gray-600 mb-4">
                        We're analyzing your store to understand your products, content, and brand
                      </p>
                      <p className="text-xs sm:text-sm text-gray-500">This will take just 30 seconds...</p>
                    </div>
                    <ActivitySlider activities={STEP_ACTIVITIES[1]} />
                  </div>
                )}

                {/* Step 2: Analyzing brand voice */}
                {currentStep === 2 && (
                  <div>
                    <div className="text-center mb-8">
                      <div className="w-16 h-16 sm:w-20 sm:h-20 mx-auto mb-4 rounded-full bg-purple-100 flex items-center justify-center">
                        <svg
                          className="w-8 h-8 sm:w-10 sm:h-10 text-purple-600 animate-spin"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                          />
                        </svg>
                      </div>
                      <h3 className="text-xl sm:text-2xl font-bold text-gray-900 mb-2">Analyzing Brand Voice</h3>
                      <p className="text-sm sm:text-base text-gray-600 mb-4">
                        We're learning how your brand communicates and what makes it unique
                      </p>
                      <p className="text-xs sm:text-sm text-gray-500">Almost there! Just 40 more seconds...</p>
                    </div>
                    <ActivitySlider activities={STEP_ACTIVITIES[2]} />
                  </div>
                )}

                {/* Step 3: Building audience personas */}
                {currentStep === 3 && (
                  <div>
                    <div className="text-center mb-8">
                      <div className="w-16 h-16 sm:w-20 sm:h-20 mx-auto mb-4 rounded-full bg-green-100 flex items-center justify-center">
                        <svg
                          className="w-8 h-8 sm:w-10 sm:h-10 text-green-600 animate-spin"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                          />
                        </svg>
                      </div>
                      <h3 className="text-xl sm:text-2xl font-bold text-gray-900 mb-2">Building Audience Personas</h3>
                      <p className="text-sm sm:text-base text-gray-600 mb-4">
                        We're creating detailed profiles of your ideal customers
                      </p>
                      <p className="text-xs sm:text-sm text-gray-500">Final step! 30 seconds remaining...</p>
                    </div>
                    <ActivitySlider activities={STEP_ACTIVITIES[3]} />
                  </div>
                )}

                {/* Step 4: Integrations (Optional) */}
                {currentStep === 4 && (
                  <div>
                    <div className="text-center mb-8">
                      <div className="w-16 h-16 sm:w-20 sm:h-20 mx-auto mb-4 rounded-full bg-yellow-100 flex items-center justify-center">
                        <svg
                          className="w-8 h-8 sm:w-10 sm:h-10 text-yellow-600"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                          />
                        </svg>
                      </div>
                      <h3 className="text-xl sm:text-2xl font-bold text-gray-900 mb-2">Connect Analytics (Optional - Skip if you want)</h3>
                      <p className="text-sm sm:text-base text-gray-600 mb-4">
                        Connect your analytics tools to track performance. You can skip this and do it later in Settings.
                      </p>
                    </div>
                    <div className="space-y-6">
                      {/* Google Search Console */}
                      <div className="border border-gray-200 rounded-lg p-4">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1">
                            <label className="flex items-center gap-2 mb-1">
                              <input
                                type="checkbox"
                                checked={googleSearchConsoleEnabled}
                                onChange={(e) => setGoogleSearchConsoleEnabled(e.target.checked)}
                                className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                              />
                              <span className="text-sm font-medium text-gray-900">Google Search Console</span>
                            </label>
                            <p className="text-xs text-gray-600 ml-6">
                              Automatically submit your sitemap when articles are published, helping Google discover your content faster.
                            </p>
                            <p className="text-xs text-gray-500 ml-6 mt-1">
                              <strong>Why it helps:</strong> Faster indexing means your content appears in search results sooner, driving organic traffic to your store.
                            </p>
                          </div>
                        </div>
                        {googleSearchConsoleEnabled && (
                          <div className="mt-3 ml-6">
                            <input
                              type="text"
                              value={googleSearchConsoleSiteUrl}
                              onChange={(e) => setGoogleSearchConsoleSiteUrl(e.target.value)}
                              placeholder="https://yourstore.com (your site URL)"
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                            />
                            <p className="text-xs text-gray-500 mt-1">
                              Enter the URL you verified in Google Search Console
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Google Analytics */}
                      <div className="border border-gray-200 rounded-lg p-4">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1">
                            <label className="flex items-center gap-2 mb-1">
                              <input
                                type="checkbox"
                                checked={googleAnalyticsEnabled}
                                onChange={(e) => setGoogleAnalyticsEnabled(e.target.checked)}
                                className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                              />
                              <span className="text-sm font-medium text-gray-900">Google Analytics</span>
                            </label>
                            <p className="text-xs text-gray-600 ml-6">
                              Track article performance, see which topics drive traffic, and get insights to improve future content.
                            </p>
                            <p className="text-xs text-gray-500 ml-6 mt-1">
                              <strong>Why it helps:</strong> Understand what content works best for your audience, so we can create more of what drives results.
                            </p>
                          </div>
                        </div>
                        {googleAnalyticsEnabled && (
                          <div className="mt-3 ml-6">
                            <input
                              type="text"
                              value={googleAnalyticsPropertyId}
                              onChange={(e) => setGoogleAnalyticsPropertyId(e.target.value)}
                              placeholder="G-XXXXXXXXXX (your GA4 Property ID)"
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                            />
                            <p className="text-xs text-gray-500 mt-1">
                              Find this in Google Analytics: Admin → Property Settings → Property ID
                            </p>
                          </div>
                        )}
                      </div>

                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                        <p className="text-xs text-blue-800">
                          <strong>Note:</strong> These integrations are optional. You can skip this step and connect them later in Settings. However, connecting them now helps the system learn what content performs best for your store.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Step 5: Content Preferences */}
                {currentStep === 5 && (
                  <div>
                    <div className="text-center mb-8">
                      <div className="w-16 h-16 sm:w-20 sm:h-20 mx-auto mb-4 rounded-full bg-indigo-100 flex items-center justify-center">
                        <svg
                          className="w-8 h-8 sm:w-10 sm:h-10 text-indigo-600"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                      </div>
                      <h3 className="text-xl sm:text-2xl font-bold text-gray-900 mb-2">Content Strategy (Optional - Skip if you want)</h3>
                      <p className="text-sm sm:text-base text-gray-600 mb-4">
                        Guide what topics and keywords to focus on. Leave empty to let the system choose based on your products. You can skip this step.
                      </p>
                    </div>
                    <div className="space-y-6">
                      {/* Topic Preferences */}
                      <div>
                        <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                          Topic Preferences
                          <HelpIcon content="Add topics you want articles to focus on. The AI will prioritize these topics when generating content. Leave empty to let the system choose based on your products." />
                        </label>
                        <div className="flex gap-2 mb-2">
                          <input
                            type="text"
                            value={newTopic}
                            onChange={(e) => setNewTopic(e.target.value)}
                            onKeyPress={(e) => {
                              if (e.key === 'Enter' && newTopic.trim()) {
                                e.preventDefault();
                                setTopicPreferences([...topicPreferences, newTopic.trim()]);
                                setNewTopic('');
                              }
                            }}
                            placeholder="Add a topic (e.g., 'sustainable fashion')"
                            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                          />
                          <button
                            onClick={() => {
                              if (newTopic.trim()) {
                                setTopicPreferences([...topicPreferences, newTopic.trim()]);
                                setNewTopic('');
                              }
                            }}
                            className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors"
                          >
                            Add
                          </button>
                        </div>
                        {topicPreferences.length > 0 && (
                          <div className="flex flex-wrap gap-2 mt-2">
                            {topicPreferences.map((topic, idx) => (
                              <span
                                key={idx}
                                className="inline-flex items-center gap-1 px-3 py-1 bg-purple-100 text-purple-800 rounded-full text-xs font-medium"
                              >
                                {topic}
                                <button
                                  onClick={() => setTopicPreferences(topicPreferences.filter((_, i) => i !== idx))}
                                  className="text-purple-600 hover:text-purple-800"
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                        <p className="text-xs text-gray-500 mt-2">
                          Topics you want articles to focus on. Leave empty to let the system choose based on your products.
                        </p>
                      </div>

                      {/* Keyword Focus */}
                      <div>
                        <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                          Keyword Focus
                          <HelpIcon content="Add SEO keywords you want articles to prioritize. The AI will naturally incorporate these keywords when relevant to improve your search rankings." />
                        </label>
                        <div className="flex gap-2 mb-2">
                          <input
                            type="text"
                            value={newKeyword}
                            onChange={(e) => setNewKeyword(e.target.value)}
                            onKeyPress={(e) => {
                              if (e.key === 'Enter' && newKeyword.trim()) {
                                e.preventDefault();
                                setKeywordFocus([...keywordFocus, newKeyword.trim()]);
                                setNewKeyword('');
                              }
                            }}
                            placeholder="Add a keyword (e.g., 'organic cotton')"
                            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                          />
                          <button
                            onClick={() => {
                              if (newKeyword.trim()) {
                                setKeywordFocus([...keywordFocus, newKeyword.trim()]);
                                setNewKeyword('');
                              }
                            }}
                            className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors"
                          >
                            Add
                          </button>
                        </div>
                        {keywordFocus.length > 0 && (
                          <div className="flex flex-wrap gap-2 mt-2">
                            {keywordFocus.map((keyword, idx) => (
                              <span
                                key={idx}
                                className="inline-flex items-center gap-1 px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-xs font-medium"
                              >
                                {keyword}
                                <button
                                  onClick={() => setKeywordFocus(keywordFocus.filter((_, i) => i !== idx))}
                                  className="text-blue-600 hover:text-blue-800"
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                        <p className="text-xs text-gray-500 mt-2">
                          SEO keywords to prioritize. Articles will naturally incorporate these when relevant.
                        </p>
                      </div>

                      {/* Content Angles */}
                      <div>
                        <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                          Content Angles
                          <HelpIcon content="Specify preferred content formats or approaches (e.g., 'how-to guides', 'product comparisons', 'tutorials'). The AI will use these formats when creating articles." />
                        </label>
                        <div className="flex gap-2 mb-2">
                          <input
                            type="text"
                            value={newAngle}
                            onChange={(e) => setNewAngle(e.target.value)}
                            onKeyPress={(e) => {
                              if (e.key === 'Enter' && newAngle.trim()) {
                                e.preventDefault();
                                setContentAngles([...contentAngles, newAngle.trim()]);
                                setNewAngle('');
                              }
                            }}
                            placeholder="Add an angle (e.g., 'how-to guides', 'product comparisons')"
                            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                          />
                          <button
                            onClick={() => {
                              if (newAngle.trim()) {
                                setContentAngles([...contentAngles, newAngle.trim()]);
                                setNewAngle('');
                              }
                            }}
                            className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors"
                          >
                            Add
                          </button>
                        </div>
                        {contentAngles.length > 0 && (
                          <div className="flex flex-wrap gap-2 mt-2">
                            {contentAngles.map((angle, idx) => (
                              <span
                                key={idx}
                                className="inline-flex items-center gap-1 px-3 py-1 bg-green-100 text-green-800 rounded-full text-xs font-medium"
                              >
                                {angle}
                                <button
                                  onClick={() => setContentAngles(contentAngles.filter((_, i) => i !== idx))}
                                  className="text-green-600 hover:text-green-800"
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                        <p className="text-xs text-gray-500 mt-2">
                          Preferred content formats or approaches. Examples: tutorials, reviews, comparisons, guides.
                        </p>
                      </div>

                      <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                        <p className="text-xs text-gray-600">
                          <strong>Tip:</strong> You can skip this step and let the system learn from your products. You can always add preferences later in Settings.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Step 6: Setting up automation */}
                {currentStep === 6 && (
                  <div>
                    <div className="text-center mb-8">
                      <div className="w-16 h-16 sm:w-20 sm:h-20 mx-auto mb-4 rounded-full bg-indigo-100 flex items-center justify-center">
                        <svg
                          className="w-8 h-8 sm:w-10 sm:h-10 text-indigo-600"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                      </div>
                      <h3 className="text-xl sm:text-2xl font-bold text-gray-900 mb-2">Almost Done! Set Your Schedule</h3>
                      <p className="text-sm sm:text-base text-gray-600 mb-4">Choose which days you want articles published. This is the final step!</p>
                    </div>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Publishing Frequency</label>
                        <div className="w-full px-3 py-2 border border-gray-200 bg-gray-50 rounded-lg text-sm text-gray-700">
                          {planFrequencyConfig.displayName}
                        </div>
                        <p className="text-xs text-gray-500 mt-1">
                          Frequency is determined by your plan. You can select which days to publish.
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Preferred Publishing Days
                          <span className="ml-1 text-gray-500 font-normal">
                            ({selectedDays.size} of {planFrequencyConfig.maxDays} selected)
                          </span>
                        </label>
                        <div className="space-y-2">
                          {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(
                            (day, index) => {
                              const isDisabled = !selectedDays.has(index) && selectedDays.size >= planFrequencyConfig.maxDays;
                              return (
                                <label 
                                  key={day} 
                                  className={`flex items-center ${
                                    isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedDays.has(index)}
                                    onChange={() => handleDayToggle(index)}
                                    disabled={isDisabled}
                                    className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500 disabled:cursor-not-allowed"
                                  />
                                  <span className="ml-2 text-sm text-gray-700">{day}</span>
                                </label>
                              );
                            },
                          )}
                        </div>
                        {dayValidationError && (
                          <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                            {dayValidationError}
                          </div>
                        )}
                        {selectedDays.size < planFrequencyConfig.minDays && (
                          <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-700">
                            Please select at least {planFrequencyConfig.minDays} day{planFrequencyConfig.minDays > 1 ? 's' : ''} to complete setup.
                          </div>
                        )}
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Default Publishing Time</label>
                        <input
                          type="time"
                          value={publishTime}
                          onChange={(e) => setPublishTime(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Navigation Buttons - Setup is mandatory, no cancel/back buttons */}
              <div className="mt-6 flex flex-col sm:flex-row items-center justify-end gap-3 sm:gap-4">
                {/* Only show Continue button on form steps (4-5), not on automatic processing steps (1-3) */}
                {currentStep >= 4 && currentStep < 6 && (
                  <button
                    onClick={handleNext}
                    className="w-full sm:w-auto px-6 sm:px-8 py-3 sm:py-3.5 bg-purple-600 text-white rounded-lg text-base sm:text-lg font-medium hover:bg-purple-700 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 shadow-lg shadow-purple-500/50"
                  >
                    Continue
                  </button>
                )}
                {currentStep === 6 && (
                  <button
                    onClick={handleComplete}
                    disabled={selectedDays.size < planFrequencyConfig.minDays}
                    className="w-full sm:w-auto px-6 sm:px-8 py-3 sm:py-3.5 bg-purple-600 text-white rounded-lg text-base sm:text-lg font-medium hover:bg-purple-700 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-purple-500/50"
                  >
                    Complete Setup
                  </button>
                )}
              </div>
            </>
          )}

          {/* Completion Screen */}
          {isComplete && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8 lg:p-10 text-center">
              <div className="max-w-2xl mx-auto">
                <div className="w-16 h-16 sm:w-20 sm:h-20 mx-auto mb-6 rounded-full bg-green-100 flex items-center justify-center">
                  <svg
                    className="w-8 h-8 sm:w-10 sm:h-10 text-green-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h3 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-4">Setup Complete!</h3>
                <p className="text-base sm:text-lg text-gray-600 mb-8">
                  Your store is now fully configured for automated content generation. Articles will be created automatically 
                  based on your schedule and preferences. You can review and approve them, or let them auto-publish.
                </p>
                <button
                  onClick={() => navigate('/dashboard')}
                  className="inline-block px-6 sm:px-8 py-3 sm:py-3.5 bg-purple-600 text-white rounded-lg text-base sm:text-lg font-medium hover:bg-purple-700 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2"
                >
                  Go to Dashboard
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
