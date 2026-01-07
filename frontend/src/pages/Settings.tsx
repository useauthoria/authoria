import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { getShopDomain } from '../lib/app-bridge';
import { useStore, useQuotaStatus, queryKeys } from '../lib/api-cache';
import { supabase, googleOAuthApi, type Store, type QuotaStatus } from '../lib/api-client';
import { useSettingsData, type SettingsData } from '../hooks/useSettingsData';
import { AppBridgeContextualSaveBar } from '../components/AppBridgeContextualSaveBar';
import { useAppBridgeToast } from '../hooks/useAppBridge';
import PlansModal from '../components/PlansModal';
import { formatAPIErrorMessage } from '../utils/error-messages';
import { HelpIcon } from '../components/Tooltip';

const INTEGRATION_CHECK_THROTTLE_MS = 1000;
const POPUP_CHECK_INTERVAL_MS = 1000;
const RESET_RELOAD_DELAY_MS = 1000;
const POPUP_WIDTH = 500;
const POPUP_HEIGHT = 600;
const MAX_PROPERTY_ID_LENGTH = 50;
const MAX_SITE_URL_LENGTH = 500;
const MAX_AUTHOR_LENGTH = 200;
const MAX_TOPIC_LENGTH = 100;
const MAX_KEYWORD_LENGTH = 100;
const MAX_ANGLE_LENGTH = 100;
const MAX_TOPICS = 50;
const MAX_KEYWORDS = 50;
const MAX_ANGLES = 50;
const DEFAULT_REVIEW_WINDOW_HOURS = 24;
const SKELETON_CARDS_COUNT = 5;

interface ToggleSwitchProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly id?: string;
  readonly ariaLabel?: string;
}

interface AnalyticsIntegration {
  readonly id: string;
  readonly is_active: boolean;
  readonly credentials: unknown;
}

interface GA4Credentials {
  readonly property_id?: string;
}

interface GSCCredentials {
  readonly site_url?: string;
}

interface StoreWithContentPreferences extends Store {
  readonly require_approval?: boolean;
  readonly review_window_hours?: number;
  readonly content_preferences?: {
    readonly topic_preferences?: readonly string[];
    readonly keyword_focus?: readonly string[];
    readonly content_angles?: readonly string[];
    readonly default_author?: string;
  };
  readonly shop_metadata?: {
    readonly name?: string;
    readonly shop_name?: string;
    readonly [key: string]: unknown;
  };
}

interface WrappedStoreResponse {
  readonly data: unknown;
  readonly correlationId?: string;
}

type IntegrationType = 'google_analytics_4' | 'google_search_console';
type ConnectingState = IntegrationType | null;

const ToggleSwitch = ({ checked, onChange, id, ariaLabel }: ToggleSwitchProps): JSX.Element => {
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
};

const SkeletonCard = (): JSX.Element => {
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
};

const isWrappedStoreResponse = (store: unknown): store is WrappedStoreResponse => {
  return (
    store !== null &&
    typeof store === 'object' &&
    'data' in store &&
    !('id' in store) &&
    !('shop_domain' in store)
  );
};

const isStoreWithContentPreferences = (store: Store | null): store is StoreWithContentPreferences => {
  return store !== null && typeof store === 'object';
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

const isGA4Credentials = (credentials: unknown): credentials is GA4Credentials => {
  return credentials !== null && typeof credentials === 'object';
};

const isGSCCredentials = (credentials: unknown): credentials is GSCCredentials => {
  return credentials !== null && typeof credentials === 'object';
};

const validatePropertyId = (propertyId: string): boolean => {
  if (!propertyId || typeof propertyId !== 'string') {
    return false;
  }
  const trimmed = propertyId.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_PROPERTY_ID_LENGTH;
};

const validateSiteUrl = (url: string): boolean => {
  if (!url || typeof url !== 'string') {
    return false;
  }
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SITE_URL_LENGTH) {
    return false;
  }
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
};

const validateAuthor = (author: string): boolean => {
  if (typeof author !== 'string') {
    return false;
  }
  return author.length <= MAX_AUTHOR_LENGTH;
};

const validateTopic = (topic: string): boolean => {
  if (typeof topic !== 'string') {
    return false;
  }
  const trimmed = topic.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_TOPIC_LENGTH;
};

const validateKeyword = (keyword: string): boolean => {
  if (typeof keyword !== 'string') {
    return false;
  }
  const trimmed = keyword.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_KEYWORD_LENGTH;
};

const validateAngle = (angle: string): boolean => {
  if (typeof angle !== 'string') {
    return false;
  }
  const trimmed = angle.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_ANGLE_LENGTH;
};

const formatStoreName = (store: StoreWithContentPreferences): string => {
  const rawStoreName =
    store.shop_metadata?.name || store.shop_metadata?.shop_name || store.shop_domain || 'Authoria';

  let cleaned = rawStoreName;
  if (cleaned.includes('.')) {
    cleaned = cleaned.split('.')[0];
  }

  return cleaned
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

const formatPlanName = (planName: string | null | undefined): string => {
  if (!planName || planName === 'Unknown' || planName === 'unknown') {
    return 'No Plan';
  }
  return planName
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

const extractGA4PropertyId = (integration: AnalyticsIntegration | null): string => {
  if (!integration || !isGA4Credentials(integration.credentials)) {
    return '';
  }
  return integration.credentials.property_id || '';
};

const extractGSCSiteUrl = (integration: AnalyticsIntegration | null): string => {
  if (!integration || !isGSCCredentials(integration.credentials)) {
    return '';
  }
  return integration.credentials.site_url || '';
};

const getAllowedOAuthOrigins = (): readonly string[] => {
  if (typeof window === 'undefined') {
    return [];
  }
  return [window.location.origin, 'https://supabase.co', 'https://app.supabase.com'];
};

const isAllowedOrigin = (origin: string): boolean => {
  return getAllowedOAuthOrigins().includes(origin);
};

export default function Settings(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const shopDomain = useMemo(() => getShopDomain(), []);

  const {
    data: storeRaw,
    isLoading: storeLoading,
    error: storeError,
  } = useStore(shopDomain ?? '');

  const store = useMemo(() => {
    if (!storeRaw) {
      return null;
    }
    if (isWrappedStoreResponse(storeRaw)) {
      return storeRaw.data as Store | null;
    }
    return storeRaw as Store | null;
  }, [storeRaw]);

  const storeId = useMemo(() => store?.id ?? '', [store?.id]);

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
    onError: useCallback(() => {
    }, []),
  });

  const { showToast } = useAppBridgeToast();

  const [requireApproval, setRequireApproval] = useState(false);
  const [defaultAuthor, setDefaultAuthor] = useState('');
  const [reviewWindowHours, setReviewWindowHours] = useState(DEFAULT_REVIEW_WINDOW_HOURS);
  const [emailNotificationsEnabled, setEmailNotificationsEnabled] = useState(true);
  const [emailArticlePublished, setEmailArticlePublished] = useState(true);
  const [emailArticleScheduled, setEmailArticleScheduled] = useState(true);
  const [googleAnalyticsEnabled, setGoogleAnalyticsEnabled] = useState(false);
  const [googleAnalyticsPropertyId, setGoogleAnalyticsPropertyId] = useState('');
  const [googleAnalyticsConnected, setGoogleAnalyticsConnected] = useState(false);
  const [googleSearchConsoleEnabled, setGoogleSearchConsoleEnabled] = useState(false);
  const [googleSearchConsoleSiteUrl, setGoogleSearchConsoleSiteUrl] = useState('');
  const [googleSearchConsoleConnected, setGoogleSearchConsoleConnected] = useState(false);
  const [isConnectingGoogle, setIsConnectingGoogle] = useState<ConnectingState>(null);
  const [integrationCheckError, setIntegrationCheckError] = useState<string | null>(null);
  const [topicPreferences, setTopicPreferences] = useState<readonly string[]>([]);
  const [keywordFocus, setKeywordFocus] = useState<readonly string[]>([]);
  const [contentAngles, setContentAngles] = useState<readonly string[]>([]);
  const [newTopic, setNewTopic] = useState('');
  const [newKeyword, setNewKeyword] = useState('');
  const [newAngle, setNewAngle] = useState('');
  const [isPlansModalOpen, setIsPlansModalOpen] = useState(false);
  const [integrationCheckTrigger, setIntegrationCheckTrigger] = useState(0);
  const [isInitialized, setIsInitialized] = useState(false);

  const isMountedRef = useRef(true);
  const lastIntegrationCheckRef = useRef<number>(0);
  const integrationCheckAbortRef = useRef<AbortController | null>(null);
  const oauthPopupRef = useRef<Window | null>(null);
  const oauthMessageHandlerRef = useRef<((event: MessageEvent) => void) | null>(null);
  const oauthCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (integrationCheckAbortRef.current) {
        integrationCheckAbortRef.current.abort();
      }
      if (oauthCheckIntervalRef.current) {
        clearInterval(oauthCheckIntervalRef.current);
      }
      if (oauthMessageHandlerRef.current) {
        window.removeEventListener('message', oauthMessageHandlerRef.current);
      }
      if (oauthPopupRef.current && !oauthPopupRef.current.closed) {
        oauthPopupRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    if (!storeId) {
      setIntegrationCheckError(null);
      setGoogleAnalyticsConnected(false);
      setGoogleSearchConsoleConnected(false);
      setGoogleAnalyticsPropertyId('');
      setGoogleSearchConsoleSiteUrl('');
      return;
    }

    if (integrationCheckAbortRef.current) {
      integrationCheckAbortRef.current.abort();
    }

    const checkIntegrations = async () => {
      const now = Date.now();
      if (now - lastIntegrationCheckRef.current < INTEGRATION_CHECK_THROTTLE_MS) {
        return;
      }
      lastIntegrationCheckRef.current = now;

      const abortController = new AbortController();
      integrationCheckAbortRef.current = abortController;

      try {
        if (!isMountedRef.current) {
          return;
        }
        setIntegrationCheckError(null);

        const [ga4Result, gscResult] = await Promise.all([
          supabase
            .from('analytics_integrations')
            .select('id, is_active, credentials')
            .eq('store_id', storeId)
            .eq('integration_type', 'google_analytics_4')
            .eq('is_active', true)
            .maybeSingle(),
          supabase
            .from('analytics_integrations')
            .select('id, is_active, credentials')
            .eq('store_id', storeId)
            .eq('integration_type', 'google_search_console')
            .eq('is_active', true)
            .maybeSingle(),
        ]);

        if (abortController.signal.aborted || !isMountedRef.current) {
          return;
        }

        if (ga4Result.error) {
          const errorMessage = formatAPIErrorMessage(ga4Result.error, {
            action: 'check Google Analytics integration',
            resource: 'integration',
          });
          setIntegrationCheckError('Failed to check integration status. Please refresh the page.');
        } else {
          const isConnected = !!ga4Result.data;
          setGoogleAnalyticsConnected(isConnected);
          setGoogleAnalyticsPropertyId(extractGA4PropertyId(ga4Result.data));
        }

        if (gscResult.error) {
          const errorMessage = formatAPIErrorMessage(gscResult.error, {
            action: 'check Google Search Console integration',
            resource: 'integration',
          });
          setIntegrationCheckError('Failed to check integration status. Please refresh the page.');
        } else {
          const isConnected = !!gscResult.data;
          setGoogleSearchConsoleConnected(isConnected);
          setGoogleSearchConsoleSiteUrl(extractGSCSiteUrl(gscResult.data));
        }
      } catch (error) {
        if (!abortController.signal.aborted && isMountedRef.current) {
          const errorMessage = formatAPIErrorMessage(error, {
            action: 'check integrations',
            resource: 'integration',
          });
          setIntegrationCheckError('Failed to check integration status. Please refresh the page.');
        }
      }
    };

    checkIntegrations();

    return () => {
      if (integrationCheckAbortRef.current) {
        integrationCheckAbortRef.current.abort();
      }
    };
  }, [storeId, integrationCheckTrigger]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
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

  useEffect(() => {
    if (isInitialized) {
      return;
    }

    if (settings?.notifications?.email) {
      setEmailNotificationsEnabled(settings.notifications.email.enabled ?? true);
      setEmailArticlePublished(settings.notifications.email.article_published ?? true);
      setEmailArticleScheduled(settings.notifications.email.article_scheduled ?? true);
    }

    if (isStoreWithContentPreferences(store)) {
      setRequireApproval(store.require_approval ?? false);
      setReviewWindowHours(store.review_window_hours ?? DEFAULT_REVIEW_WINDOW_HOURS);

      const storeName = formatStoreName(store);
      const contentPrefs = store.content_preferences as StoreWithContentPreferences['content_preferences'] | undefined;
      const defaultAuthorValue = contentPrefs?.default_author || `${storeName}'s Editorial`;
      setDefaultAuthor(defaultAuthorValue);

      setTopicPreferences(contentPrefs?.topic_preferences || []);
      setKeywordFocus(contentPrefs?.keyword_focus || []);
      setContentAngles(contentPrefs?.content_angles || []);
    }

    if (settings || store) {
      setIsInitialized(true);
    }
  }, [settings, store, isInitialized]);

  useEffect(() => {
    if (googleAnalyticsConnected && !googleAnalyticsEnabled) {
      setGoogleAnalyticsEnabled(true);
    }
    if (googleSearchConsoleConnected && !googleSearchConsoleEnabled) {
      setGoogleSearchConsoleEnabled(true);
    }
  }, [googleAnalyticsConnected, googleSearchConsoleConnected]);

  const handleConnectOAuth = useCallback(
    async (integrationType: IntegrationType, propertyId?: string, siteUrl?: string) => {
      if (!storeId) {
        showToast("We couldn't load your store information. Please refresh the page and try again.", {
          isError: true,
        });
        return;
      }

      if (integrationType === 'google_analytics_4' && !validatePropertyId(propertyId || '')) {
        showToast('Please enter your Google Analytics Property ID before connecting.', { isError: true });
        return;
      }

      if (integrationType === 'google_search_console' && !validateSiteUrl(siteUrl || '')) {
        showToast('Please enter your site URL before connecting.', { isError: true });
        return;
      }

      setIsConnectingGoogle(integrationType);

      try {
        const { authUrl } = await googleOAuthApi.getAuthUrl(storeId, integrationType, propertyId, siteUrl);

        if (typeof window === 'undefined') {
          setIsConnectingGoogle(null);
          return;
        }

        const popup = window.open(authUrl, 'google-oauth', `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},scrollbars=yes,resizable=yes`);

        if (!popup) {
          showToast('Popup blocked. Please allow popups for this site.', { isError: true });
          setIsConnectingGoogle(null);
          return;
        }

        oauthPopupRef.current = popup;

        const messageHandler = (event: MessageEvent) => {
          if (!isAllowedOrigin(event.origin)) {
            return;
          }

          if (event.data.type === 'oauth-success') {
            window.removeEventListener('message', messageHandler);
            oauthMessageHandlerRef.current = null;
            if (popup && !popup.closed) {
              popup.close();
            }
            oauthPopupRef.current = null;

            if (integrationType === 'google_analytics_4') {
              setGoogleAnalyticsConnected(true);
              setGoogleAnalyticsEnabled(true);
              showToast('Google Analytics connected successfully!', { isError: false });
            } else {
              setGoogleSearchConsoleConnected(true);
              setGoogleSearchConsoleEnabled(true);
              showToast('Google Search Console connected successfully!', { isError: false });
            }

            if (shopDomain) {
              queryClient.invalidateQueries({ queryKey: queryKeys.store(shopDomain) });
            }
            setIntegrationCheckTrigger((prev) => prev + 1);
            setIsConnectingGoogle(null);
          } else if (event.data.type === 'oauth-error') {
            window.removeEventListener('message', messageHandler);
            oauthMessageHandlerRef.current = null;
            if (popup && !popup.closed) {
              popup.close();
            }
            oauthPopupRef.current = null;
            const errorMsg = event.data.error || "We couldn't complete the connection";
            showToast(`Connection failed: ${errorMsg}. Please try again.`, { isError: true });
            setIsConnectingGoogle(null);
          }
        };

        oauthMessageHandlerRef.current = messageHandler;
        window.addEventListener('message', messageHandler);

        const checkClosed = setInterval(() => {
          if (popup.closed) {
            clearInterval(checkClosed);
            oauthCheckIntervalRef.current = null;
            if (oauthMessageHandlerRef.current) {
              window.removeEventListener('message', oauthMessageHandlerRef.current);
              oauthMessageHandlerRef.current = null;
            }
            oauthPopupRef.current = null;

            const message =
              integrationType === 'google_analytics_4'
                ? 'Connection cancelled. Please try again if you want to connect Google Analytics.'
                : 'Connection cancelled. Please try again if you want to connect Google Search Console.';
            showToast(message, { isError: false, duration: 3000 });
            setIsConnectingGoogle(null);
          }
        }, POPUP_CHECK_INTERVAL_MS);

        oauthCheckIntervalRef.current = checkClosed;
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }
        const errorMessage = formatAPIErrorMessage(error, {
          action: `connect ${integrationType === 'google_analytics_4' ? 'Google Analytics' : 'Google Search Console'}`,
          resource: 'integration',
        });
        showToast(errorMessage, { isError: true });
        setIsConnectingGoogle(null);
      }
    },
    [storeId, shopDomain, queryClient, showToast],
  );

  const handleSave = useCallback(async () => {
    if (!isStoreWithContentPreferences(store) || !store.id) {
      showToast("We couldn't load your store information. Please refresh the page and try again.", {
        isError: true,
      });
      return;
    }

    if (!isOnline) {
      showToast("You're currently offline. Please check your internet connection and try again.", {
        isError: true,
      });
      return;
    }

    if (!isMountedRef.current) {
      return;
    }

    try {
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

      updateSettings(updatedSettings);

      const contentPrefs = {
        default_author: defaultAuthor,
        topic_preferences: topicPreferences,
        keyword_focus: keywordFocus,
        content_angles: contentAngles,
        internal_linking_preferences: {},
      } as Record<string, unknown>;

      const { error: storeUpdateError } = await supabase
        .from('stores')
        .update({
          require_approval: requireApproval,
          review_window_hours: reviewWindowHours,
          brand_safety_enabled: true,
          content_preferences: contentPrefs,
        })
        .eq('id', store.id);

      if (storeUpdateError) {
        throw new Error(storeUpdateError.message);
      }

      if (!isMountedRef.current) {
        return;
      }

      queryClient.invalidateQueries({ queryKey: queryKeys.store(shopDomain ?? '') });
      saveSettings();

      showToast('Settings saved successfully', { isError: false });
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }
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
    defaultAuthor,
    updateSettings,
    saveSettings,
    shopDomain,
    queryClient,
    showToast,
    isOnline,
  ]);

  const handleFieldChange = useCallback(
    (field: string, value: unknown) => {
      switch (field) {
        case 'google_analytics_enabled':
          setGoogleAnalyticsEnabled(value as boolean);
          break;
        case 'google_analytics_property_id':
          setGoogleAnalyticsPropertyId(value as string);
          break;
        case 'google_search_console_enabled':
          setGoogleSearchConsoleEnabled(value as boolean);
          break;
        case 'google_search_console_site_url':
          setGoogleSearchConsoleSiteUrl(value as string);
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
    [settings, emailNotificationsEnabled, emailArticlePublished, emailArticleScheduled, updateSettings],
  );

  const handleResetSettings = useCallback(async () => {
    if (!isStoreWithContentPreferences(store) || !store.id) {
      showToast("We couldn't load your store information. Please refresh the page and try again.", {
        isError: true,
      });
      return;
    }

    if (!window.confirm('Are you sure you want to reset all settings to default values? This action cannot be undone.')) {
      return;
    }

    if (!isMountedRef.current) {
      return;
    }

    try {
      const { error } = await supabase
        .from('stores')
        .update({
          language_settings: { primary: 'en', enabled: ['en'] },
          frequency_settings: { interval: 'weekly', count: 2 },
          require_approval: false,
          review_window_hours: DEFAULT_REVIEW_WINDOW_HOURS,
          content_preferences: {
            default_author: '',
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

      if (!isMountedRef.current) {
        return;
      }

      setGoogleAnalyticsConnected(false);
      setGoogleAnalyticsEnabled(false);
      setGoogleAnalyticsPropertyId('');
      setGoogleSearchConsoleConnected(false);
      setGoogleSearchConsoleEnabled(false);
      setGoogleSearchConsoleSiteUrl('');
      setIntegrationCheckError(null);

      resetSettings();
      showToast('Settings reset successfully. Reloading page...', { isError: false });
      setTimeout(() => {
        if (typeof window !== 'undefined') {
          window.location.reload();
        }
      }, RESET_RELOAD_DELAY_MS);
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }
      const errorMessage = formatAPIErrorMessage(error, { action: 'reset settings', resource: 'settings' });
      showToast(errorMessage, { isError: true });
    }
  }, [store, resetSettings, showToast]);

  const handleAddTopic = useCallback(() => {
    if (!validateTopic(newTopic)) {
      return;
    }
    if (topicPreferences.length >= MAX_TOPICS) {
      showToast(`Maximum ${MAX_TOPICS} topics allowed`, { isError: true });
      return;
    }
    setTopicPreferences([...topicPreferences, newTopic.trim()]);
    setNewTopic('');
  }, [newTopic, topicPreferences, showToast]);

  const handleAddKeyword = useCallback(() => {
    if (!validateKeyword(newKeyword)) {
      return;
    }
    if (keywordFocus.length >= MAX_KEYWORDS) {
      showToast(`Maximum ${MAX_KEYWORDS} keywords allowed`, { isError: true });
      return;
    }
    setKeywordFocus([...keywordFocus, newKeyword.trim()]);
    setNewKeyword('');
  }, [newKeyword, keywordFocus, showToast]);

  const handleAddAngle = useCallback(() => {
    if (!validateAngle(newAngle)) {
      return;
    }
    if (contentAngles.length >= MAX_ANGLES) {
      showToast(`Maximum ${MAX_ANGLES} angles allowed`, { isError: true });
      return;
    }
    setContentAngles([...contentAngles, newAngle.trim()]);
    setNewAngle('');
  }, [newAngle, contentAngles, showToast]);

  const handleRemoveTopic = useCallback(
    (index: number) => {
      setTopicPreferences(topicPreferences.filter((_, i) => i !== index));
    },
    [topicPreferences],
  );

  const handleRemoveKeyword = useCallback(
    (index: number) => {
      setKeywordFocus(keywordFocus.filter((_, i) => i !== index));
    },
    [keywordFocus],
  );

  const handleRemoveAngle = useCallback(
    (index: number) => {
      setContentAngles(contentAngles.filter((_, i) => i !== index));
    },
    [contentAngles],
  );

  const handleReload = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, []);

  const isLoading = storeLoading || settingsLoading || quotaLoading;
  const error = storeError || settingsErrorObj;

  const planName = useMemo(() => {
    if (quotaLoading) {
      return 'Loading...';
    }
    if (quotaIsError || quotaError) {
      return 'Error';
    }
    if (!quota) {
      return 'No Plan';
    }
    if (isQuotaWithError(quota)) {
      return 'No Plan';
    }
    if (!isQuotaStatus(quota)) {
      return 'No Plan';
    }
    return formatPlanName(quota.plan_name);
  }, [quota, quotaLoading, quotaIsError, quotaError]);

  const hasNoActivePlan = useMemo(() => {
    if (quotaLoading || quotaIsError || !quota) {
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
    return (!name || name === 'Unknown' || name === 'unknown') && !isTrial;
  }, [quota, quotaLoading, quotaIsError]);

  const renewalDate = useMemo(() => {
    if (quotaLoading || quotaIsError || !quota) {
      return null;
    }
    if (isQuotaWithError(quota)) {
      return null;
    }
    if (!isQuotaStatus(quota)) {
      return null;
    }
    if (quota.is_trial && quota.trial_ends_at) {
      return new Date(quota.trial_ends_at);
    }
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    return nextMonth;
  }, [quota, quotaLoading, quotaIsError]);

  const formatRenewalDate = useCallback((date: Date | null): string => {
    if (!date) {
      return 'N/A';
    }
    return date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
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
              onClick={handleReload}
              className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
              type="button"
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
            type="button"
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

      {hasUnsavedChanges && (
        <div className="bg-purple-600 text-white px-4 sm:px-6 lg:px-8 py-3 sm:py-4 flex items-center justify-between flex-shrink-0">
          <p className="text-sm font-medium">You have unsaved changes</p>
          <div className="flex items-center gap-3">
            <button
              onClick={resetSettings}
              disabled={isSaving}
              className="px-4 py-2 text-sm font-medium text-white hover:text-gray-200 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-purple-600 rounded disabled:opacity-50"
              type="button"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving || !isOnline}
              className="px-4 py-2 bg-white text-purple-600 text-sm font-medium rounded-md hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-purple-600 disabled:opacity-50"
              type="button"
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}

      {saveSuccess && (
        <div className="bg-green-50 border-b border-green-200 px-4 sm:px-6 lg:px-8 py-3 flex-shrink-0">
          <p className="text-sm text-green-800">Settings saved successfully</p>
        </div>
      )}

      {saveError && (
        <div className="bg-red-50 border-b border-red-200 px-4 sm:px-6 lg:px-8 py-3 flex-shrink-0">
          <p className="text-sm text-red-800">{formatAPIErrorMessage(saveError, { action: 'save settings', resource: 'settings' })}</p>
        </div>
      )}

      {!isOnline && (
        <div className="bg-yellow-50 border-b border-yellow-200 px-4 sm:px-6 lg:px-8 py-3 flex-shrink-0">
          <p className="text-sm text-yellow-800">You are offline. Changes will be saved when you reconnect.</p>
        </div>
      )}

      {integrationCheckError && (
        <div className="bg-yellow-50 border-b border-yellow-200 px-4 sm:px-6 lg:px-8 py-3 flex-shrink-0">
          <div className="flex items-center justify-between">
            <p className="text-sm text-yellow-800">{integrationCheckError}</p>
            <button
              onClick={() => {
                setIntegrationCheckError(null);
                setIntegrationCheckTrigger((prev) => prev + 1);
              }}
              className="text-sm text-yellow-900 hover:text-yellow-950 underline"
              type="button"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        {isLoading ? (
          <div className="max-w-4xl mx-auto space-y-4 sm:space-y-5 lg:space-y-6">
            {Array.from({ length: SKELETON_CARDS_COUNT }, (_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : (
          <div className="max-w-4xl mx-auto space-y-4 sm:space-y-5 lg:space-y-6">
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
                    type="button"
                  >
                    Start Brand Setup
                  </button>
                </div>
              </div>
            </div>

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
                        maxLength={MAX_PROPERTY_ID_LENGTH}
                        className="w-full px-3 py-2.5 sm:py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent mb-3"
                      />
                      <button
                        type="button"
                        onClick={() => handleConnectOAuth('google_analytics_4', googleAnalyticsPropertyId)}
                        disabled={isConnectingGoogle === 'google_analytics_4' || !validatePropertyId(googleAnalyticsPropertyId)}
                        className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isConnectingGoogle === 'google_analytics_4' ? 'Connecting...' : 'Connect Google Analytics'}
                      </button>
                    </div>
                  )}
                  {googleAnalyticsConnected && (
                    <div className="ml-0 sm:ml-14 mt-3">
                      <div className="flex items-center gap-2 text-sm text-green-600 mb-2">
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                            clipRule="evenodd"
                          />
                        </svg>
                        Connected
                      </div>
                      {googleAnalyticsPropertyId && <p className="text-xs text-gray-500">Property ID: {googleAnalyticsPropertyId}</p>}
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
                        maxLength={MAX_SITE_URL_LENGTH}
                        className="w-full px-3 py-2.5 sm:py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent mb-3"
                      />
                      <button
                        type="button"
                        onClick={() => handleConnectOAuth('google_search_console', undefined, googleSearchConsoleSiteUrl)}
                        disabled={isConnectingGoogle === 'google_search_console' || !validateSiteUrl(googleSearchConsoleSiteUrl)}
                        className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isConnectingGoogle === 'google_search_console' ? 'Connecting...' : 'Connect Google Search Console'}
                      </button>
                    </div>
                  )}
                  {googleSearchConsoleConnected && (
                    <div className="ml-0 sm:ml-14 mt-3">
                      <div className="flex items-center gap-2 text-sm text-green-600 mb-2">
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                            clipRule="evenodd"
                          />
                        </svg>
                        Connected
                      </div>
                      {googleSearchConsoleSiteUrl && <p className="text-xs text-gray-500">Site: {googleSearchConsoleSiteUrl}</p>}
                    </div>
                  )}
                </div>
              </div>
            </div>

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
                    <span className="text-xs sm:text-sm text-gray-700">{requireApproval ? 'Enabled' : 'Disabled'}</span>
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
                    onChange={(e) => {
                      const value = e.target.value;
                      if (validateAuthor(value)) {
                        setDefaultAuthor(value);
                      }
                    }}
                    placeholder="e.g. My Store's Editorial"
                    maxLength={MAX_AUTHOR_LENGTH}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  />
                  <p className="text-xs text-gray-500 mt-2">
                    Used as the author for published articles. You can use{' '}
                    <code className="bg-gray-100 px-1 py-0.5 rounded text-purple-600">{`{Storename}`}</code> to automatically insert your
                    store name.
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                <h2 className="text-base sm:text-lg font-semibold text-gray-900">Content Strategy</h2>
                <p className="text-xs sm:text-sm text-gray-500 mt-1">
                  Guide what topics and keywords to focus on. The system will prioritize these in article generation.
                </p>
              </div>
              <div className="p-4 sm:p-5 lg:p-6 space-y-6">
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
                          handleAddTopic();
                        }
                      }}
                      placeholder="Add a topic (e.g., 'sustainable fashion')"
                      maxLength={MAX_TOPIC_LENGTH}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    />
                    <button
                      onClick={handleAddTopic}
                      className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors"
                      type="button"
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
                          <button onClick={() => handleRemoveTopic(idx)} className="text-purple-600 hover:text-purple-800" type="button">
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
                          handleAddKeyword();
                        }
                      }}
                      placeholder="Add a keyword (e.g., 'organic cotton')"
                      maxLength={MAX_KEYWORD_LENGTH}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    />
                    <button
                      onClick={handleAddKeyword}
                      className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors"
                      type="button"
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
                          <button onClick={() => handleRemoveKeyword(idx)} className="text-blue-600 hover:text-blue-800" type="button">
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-2">SEO keywords to prioritize. Articles will naturally incorporate these when relevant.</p>
                </div>

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
                          handleAddAngle();
                        }
                      }}
                      placeholder="Add an angle (e.g., 'how-to guides', 'product comparisons')"
                      maxLength={MAX_ANGLE_LENGTH}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    />
                    <button
                      onClick={handleAddAngle}
                      className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors"
                      type="button"
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
                          <button onClick={() => handleRemoveAngle(idx)} className="text-green-600 hover:text-green-800" type="button">
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-2">Preferred content formats or approaches. Examples: tutorials, reviews, comparisons, guides.</p>
                </div>
              </div>
            </div>

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

            <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <div className="p-4 sm:p-5 lg:p-6 border-b border-gray-200">
                <h2 className="text-base sm:text-lg font-semibold text-gray-900">Billing</h2>
              </div>
              <div className="p-4 sm:p-5 lg:p-6 space-y-4 sm:space-y-5">
                {hasNoActivePlan && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
                    <div className="flex items-start gap-3">
                      <svg className="w-5 h-5 text-yellow-600 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                          clipRule="evenodd"
                        />
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
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">Current Plan</label>
                  <div className="px-3 py-2.5 sm:py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900">
                    {isLoading ? 'Loading...' : planName}
                  </div>
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                    {isQuotaStatus(quota) && quota.is_trial ? 'Trial Ends' : 'Renewal Date'}
                  </label>
                  <div className="px-3 py-2.5 sm:py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900">
                    {isLoading ? 'Loading...' : formatRenewalDate(renewalDate)}
                  </div>
                </div>
                <div className="pt-2 border-t border-gray-200">
                  <button
                    onClick={() => setIsPlansModalOpen(true)}
                    className="w-full sm:w-auto px-4 py-2.5 sm:py-2 bg-purple-600 text-white rounded-lg text-sm sm:text-base font-medium hover:bg-purple-700 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2"
                    type="button"
                  >
                    Manage Subscription
                  </button>
                </div>
              </div>
            </div>

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
                    type="button"
                  >
                    Reset
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <PlansModal
        isOpen={isPlansModalOpen}
        onClose={() => setIsPlansModalOpen(false)}
        currentPlanName={planName}
        storeId={store?.id}
      />
    </div>
  );
}
