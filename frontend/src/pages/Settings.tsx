import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { getShopDomain } from '../lib/app-bridge';
import { useStore, useQuotaStatus, queryKeys } from '../lib/api-cache';
import { supabase, googleOAuthApi } from '../lib/api-client';
import { useSettingsData, type SettingsData } from '../hooks/useSettingsData';
import { AppBridgeContextualSaveBar } from '../components/AppBridgeContextualSaveBar';
import { useAppBridge, useAppBridgeToast } from '../hooks/useAppBridge';
import PlansModal from '../components/PlansModal';
import { formatAPIErrorMessage } from '../utils/error-messages';
import { HelpIcon } from '../components/Tooltip';

function ToggleSwitch({
  checked,
  onChange,
  id,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
  ariaLabel?: string;
}) {
  return (
    <label className="relative inline-flex items-center cursor-pointer touch-manipulation" htmlFor={id}>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only peer"
        aria-label={ariaLabel}
      />
      <div className="w-10 h-5 sm:w-11 sm:h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-purple-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 sm:after:h-5 sm:after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
    </label>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
        <div className="h-6 bg-gray-200 rounded w-32 animate-pulse"></div>
      </div>
      <div className="p-4 sm:p-5 lg:p-6 space-y-4">
        <div className="h-10 bg-gray-200 rounded animate-pulse"></div>
        <div className="h-10 bg-gray-200 rounded animate-pulse"></div>
      </div>
    </div>
  );
}

export default function Settings() {
  const navigate = useNavigate();
  const appBridge = useAppBridge();
  const queryClient = useQueryClient();
  const shopDomain = useMemo(() => {
    try {
      return getShopDomain();
    } catch {
      return null;
    }
  }, []);

  const {
    data: storeRaw,
    isLoading: storeLoading,
    error: storeError,
  } = useStore(shopDomain ?? '');

  // Safety check: Unwrap if the store data is still wrapped in API response format
  const store = useMemo(() => {
    if (!storeRaw) return null;
    // Check if it's wrapped (has 'data' and 'correlationId' but not 'id' or 'shop_domain')
    if (typeof storeRaw === 'object' && 'data' in storeRaw && !('id' in storeRaw) && !('shop_domain' in storeRaw)) {
      console.warn('[Settings] Store data appears wrapped, unwrapping');
      return (storeRaw as { data: unknown }).data as typeof storeRaw;
    }
    return storeRaw;
  }, [storeRaw]);


  const storeId = store?.id ?? '';

  const {
    data: quota,
    isLoading: quotaLoading,
    error: quotaError,
    isError: quotaIsError,
  } = useQuotaStatus(storeId);


  const {
    settings,
    hasUnsavedChanges,
    isLoading: settingsLoading,
    isError: settingsError,
    error: settingsErrorObj,
    saveSettings,
    updateSettings,
    resetSettings,
    isSaving,
    saveError,
    saveSuccess,
    isOnline,
  } = useSettingsData({
    enableRealTime: true,
    autoSave: false,
    onError: useCallback((error: Error) => {
      console.error('Settings error:', error);
    }, []),
  });

  const { showToast } = useAppBridgeToast();

  // Local state for form fields
  const [requireApproval, setRequireApproval] = useState(false);
  const [defaultAuthor, setDefaultAuthor] = useState('');
  const [reviewWindowHours, setReviewWindowHours] = useState(24);
  const [emailNotificationsEnabled, setEmailNotificationsEnabled] = useState(true);
  const [emailArticlePublished, setEmailArticlePublished] = useState(true);
  const [emailArticleScheduled, setEmailArticleScheduled] = useState(true);
  const [googleAnalyticsEnabled, setGoogleAnalyticsEnabled] = useState(false);
  const [googleAnalyticsPropertyId, setGoogleAnalyticsPropertyId] = useState('');
  const [googleAnalyticsConnected, setGoogleAnalyticsConnected] = useState(false);
  const [googleSearchConsoleEnabled, setGoogleSearchConsoleEnabled] = useState(false);
  const [googleSearchConsoleSiteUrl, setGoogleSearchConsoleSiteUrl] = useState('');
  const [googleSearchConsoleConnected, setGoogleSearchConsoleConnected] = useState(false);
  const [isConnectingGoogle, setIsConnectingGoogle] = useState<string | null>(null);
  const [topicPreferences, setTopicPreferences] = useState<string[]>([]);
  const [keywordFocus, setKeywordFocus] = useState<string[]>([]);
  const [contentAngles, setContentAngles] = useState<string[]>([]);
  const [newTopic, setNewTopic] = useState('');
  const [newKeyword, setNewKeyword] = useState('');
  const [newAngle, setNewAngle] = useState('');
  const [isPlansModalOpen, setIsPlansModalOpen] = useState(false);

  // Check if integrations are connected
  useEffect(() => {
    if (!storeId) return;

    const checkIntegrations = async () => {
      try {
        const { data: ga4Integration, error: ga4Error } = await supabase
          .from('analytics_integrations')
          .select('id, is_active, credentials')
          .eq('store_id', storeId)
          .eq('integration_type', 'google_analytics_4')
          .eq('is_active', true)
          .maybeSingle();

        const { data: gscIntegration, error: gscError } = await supabase
          .from('analytics_integrations')
          .select('id, is_active, credentials')
          .eq('store_id', storeId)
          .eq('integration_type', 'google_search_console')
          .eq('is_active', true)
          .maybeSingle();

        if (ga4Error) {
          console.error('Error checking Google Analytics integration:', ga4Error);
        } else {
          setGoogleAnalyticsConnected(!!ga4Integration);
          if (ga4Integration?.credentials && typeof ga4Integration.credentials === 'object') {
            const credentials = ga4Integration.credentials as { property_id?: string };
            if (credentials.property_id) {
              setGoogleAnalyticsPropertyId(credentials.property_id);
            }
          }
        }

        if (gscError) {
          console.error('Error checking Google Search Console integration:', gscError);
        } else {
          setGoogleSearchConsoleConnected(!!gscIntegration);
          if (gscIntegration?.credentials && typeof gscIntegration.credentials === 'object') {
            const credentials = gscIntegration.credentials as { site_url?: string };
            if (credentials.site_url) {
              setGoogleSearchConsoleSiteUrl(credentials.site_url);
            }
          }
        }
      } catch (error) {
        console.error('Error checking integrations:', error);
        // Don't show toast for integration check errors as they're not critical
      }
    };

    checkIntegrations();
  }, [storeId]);

  // Handle OAuth callback redirect
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const connected = urlParams.get('connected');
    if (connected === 'google_analytics_4') {
      setGoogleAnalyticsConnected(true);
      setGoogleAnalyticsEnabled(true);
      showToast('Google Analytics connected successfully', { isError: false });
      window.history.replaceState({}, '', window.location.pathname);
    } else if (connected === 'google_search_console') {
      setGoogleSearchConsoleConnected(true);
      setGoogleSearchConsoleEnabled(true);
      showToast('Google Search Console connected successfully', { isError: false });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [showToast]);

  // Track if we've initialized to prevent overriding user changes
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize form values from settings and store (only once on mount)
  useEffect(() => {
    if (isInitialized) return; // Don't re-initialize if user has made changes

    if (settings) {
      // Initialize email notifications from settings
      if (settings.notifications?.email) {
        setEmailNotificationsEnabled(settings.notifications.email.enabled ?? true);
        setEmailArticlePublished(settings.notifications.email.article_published ?? true);
        setEmailArticleScheduled(settings.notifications.email.article_scheduled ?? true);
      }
    }
    if (store) {
      const storeData = store as {
        require_approval?: boolean;
        review_window_hours?: number;
        brand_safety_enabled?: boolean;
        content_preferences?: {
          topic_preferences?: string[];
          keyword_focus?: string[];
          content_angles?: string[];
          default_author?: string; // Added for default author
        };
        readonly shop_metadata?: {
          readonly name?: string;
          readonly shop_name?: string;
          readonly [key: string]: unknown;
        };
        readonly shop_domain?: string;
      };
      setRequireApproval(storeData.require_approval ?? false);

      let rawStoreName = storeData.shop_metadata?.name ||
        storeData.shop_metadata?.shop_name ||
        storeData.shop_domain ||
        'Authoria';

      // Clean up the name similar to Dashboard logic
      if (rawStoreName.includes('.')) {
        rawStoreName = rawStoreName.split('.')[0];
      }

      const storeName = rawStoreName
        .replace(/[-_]/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');

      const defaultAuthorValue = storeData.content_preferences?.default_author || `${storeName}'s Editorial`;
      setDefaultAuthor(defaultAuthorValue);

      setReviewWindowHours(storeData.review_window_hours ?? 24);
      setTopicPreferences(storeData.content_preferences?.topic_preferences || []);
      setKeywordFocus(storeData.content_preferences?.keyword_focus || []);
      setContentAngles(storeData.content_preferences?.content_angles || []);
    }

    if (settings || store) {
      setIsInitialized(true);
    }
  }, [settings, store, isInitialized]);

  // Initialize integration states after checking connections
  useEffect(() => {
    if (googleAnalyticsConnected) {
      setGoogleAnalyticsEnabled(true);
    }
    if (googleSearchConsoleConnected) {
      setGoogleSearchConsoleEnabled(true);
    }
  }, [googleAnalyticsConnected, googleSearchConsoleConnected]);


  const handleSave = useCallback(async () => {
    if (!store?.id) {
      showToast("We couldn't load your store information. Please refresh the page and try again.", { isError: true });
      return;
    }

    if (!isOnline) {
      showToast("You're currently offline. Please check your internet connection and try again.", { isError: true });
      return;
    }

    try {
      // Prepare settings updates (for notifications)
      // Brand safety is always enabled, so we always set it to true
      const updatedSettings: Partial<SettingsData> = {
        brand_safety_enabled: true,
        notifications: {
          ...settings?.notifications,
          email: {
            enabled: emailNotificationsEnabled,
            article_published: emailArticlePublished,
            article_scheduled: emailArticleScheduled,
          },
        },
      };

      // Update settings via the settings hook
      updateSettings(updatedSettings);

      // Update store-specific fields (approval settings and content preferences)
      // Brand safety is always enabled
      const { error: storeUpdateError } = await supabase
        .from('stores')
        .update({
          require_approval: requireApproval,
          review_window_hours: reviewWindowHours,
          brand_safety_enabled: true,
          content_preferences: {
            default_author: defaultAuthor,
            topic_preferences: topicPreferences,
            keyword_focus: keywordFocus,
            content_angles: contentAngles,
            internal_linking_preferences: {},
          },
        })
        .eq('id', store.id);

      if (storeUpdateError) {
        throw new Error(storeUpdateError.message);
      }

      // Invalidate store cache so Dashboard and other pages get updated data immediately
      queryClient.invalidateQueries({ queryKey: queryKeys.store(shopDomain ?? '') });

      // Save settings (this will update language_settings via storeApi.updateStore)
      // This also invalidates cache, but we do it explicitly above to ensure immediate sync
      saveSettings();

      showToast('Settings saved successfully', { isError: false });
    } catch (error) {
      console.error('Failed to save settings:', error);
      const errorMessage = formatAPIErrorMessage(error, { action: 'save settings', resource: 'settings' });
      showToast(errorMessage, { isError: true });
    }
  }, [
    store,
    settings,
    emailNotificationsEnabled,
    emailArticlePublished,
    emailArticleScheduled,
    requireApproval,
    reviewWindowHours,
    topicPreferences,
    keywordFocus,
    contentAngles,
    updateSettings,
    saveSettings,
    shopDomain,
    queryClient,
    showToast,
    isOnline,
  ]);

  // Track changes when form fields change
  const handleFieldChange = useCallback(
    (field: string, value: unknown) => {
      switch (field) {
        case 'google_analytics_enabled':
          setGoogleAnalyticsEnabled(value as boolean);
          // Integration state is UI-only; actual integration is managed via analytics_integrations table
          break;
        case 'google_analytics_property_id':
          setGoogleAnalyticsPropertyId(value as string);
          // Property ID is stored in analytics_integrations.credentials when connected
          break;
        case 'google_search_console_enabled':
          setGoogleSearchConsoleEnabled(value as boolean);
          // Integration state is UI-only; actual integration is managed via analytics_integrations table
          break;
        case 'google_search_console_site_url':
          setGoogleSearchConsoleSiteUrl(value as string);
          // Site URL is stored in analytics_integrations.credentials when connected
          break;
        case 'email_notifications_enabled':
          setEmailNotificationsEnabled(value as boolean);
          updateSettings({
            notifications: {
              ...settings?.notifications,
              email: {
                enabled: value as boolean,
                article_published: emailArticlePublished,
                article_scheduled: emailArticleScheduled,
              },
            },
          });
          break;
        case 'email_article_published':
          setEmailArticlePublished(value as boolean);
          updateSettings({
            notifications: {
              ...settings?.notifications,
              email: {
                enabled: emailNotificationsEnabled,
                article_published: value as boolean,
                article_scheduled: emailArticleScheduled,
              },
            },
          });
          break;
        case 'email_article_scheduled':
          setEmailArticleScheduled(value as boolean);
          updateSettings({
            notifications: {
              ...settings?.notifications,
              email: {
                enabled: emailNotificationsEnabled,
                article_published: emailArticlePublished,
                article_scheduled: value as boolean,
              },
            },
          });
          break;
      }
    },
    [
      settings,
      googleAnalyticsEnabled,
      googleAnalyticsPropertyId,
      googleSearchConsoleEnabled,
      googleSearchConsoleSiteUrl,
      emailNotificationsEnabled,
      emailArticlePublished,
      emailArticleScheduled,
      updateSettings,
    ],
  );

  const handleResetSettings = useCallback(async () => {
    if (!store?.id) {
      showToast("We couldn't load your store information. Please refresh the page and try again.", { isError: true });
      return;
    }

    if (!confirm('Are you sure you want to reset all settings to default values? This action cannot be undone.')) {
      return;
    }

    try {
      const { error } = await supabase
        .from('stores')
        .update({
          language_settings: { primary: 'en', enabled: ['en'] },
          frequency_settings: { interval: 'weekly', count: 2 },
          require_approval: false,
          review_window_hours: 24,
          content_preferences: {
            topic_preferences: [],
            keyword_focus: [],
            content_angles: [],
            internal_linking_preferences: {},
          },
        })
        .eq('id', store.id);

      if (error) {
        throw new Error(error.message);
      }

      resetSettings();
      showToast('Settings reset successfully. Reloading page...', { isError: false });
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch (error) {
      console.error('Failed to reset settings:', error);
      const errorMessage = formatAPIErrorMessage(error, { action: 'reset settings', resource: 'settings' });
      showToast(errorMessage, { isError: true });
    }
  }, [store, resetSettings, showToast]);

  const isLoading = storeLoading || settingsLoading || quotaLoading;
  const error = storeError || settingsErrorObj;


  // Format plan name for display
  const planName = useMemo(() => {
    if (quotaLoading) return 'Loading...';
    if (quotaIsError || quotaError) {
      console.error('[Settings] Quota error:', quotaError);
      return 'Error';
    }
    if (!quota) return 'No Plan';
    // Handle error case from backend
    if (typeof quota === 'object' && 'error' in quota && quota.error) {
      console.error('[Settings] Quota API error:', quota.error);
      return 'No Plan';
    }
    const name = quota.plan_name || 'Unknown';
    if (!name || name === 'Unknown') {
      return 'No Plan';
    }
    return name
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }, [quota, quotaLoading, quotaIsError, quotaError]);

  // Check if user has no active plan (no plan or not on trial)
  const hasNoActivePlan = useMemo(() => {
    if (quotaLoading || quotaIsError || !quota) return false;
    if (typeof quota === 'object' && 'error' in quota && quota.error) return true;
    const name = quota.plan_name || '';
    const isTrial = quota.is_trial || false;
    // No plan if plan_name is missing, unknown, or empty, and not on trial
    return (!name || name === 'Unknown' || name === 'unknown') && !isTrial;
  }, [quota, quotaLoading, quotaIsError]);

  // Format renewal date
  const renewalDate = useMemo(() => {
    if (quotaLoading || quotaIsError || !quota) return null;
    // Handle error case from backend
    if (typeof quota === 'object' && 'error' in quota && quota.error) {
      return null;
    }
    // If on trial, show trial end date
    if (quota.is_trial && quota.trial_ends_at) {
      return new Date(quota.trial_ends_at);
    }
    // For paid plans, renewal is typically monthly - show next month from now
    // In a real implementation, this would come from Shopify subscription data
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    return nextMonth;
  }, [quota, quotaLoading, quotaIsError]);

  const formatRenewalDate = useCallback((date: Date | null): string => {
    if (!date) return 'N/A';
    return date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  }, []);

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
              className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
            >
              Refresh Page
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex flex-col">
      <header className="bg-white border-b border-gray-200 px-4 sm:px-6 lg:px-8 py-4 sm:py-5 lg:py-6 flex-shrink-0">
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
            <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-gray-900">Settings</h1>
            <p className="text-xs sm:text-sm text-gray-500 mt-1">Manage your app preferences and configuration</p>
          </div>
        </div>
      </header>

      {/* App Bridge Contextual Save Bar */}
      <AppBridgeContextualSaveBar
        visible={hasUnsavedChanges}
        options={{
          saveAction: {
            onAction: handleSave,
            loading: isSaving,
            disabled: !isOnline,
          },
          discardAction: {
            onAction: () => {
              resetSettings();
              showToast('Changes discarded', { duration: 2000 });
            },
          },
        }}
      />

      {/* Legacy Contextual Save Bar (fallback) */}
      {hasUnsavedChanges && (
        <div className="bg-purple-600 text-white px-4 sm:px-6 lg:px-8 py-3 sm:py-4 flex items-center justify-between flex-shrink-0">
          <p className="text-sm font-medium">You have unsaved changes</p>
          <div className="flex items-center gap-3">
            <button
              onClick={resetSettings}
              disabled={isSaving}
              className="px-4 py-2 text-sm font-medium text-white hover:text-gray-200 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-purple-600 rounded disabled:opacity-50"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving || !isOnline}
              className="px-4 py-2 bg-white text-purple-600 text-sm font-medium rounded-md hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-purple-600 disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}

      {/* Success/Error Messages */}
      {saveSuccess && (
        <div className="bg-green-50 border-b border-green-200 px-4 sm:px-6 lg:px-8 py-3 flex-shrink-0">
          <p className="text-sm text-green-800">Settings saved successfully</p>
        </div>
      )}

      {saveError && (
        <div className="bg-red-50 border-b border-red-200 px-4 sm:px-6 lg:px-8 py-3 flex-shrink-0">
          <p className="text-sm text-red-800">
            {formatAPIErrorMessage(saveError, { action: 'save settings', resource: 'settings' })}
          </p>
        </div>
      )}

      {!isOnline && (
        <div className="bg-yellow-50 border-b border-yellow-200 px-4 sm:px-6 lg:px-8 py-3 flex-shrink-0">
          <p className="text-sm text-yellow-800">You are offline. Changes will be saved when you reconnect.</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        {isLoading ? (
          <div className="max-w-4xl mx-auto space-y-4 sm:space-y-5 lg:space-y-6">
            {[1, 2, 3, 4, 5].map((i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : (
          <div className="max-w-4xl mx-auto space-y-4 sm:space-y-5 lg:space-y-6">
            {/* Brand Setup */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                <h2 className="text-base sm:text-lg font-semibold text-gray-900">Brand Setup</h2>
              </div>
              <div className="p-4 sm:p-5 lg:p-6 space-y-4">
                <div>
                  <p className="text-xs sm:text-sm text-gray-700 mb-2">
                    Re-run the brand intelligence setup to update your brand voice, personas, and settings.
                  </p>
                  <button
                    onClick={() => navigate('/setup')}
                    className="inline-block px-4 sm:px-6 py-2.5 sm:py-3 bg-purple-600 text-white rounded-lg text-sm sm:text-base font-medium hover:bg-purple-700 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2"
                  >
                    Start Brand Setup
                  </button>
                </div>
              </div>
            </div>

            {/* Integrations */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                <h2 className="text-base sm:text-lg font-semibold text-gray-900">Integrations</h2>
              </div>
              <div className="p-4 sm:p-5 lg:p-6 space-y-4 sm:space-y-5">
                <div>
                  <label className="flex items-center justify-between gap-4 touch-manipulation mb-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-xs sm:text-sm font-medium text-gray-700">Google Analytics</p>
                        <HelpIcon content="Connect your Google Analytics 4 property to track article views, engagement, and performance metrics. This helps you understand which content resonates with your audience." />
                      </div>
                      <p className="text-xs text-gray-500">Track article performance with Google Analytics</p>
                    </div>
                    <ToggleSwitch
                      checked={googleAnalyticsEnabled}
                      onChange={(checked) => handleFieldChange('google_analytics_enabled', checked)}
                      id="googleAnalytics"
                      ariaLabel="Enable Google Analytics"
                    />
                  </label>
                  {googleAnalyticsEnabled && !googleAnalyticsConnected && (
                    <div className="ml-0 sm:ml-14 mt-3">
                      <label className="flex items-center gap-2 text-xs sm:text-sm font-medium text-gray-700 mb-2">
                        Property ID (required before connecting)
                        <HelpIcon content="Your GA4 Property ID (format: G-XXXXXXXXXX). Find this in Google Analytics: Admin → Property Settings → Property ID" />
                      </label>
                      <input
                        type="text"
                        value={googleAnalyticsPropertyId}
                        onChange={(e) => setGoogleAnalyticsPropertyId(e.target.value)}
                        placeholder="G-XXXXXXXXXX"
                        className="w-full px-3 py-2.5 sm:py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent mb-3"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          if (!googleAnalyticsPropertyId) {
                            showToast('Please enter your Google Analytics Property ID before connecting.', { isError: true });
                            return;
                          }
                          setIsConnectingGoogle('ga4');
                          try {
                            const { authUrl } = await googleOAuthApi.getAuthUrl(storeId, 'google_analytics_4', googleAnalyticsPropertyId);

                            // Open popup window
                            const popup = window.open(
                              authUrl,
                              'google-oauth',
                              'width=500,height=600,scrollbars=yes,resizable=yes'
                            );

                            if (!popup) {
                              showToast('Popup blocked. Please allow popups for this site.', { isError: true });
                              setIsConnectingGoogle(null);
                              return;
                            }

                            // Listen for message from popup
                            const messageHandler = (event: MessageEvent) => {
                              // Security: Only accept messages from same origin or trusted sources
                              if (event.origin !== window.location.origin && !event.origin.includes('supabase.co')) {
                                return;
                              }

                              if (event.data.type === 'oauth-success') {
                                window.removeEventListener('message', messageHandler);
                                popup.close();
                                showToast('Google Analytics connected successfully!', { isError: false });
                                if (shopDomain) {
                                  queryClient.invalidateQueries({ queryKey: queryKeys.store(shopDomain) });
                                }
                                setIsConnectingGoogle(null);
                              } else if (event.data.type === 'oauth-error') {
                                window.removeEventListener('message', messageHandler);
                                popup.close();
                                const errorMsg = event.data.error || 'We couldn\'t complete the connection';
                                showToast(`Connection failed: ${errorMsg}. Please try again.`, { isError: true });
                                setIsConnectingGoogle(null);
                              }
                            };

                            window.addEventListener('message', messageHandler);

                            // Check if popup is closed manually
                            const checkClosed = setInterval(() => {
                              if (popup.closed) {
                                clearInterval(checkClosed);
                                window.removeEventListener('message', messageHandler);
                                setIsConnectingGoogle(null);
                              }
                            }, 1000);
                          } catch (error) {
                            const errorMessage = formatAPIErrorMessage(error, { action: 'connect Google Analytics', resource: 'integration' });
                            showToast(errorMessage, { isError: true });
                            setIsConnectingGoogle(null);
                          }
                        }}
                        disabled={isConnectingGoogle === 'ga4' || !googleAnalyticsPropertyId}
                        className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isConnectingGoogle === 'ga4' ? 'Connecting...' : 'Connect Google Analytics'}
                      </button>
                    </div>
                  )}
                  {googleAnalyticsConnected && (
                    <div className="ml-0 sm:ml-14 mt-3">
                      <div className="flex items-center gap-2 text-sm text-green-600 mb-2">
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                        Connected
                      </div>
                      {googleAnalyticsPropertyId && (
                        <p className="text-xs text-gray-500">Property ID: {googleAnalyticsPropertyId}</p>
                      )}
                    </div>
                  )}
                </div>
                <div>
                  <label className="flex items-center justify-between gap-4 touch-manipulation mb-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-xs sm:text-sm font-medium text-gray-700">Google Search Console</p>
                        <HelpIcon content="Connect Google Search Console to automatically submit your sitemap when articles are published. This helps Google discover and index your content faster, improving your search visibility." />
                      </div>
                      <p className="text-xs text-gray-500">Monitor search performance and indexing</p>
                    </div>
                    <ToggleSwitch
                      checked={googleSearchConsoleEnabled}
                      onChange={(checked) => handleFieldChange('google_search_console_enabled', checked)}
                      id="googleSearchConsole"
                      ariaLabel="Enable Google Search Console"
                    />
                  </label>
                  {googleSearchConsoleEnabled && !googleSearchConsoleConnected && (
                    <div className="ml-0 sm:ml-14 mt-3">
                      <label className="flex items-center gap-2 text-xs sm:text-sm font-medium text-gray-700 mb-2">
                        Site URL (required before connecting)
                        <HelpIcon content="Enter the exact URL you verified in Google Search Console (e.g., https://yourstore.com). This must match the URL property in your Search Console account." />
                      </label>
                      <input
                        type="url"
                        value={googleSearchConsoleSiteUrl}
                        onChange={(e) => setGoogleSearchConsoleSiteUrl(e.target.value)}
                        placeholder="https://yourstore.com"
                        className="w-full px-3 py-2.5 sm:py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent mb-3"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          if (!googleSearchConsoleSiteUrl) {
                            showToast('Please enter your site URL before connecting.', { isError: true });
                            return;
                          }
                          setIsConnectingGoogle('gsc');
                          try {
                            const { authUrl } = await googleOAuthApi.getAuthUrl(storeId, 'google_search_console', undefined, googleSearchConsoleSiteUrl);

                            // Open popup window
                            const popup = window.open(
                              authUrl,
                              'google-oauth',
                              'width=500,height=600,scrollbars=yes,resizable=yes'
                            );

                            if (!popup) {
                              showToast('Popup blocked. Please allow popups for this site.', { isError: true });
                              setIsConnectingGoogle(null);
                              return;
                            }

                            // Listen for message from popup
                            const messageHandler = (event: MessageEvent) => {
                              // Security: Only accept messages from same origin or trusted sources
                              if (event.origin !== window.location.origin && !event.origin.includes('supabase.co')) {
                                return;
                              }

                              if (event.data.type === 'oauth-success') {
                                window.removeEventListener('message', messageHandler);
                                popup.close();
                                showToast('Google Search Console connected successfully!', { isError: false });
                                if (shopDomain) {
                                  queryClient.invalidateQueries({ queryKey: queryKeys.store(shopDomain) });
                                }
                                setIsConnectingGoogle(null);
                              } else if (event.data.type === 'oauth-error') {
                                window.removeEventListener('message', messageHandler);
                                popup.close();
                                const errorMsg = event.data.error || 'We couldn\'t complete the connection';
                                showToast(`Connection failed: ${errorMsg}. Please try again.`, { isError: true });
                                setIsConnectingGoogle(null);
                              }
                            };

                            window.addEventListener('message', messageHandler);

                            // Check if popup is closed manually
                            const checkClosed = setInterval(() => {
                              if (popup.closed) {
                                clearInterval(checkClosed);
                                window.removeEventListener('message', messageHandler);
                                setIsConnectingGoogle(null);
                              }
                            }, 1000);
                          } catch (error) {
                            const errorMessage = formatAPIErrorMessage(error, { action: 'connect Google Analytics', resource: 'integration' });
                            showToast(errorMessage, { isError: true });
                            setIsConnectingGoogle(null);
                          }
                        }}
                        disabled={isConnectingGoogle === 'gsc' || !googleSearchConsoleSiteUrl}
                        className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isConnectingGoogle === 'gsc' ? 'Connecting...' : 'Connect Google Search Console'}
                      </button>
                    </div>
                  )}
                  {googleSearchConsoleConnected && (
                    <div className="ml-0 sm:ml-14 mt-3">
                      <div className="flex items-center gap-2 text-sm text-green-600 mb-2">
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                        Connected
                      </div>
                      {googleSearchConsoleSiteUrl && (
                        <p className="text-xs text-gray-500">Site: {googleSearchConsoleSiteUrl}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Publishing Settings */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                <h2 className="text-base sm:text-lg font-semibold text-gray-900">Publishing Settings</h2>
              </div>
              <div className="p-4 sm:p-5 lg:p-6 space-y-4 sm:space-y-5 lg:space-y-6">
                <div>
                  <label className="flex items-center gap-2 text-xs sm:text-sm font-medium text-gray-700 mb-2">
                    Require Approval Before Publishing
                    <HelpIcon content="When enabled, articles will wait for your approval before publishing. When disabled, articles will automatically publish after the review window if not reviewed." />
                  </label>
                  <div className="flex items-center gap-3">
                    <ToggleSwitch
                      checked={requireApproval}
                      onChange={(checked) => setRequireApproval(checked)}
                      id="requireApproval"
                      ariaLabel="Require approval before publishing"
                    />
                    <span className="text-xs sm:text-sm text-gray-700">
                      {requireApproval ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    {requireApproval
                      ? 'Articles will wait for your approval before publishing. You can review and approve or reject each article.'
                      : 'Articles will automatically publish after the review window if not reviewed.'}
                  </p>
                </div>

                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                    Default Author Name
                    <HelpIcon content="The author name to use for published articles. You can use {Storename} as a placeholder for your store's name." />
                  </label>
                  <input
                    type="text"
                    value={defaultAuthor}
                    onChange={(e) => setDefaultAuthor(e.target.value)}
                    placeholder="e.g. My Store's Editorial"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  />
                  <p className="text-xs text-gray-500 mt-2">
                    Used as the author for published articles. You can use <code className="bg-gray-100 px-1 py-0.5 rounded text-purple-600">{`{Storename}`}</code> to automatically insert your store name.
                  </p>
                </div>
              </div>
            </div>

            {/* Content Strategy */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                <h2 className="text-base sm:text-lg font-semibold text-gray-900">Content Strategy</h2>
                <p className="text-xs sm:text-sm text-gray-500 mt-1">
                  Guide what topics and keywords to focus on. The system will prioritize these in article generation.
                </p>
              </div>
              <div className="p-4 sm:p-5 lg:p-6 space-y-6">
                {/* Topic Preferences */}
                <div>
                  <label className="flex items-center gap-2 text-xs sm:text-sm font-medium text-gray-700 mb-2">
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
                  <label className="flex items-center gap-2 text-xs sm:text-sm font-medium text-gray-700 mb-2">
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
                  <label className="flex items-center gap-2 text-xs sm:text-sm font-medium text-gray-700 mb-2">
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
              </div>
            </div>

            {/* Notifications */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                <h2 className="text-base sm:text-lg font-semibold text-gray-900">Notifications</h2>
              </div>
              <div className="p-4 sm:p-5 lg:p-6 space-y-4 sm:space-y-5">
                <div>
                  <label className="flex items-center justify-between gap-4 touch-manipulation mb-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-xs sm:text-sm font-medium text-gray-700">Email Notifications</p>
                        <HelpIcon content="Receive email notifications when articles are published or scheduled. You can customize which events trigger notifications below." />
                      </div>
                      <p className="text-xs text-gray-500">Enable email notifications for article events</p>
                    </div>
                    <ToggleSwitch
                      checked={emailNotificationsEnabled}
                      onChange={(checked) => handleFieldChange('email_notifications_enabled', checked)}
                      id="emailNotifications"
                      ariaLabel="Enable email notifications"
                    />
                  </label>
                  {emailNotificationsEnabled && (
                    <div className="ml-0 sm:ml-14 space-y-2">
                      <label className="flex items-center gap-3 touch-manipulation">
                        <input
                          type="checkbox"
                          checked={emailArticlePublished}
                          onChange={(e) => handleFieldChange('email_article_published', e.target.checked)}
                          className="w-4 h-4 sm:w-5 sm:h-5 text-purple-600 rounded focus:ring-purple-500"
                        />
                        <span className="text-xs sm:text-sm text-gray-700">Article Published</span>
                      </label>
                      <label className="flex items-center gap-3 touch-manipulation">
                        <input
                          type="checkbox"
                          checked={emailArticleScheduled}
                          onChange={(e) => handleFieldChange('email_article_scheduled', e.target.checked)}
                          className="w-4 h-4 sm:w-5 sm:h-5 text-purple-600 rounded focus:ring-purple-500"
                        />
                        <span className="text-xs sm:text-sm text-gray-700">Article Scheduled</span>
                      </label>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Billing */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                <h2 className="text-base sm:text-lg font-semibold text-gray-900">Billing</h2>
              </div>
              <div className="p-4 sm:p-5 lg:p-6 space-y-4 sm:space-y-5">
                {hasNoActivePlan && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
                    <div className="flex items-start gap-3">
                      <svg className="w-5 h-5 text-yellow-600 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                      <div className="flex-1">
                        <h3 className="text-sm font-semibold text-yellow-900 mb-1">No Active Subscription</h3>
                        <p className="text-sm text-yellow-800">
                          You don't have an active subscription. Please subscribe to a plan to continue using the service.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                    Current Plan
                  </label>
                  <div className="px-3 py-2.5 sm:py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900">
                    {isLoading ? 'Loading...' : planName}
                  </div>
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                    {quota?.is_trial ? 'Trial Ends' : 'Renewal Date'}
                  </label>
                  <div className="px-3 py-2.5 sm:py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900">
                    {isLoading ? 'Loading...' : formatRenewalDate(renewalDate)}
                  </div>
                </div>
                <div className="pt-2 border-t border-gray-200">
                  <button
                    onClick={() => setIsPlansModalOpen(true)}
                    className="w-full sm:w-auto px-4 py-2.5 sm:py-2 bg-purple-600 text-white rounded-lg text-sm sm:text-base font-medium hover:bg-purple-700 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2"
                  >
                    Manage Subscription
                  </button>
                </div>
              </div>
            </div>

            {/* Danger Zone */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                <h2 className="text-base sm:text-lg font-semibold text-gray-900 text-red-600">Danger Zone</h2>
              </div>
              <div className="p-4 sm:p-5 lg:p-6">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
                  <div>
                    <p className="text-xs sm:text-sm font-medium text-gray-900">Reset All Settings</p>
                    <p className="text-xs text-gray-500 mt-1">Reset all settings to default values</p>
                  </div>
                  <button
                    onClick={handleResetSettings}
                    className="px-4 py-2.5 sm:py-2 border border-red-300 text-red-600 rounded-lg text-sm sm:text-base font-medium hover:bg-red-50 transition-colors touch-manipulation whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                  >
                    Reset
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Plans Modal */}
      <PlansModal
        isOpen={isPlansModalOpen}
        onClose={() => setIsPlansModalOpen(false)}
        currentPlanName={planName}
        storeId={store?.id}
      />
    </div>
  );
}
