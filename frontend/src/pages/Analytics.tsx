import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getShopDomain } from '../lib/app-bridge';
import { useStore, queryKeys } from '../lib/api-cache';
import { analyticsApi, supabase } from '../lib/api-client';
import { formatAPIErrorMessage } from '../utils/error-messages';
import { HelpIcon } from '../components/Tooltip';

type DateRange = '7d' | '30d' | '90d' | '1y';

interface AnalyticsData {
  totalImpressions: number;
  totalClicks: number;
  avgCTR: number;
  avgPosition: number;
  topPosts: Array<{
    post_id: string;
    impressions: number;
    clicks: number;
    ctr: number;
    blog_posts: {
      title: string;
    } | null;
  }>;
}


function formatNumber(num: number): string {
  return new Intl.NumberFormat('en-US').format(num);
}

function formatPercentage(num: number): string {
  return `${(num * 100).toFixed(1)}%`;
}

function calculateDateRange(range: DateRange): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  
  switch (range) {
    case '7d':
      start.setDate(start.getDate() - 7);
      break;
    case '30d':
      start.setDate(start.getDate() - 30);
      break;
    case '90d':
      start.setDate(start.getDate() - 90);
      break;
    case '1y':
      start.setFullYear(start.getFullYear() - 1);
      break;
  }
  
  return {
    start: start.toISOString().split('T')[0]!,
    end: end.toISOString().split('T')[0]!,
  };
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-xl p-4 sm:p-5 lg:p-6 border border-gray-200 shadow-sm animate-pulse">
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <div className="h-4 bg-gray-200 rounded w-24 mb-2"></div>
          <div className="h-8 bg-gray-200 rounded w-32 mb-2"></div>
          <div className="h-4 bg-gray-200 rounded w-16"></div>
        </div>
        <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg bg-gray-200"></div>
      </div>
    </div>
  );
}


export default function Analytics() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dateRange, setDateRange] = useState<DateRange>('30d');
  const [gscConnected, setGscConnected] = useState(false);
  const [checkingConnections, setCheckingConnections] = useState(true);
  const [integrationCheckError, setIntegrationCheckError] = useState<string | null>(null);
  const lastCheckTimeRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  
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

  const storeId = store?.id ?? '';
  const dateRangeParams = useMemo(() => calculateDateRange(dateRange), [dateRange]);

  // Check integration connection status
  useEffect(() => {
    if (!storeId) {
      setCheckingConnections(false);
      return;
    }

    const checkIntegrations = async () => {
      try {
        const gscResult = await supabase
          .from('analytics_integrations')
          .select('id')
          .eq('store_id', storeId)
          .eq('integration_type', 'google_search_console')
          .eq('is_active', true)
          .maybeSingle();

        setGscConnected(!!gscResult.data);
        
        // Invalidate analytics query if connection status changed
        queryClient.invalidateQueries({ queryKey: queryKeys.analytics(storeId) });
      } catch (error) {
        console.error('Error checking integrations:', error);
        setIntegrationCheckError('Failed to check integration status. Please refresh the page.');
        setGscConnected(false);
      } finally {
        setCheckingConnections(false);
      }
    };

    checkIntegrations();

    // Refresh connections when page becomes visible (e.g., user returns from Settings)
    const handleVisibilityChange = () => {
      if (!document.hidden && storeId) {
        checkIntegrations();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [storeId, queryClient]);

  const {
    data: analyticsData,
    isLoading: analyticsLoading,
    error: analyticsError,
  } = useQuery<AnalyticsData>({
    queryKey: queryKeys.analytics(storeId, dateRangeParams),
    queryFn: async () => {
      if (!storeId) throw new Error('Store ID is required');
      const response = await analyticsApi.getMetrics(storeId, dateRangeParams);
      return response as AnalyticsData;
    },
    enabled: !!storeId && !checkingConnections,
    staleTime: 60000,
    gcTime: 300000,
  });

  const handleDateRangeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setDateRange(e.target.value as DateRange);
  }, []);

  const handlePostClick = useCallback(() => {
    navigate('/posts');
  }, [navigate]);

  const isLoading = storeLoading || analyticsLoading || checkingConnections;
  const error = storeError || analyticsError;
  
  // All metrics shown are from GSC, so lock if GSC is not connected
  const isLocked = !gscConnected;

  if (error && !store) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-red-900 mb-1">Setup Required</h3>
            <p className="text-sm text-red-700 mb-4">
              We couldn't determine your shop information. Please refresh the page and try again.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 transition-colors"
            >
              Refresh Page
            </button>
          </div>
        </div>
      </div>
    );
  }

  const totalImpressions = analyticsData?.totalImpressions ?? 0;
  const totalClicks = analyticsData?.totalClicks ?? 0;
  const avgCTR = analyticsData?.avgCTR ?? 0;
  // Handle avgPosition: null/undefined means no data, 0 or negative is invalid, use null as sentinel
  const avgPositionRaw = analyticsData?.avgPosition;
  const avgPosition = avgPositionRaw != null && avgPositionRaw > 0 && avgPositionRaw < 100 ? avgPositionRaw : null;
  const topPosts = analyticsData?.topPosts ?? [];
  
  // Check if we have any real data (not just zeros)
  const hasAnalyticsData = analyticsData && (
    totalImpressions > 0 || 
    totalClicks > 0 || 
    avgCTR > 0 || 
    (avgPosition != null) ||
    topPosts.length > 0
  );

  return (
    <div className="min-h-0 flex flex-col">
      <header className="bg-white border-b border-gray-200 px-4 sm:px-6 lg:px-8 py-4 sm:py-5 lg:py-6 flex-shrink-0">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
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
              <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-gray-900">Analytics</h1>
              <p className="text-xs sm:text-sm text-gray-500 mt-1">Track your article performance and engagement</p>
            </div>
          </div>
          <select
            value={dateRange}
            onChange={handleDateRangeChange}
            className="px-3 sm:px-4 py-2 border border-gray-300 rounded-lg text-xs sm:text-sm text-gray-700 w-full sm:w-auto touch-manipulation focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 transition-colors"
            aria-label="Select time period"
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="1y">This year</option>
          </select>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        {/* Integration Check Error Banner */}
        {integrationCheckError && (
          <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-xl p-4 sm:p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                <svg className="w-5 h-5 sm:w-6 sm:h-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm sm:text-base font-semibold text-yellow-900 mb-1">
                  Connection Status Check Failed
                </h3>
                <p className="text-xs sm:text-sm text-yellow-800 mb-3">
                  {integrationCheckError}
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-yellow-600 text-white text-sm font-medium rounded-lg hover:bg-yellow-700 transition-colors focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:ring-offset-2"
                >
                  Refresh Page
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Analytics Error Banner */}
        {analyticsError && store && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-xl p-4 sm:p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                <svg className="w-5 h-5 sm:w-6 sm:h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm sm:text-base font-semibold text-red-900 mb-1">
                  Failed to Load Analytics Data
                </h3>
                <p className="text-xs sm:text-sm text-red-800 mb-3">
                  {formatAPIErrorMessage(analyticsError, { action: 'load analytics', resource: 'analytics' })}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => queryClient.invalidateQueries({ queryKey: queryKeys.analytics(storeId, dateRangeParams) })}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                  >
                    Retry
                  </button>
                  <button
                    onClick={() => window.location.reload()}
                    className="inline-flex items-center gap-2 px-4 py-2 border border-red-300 text-red-700 text-sm font-medium rounded-lg hover:bg-red-50 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                  >
                    Refresh Page
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Connection Status Banner */}
        {!checkingConnections && isLocked && (
          <div className="mb-6 bg-blue-50 border border-blue-200 rounded-xl p-4 sm:p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                <svg className="w-5 h-5 sm:w-6 sm:h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm sm:text-base font-semibold text-blue-900 mb-1">
                  Connect Google Search Console to View Analytics
                </h3>
                <p className="text-xs sm:text-sm text-blue-800 mb-3">
                  Connect Google Search Console to unlock detailed analytics including impressions, clicks, CTR, and search position for your articles.
                </p>
                <button
                  onClick={() => navigate('/settings')}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-blue-50"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Go to Settings
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5 lg:gap-6 mb-6 sm:mb-8">
          {isLoading ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : (
            <>
              <div className={`bg-white rounded-xl p-4 sm:p-5 lg:p-6 border shadow-sm relative ${isLocked ? 'border-gray-200 opacity-60' : 'border-gray-200'}`}>
                {isLocked && (
                  <div className="absolute inset-0 bg-gray-50/80 rounded-xl flex items-center justify-center z-10">
                    <div className="text-center px-4">
                      <svg className="w-6 h-6 sm:w-8 sm:h-8 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                      <p className="text-xs text-gray-500">Connect GSC</p>
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <p className="text-xs sm:text-sm text-gray-500">Total Impressions</p>
                      <HelpIcon content="Total number of times your articles appeared in Google search results during the selected time period." />
                    </div>
                    <p className={`text-2xl sm:text-3xl lg:text-4xl font-bold ${isLocked ? 'text-gray-400' : 'text-gray-900'}`}>
                      {isLocked ? '—' : formatNumber(totalImpressions)}
                    </p>
                  </div>
                  <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-lg flex items-center justify-center flex-shrink-0 ${isLocked ? 'bg-gray-100' : 'bg-blue-100'}`}>
                    <svg
                      className={`w-5 h-5 sm:w-6 sm:h-6 ${isLocked ? 'text-gray-400' : 'text-blue-600'}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                      />
                    </svg>
                  </div>
                </div>
              </div>

              <div className={`bg-white rounded-xl p-4 sm:p-5 lg:p-6 border shadow-sm relative ${isLocked ? 'border-gray-200 opacity-60' : 'border-gray-200'}`}>
                {isLocked && (
                  <div className="absolute inset-0 bg-gray-50/80 rounded-xl flex items-center justify-center z-10">
                    <div className="text-center px-4">
                      <svg className="w-6 h-6 sm:w-8 sm:h-8 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                      <p className="text-xs text-gray-500">Connect GSC</p>
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <p className="text-xs sm:text-sm text-gray-500">Total Clicks</p>
                      <HelpIcon content="Total number of clicks your articles received from Google search results. This shows how many people visited your articles from search." />
                    </div>
                    <p className={`text-2xl sm:text-3xl lg:text-4xl font-bold ${isLocked ? 'text-gray-400' : 'text-gray-900'}`}>
                      {isLocked ? '—' : formatNumber(totalClicks)}
                    </p>
                  </div>
                  <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-lg flex items-center justify-center flex-shrink-0 ${isLocked ? 'bg-gray-100' : 'bg-green-100'}`}>
                    <svg
                      className={`w-5 h-5 sm:w-6 sm:h-6 ${isLocked ? 'text-gray-400' : 'text-green-600'}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.25 8.718l3-3M12.75 5.25l-3 3m2.25.75l-3 3M18.75 8.25l-3 3m-2.25.75l-3 3m9-9l-3 3m-3-3l3 3"
                      />
                    </svg>
                  </div>
                </div>
              </div>

              <div className={`bg-white rounded-xl p-4 sm:p-5 lg:p-6 border shadow-sm relative ${isLocked ? 'border-gray-200 opacity-60' : 'border-gray-200'}`}>
                {isLocked && (
                  <div className="absolute inset-0 bg-gray-50/80 rounded-xl flex items-center justify-center z-10">
                    <div className="text-center px-4">
                      <svg className="w-6 h-6 sm:w-8 sm:h-8 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                      <p className="text-xs text-gray-500">Connect GSC</p>
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <p className="text-xs sm:text-sm text-gray-500">Average CTR</p>
                      <HelpIcon content="Click-Through Rate: The percentage of people who clicked on your articles after seeing them in search results. Higher CTR means your titles and descriptions are compelling." />
                    </div>
                    <p className={`text-2xl sm:text-3xl lg:text-4xl font-bold ${isLocked ? 'text-gray-400' : 'text-gray-900'}`}>
                      {isLocked ? '—' : formatPercentage(avgCTR)}
                    </p>
                  </div>
                  <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-lg flex items-center justify-center flex-shrink-0 ${isLocked ? 'bg-gray-100' : 'bg-purple-100'}`}>
                    <svg
                      className={`w-5 h-5 sm:w-6 sm:h-6 ${isLocked ? 'text-gray-400' : 'text-purple-600'}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                      />
                    </svg>
                  </div>
                </div>
              </div>

              <div className={`bg-white rounded-xl p-4 sm:p-5 lg:p-6 border shadow-sm relative ${isLocked ? 'border-gray-200 opacity-60' : 'border-gray-200'}`}>
                {isLocked && (
                  <div className="absolute inset-0 bg-gray-50/80 rounded-xl flex items-center justify-center z-10">
                    <div className="text-center px-4">
                      <svg className="w-6 h-6 sm:w-8 sm:h-8 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                      <p className="text-xs text-gray-500">Connect GSC</p>
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <p className="text-xs sm:text-sm text-gray-500">Average Position</p>
                      <HelpIcon content="Average ranking position of your articles in Google search results. Lower numbers are better (position 1 is the top result)." />
                    </div>
                    <p className={`text-2xl sm:text-3xl lg:text-4xl font-bold ${isLocked ? 'text-gray-400' : 'text-gray-900'}`}>
                      {isLocked ? '—' : (avgPosition > 0 && avgPosition < 100 ? avgPosition.toFixed(1) : '—')}
                    </p>
                  </div>
                  <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-lg flex items-center justify-center flex-shrink-0 ${isLocked ? 'bg-gray-100' : 'bg-orange-100'}`}>
                    <svg
                      className={`w-5 h-5 sm:w-6 sm:h-6 ${isLocked ? 'text-gray-400' : 'text-orange-600'}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M5 3h14l-1 9H6l-1-9zM5 3l-1 9m15-9l1 9M9 19.5v.75a2.25 2.25 0 01-4.5 0v-.75m9 0v.75a2.25 2.25 0 004.5 0v-.75M9 19.5h6m-6 0h-3m9 0h-3"
                      />
                    </svg>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-1 gap-4 sm:gap-5 lg:gap-6">
          <div className={`bg-white rounded-xl border shadow-sm relative ${isLocked ? 'border-gray-200 opacity-60' : 'border-gray-200'}`}>
            {isLocked && (
              <div className="absolute inset-0 bg-gray-50/80 rounded-xl flex items-center justify-center z-10">
                <div className="text-center px-4">
                  <svg className="w-8 h-8 sm:w-10 sm:h-10 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  <p className="text-sm text-gray-500">Connect GSC to view top articles</p>
                </div>
              </div>
            )}
            <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
              <h2 className="text-base sm:text-lg font-semibold text-gray-900">Top Articles</h2>
            </div>
            <div className="p-4 sm:p-5 lg:p-6">
              {isLoading ? (
                <div className="space-y-3 sm:space-y-4">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex items-start justify-between gap-2 animate-pulse">
                      <div className="flex-1 min-w-0">
                        <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
                        <div className="h-3 bg-gray-200 rounded w-1/2"></div>
                      </div>
                      <div className="h-4 bg-gray-200 rounded w-12"></div>
                    </div>
                  ))}
                </div>
              ) : isLocked ? (
                <div className="text-center py-8">
                  <p className="text-xs sm:text-sm text-gray-400">Connect Google Search Console to view top performing articles</p>
                </div>
              ) : !hasAnalyticsData && !analyticsLoading ? (
                <div className="text-center py-8">
                  <svg
                    className="w-12 h-12 sm:w-16 sm:h-16 text-gray-400 mx-auto mb-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                    />
                  </svg>
                  <p className="text-xs sm:text-sm text-gray-500 mb-2">No analytics data available</p>
                  <p className="text-xs text-gray-400">
                    Analytics data will appear here once your articles start receiving traffic from Google search.
                  </p>
                </div>
              ) : topPosts.length > 0 ? (
                <div className="space-y-3 sm:space-y-4">
                  {topPosts.slice(0, 4).map((post: AnalyticsData['topPosts'][0]) => {
                    const title = post.blog_posts?.title ?? 'Untitled Article';
                    const views = post.clicks ?? 0;
                    
                    return (
                      <div
                        key={post.post_id}
                        onClick={handlePostClick}
                        className="flex items-start justify-between gap-2 cursor-pointer hover:bg-gray-50 p-2 rounded-lg transition-colors -m-2"
                      >
                        <div className="flex-1 min-w-0">
                          <h4 className="text-xs sm:text-sm font-medium text-gray-900 truncate">
                            {title}
                          </h4>
                          <p className="text-xs text-gray-500 mt-1">
                            {formatNumber(views)} {views === 1 ? 'view' : 'views'}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-8">
                  <p className="text-xs sm:text-sm text-gray-400">No articles found</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
