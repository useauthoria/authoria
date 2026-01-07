import { useState, useMemo, useEffect, useCallback, useRef, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppBridge, useAppBridgeToast } from '../hooks/useAppBridge';
import { getShopDomain } from '../lib/app-bridge';
import type { QuotaStatus } from '../lib/api-client';

interface TrialExpirationBannerProps {
  readonly quota: QuotaStatus | null;
  readonly publishedCount: number;
  readonly scheduledCount: number;
  readonly draftsCount: number;
  readonly onUpgrade?: () => void;
}

type Urgency = 'gentle' | 'moderate' | 'urgent' | 'critical';

interface BannerState {
  readonly daysRemaining: number;
  readonly isExpired: boolean;
  readonly urgency: Urgency;
  readonly canDismiss: boolean;
  readonly color: string;
  readonly bgColor: string;
  readonly borderColor: string;
}

interface BannerMessage {
  readonly title: string;
  readonly description: string;
}

const DISMISSAL_STORAGE_KEY = 'trial_banner_dismissed';
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MAX_DAYS_REMAINING = 7;
const MIN_DISMISS_DAYS = 5;
const MAX_DISMISS_DAYS = 7;
const URGENT_DAYS = 2;
const CRITICAL_DAYS = 1;
const EXPIRED_DAYS = 0;
const MIN_COUNT = 0;
const MAX_COUNT = 1000000;

const validateCount = (count: number | undefined): number => {
  if (count === undefined || count === null) {
    return MIN_COUNT;
  }
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    return MIN_COUNT;
  }
  if (count < MIN_COUNT) {
    return MIN_COUNT;
  }
  if (count > MAX_COUNT) {
    return MAX_COUNT;
  }
  return Math.floor(count);
};

const validateTrialEndsAt = (trialEndsAt: string | null | undefined): string | null => {
  if (!trialEndsAt || typeof trialEndsAt !== 'string') {
    return null;
  }
  const trimmed = trialEndsAt.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return trimmed;
};

const calculateDaysRemaining = (trialEndsAt: string): number => {
  try {
    const now = new Date();
    const endDate = new Date(trialEndsAt);
    if (!Number.isFinite(endDate.getTime())) {
      return -1;
    }
    const diffTime = endDate.getTime() - now.getTime();
    return Math.ceil(diffTime / MS_PER_DAY);
  } catch {
    return -1;
  }
};

function calculateBannerState(trialEndsAt: string | null): BannerState | null {
  if (!trialEndsAt) {
    return null;
  }

  const diffDays = calculateDaysRemaining(trialEndsAt);

  if (diffDays < EXPIRED_DAYS) {
    return {
      daysRemaining: EXPIRED_DAYS,
      isExpired: true,
      urgency: 'critical',
      canDismiss: false,
      color: 'text-red-800',
      bgColor: 'bg-red-50',
      borderColor: 'border-red-200',
    };
  }

  if (diffDays > MAX_DAYS_REMAINING) {
    return null;
  }

  if (diffDays >= MIN_DISMISS_DAYS && diffDays <= MAX_DISMISS_DAYS) {
    return {
      daysRemaining: diffDays,
      isExpired: false,
      urgency: 'gentle',
      canDismiss: true,
      color: 'text-green-800',
      bgColor: 'bg-green-50',
      borderColor: 'border-green-200',
    };
  }

  if (diffDays >= 3 && diffDays <= 4) {
    return {
      daysRemaining: diffDays,
      isExpired: false,
      urgency: 'moderate',
      canDismiss: true,
      color: 'text-yellow-800',
      bgColor: 'bg-yellow-50',
      borderColor: 'border-yellow-200',
    };
  }

  if (diffDays === URGENT_DAYS) {
    return {
      daysRemaining: URGENT_DAYS,
      isExpired: false,
      urgency: 'urgent',
      canDismiss: false,
      color: 'text-orange-800',
      bgColor: 'bg-orange-50',
      borderColor: 'border-orange-200',
    };
  }

  if (diffDays === CRITICAL_DAYS || diffDays === EXPIRED_DAYS) {
    return {
      daysRemaining: diffDays,
      isExpired: false,
      urgency: 'critical',
      canDismiss: false,
      color: 'text-red-800',
      bgColor: 'bg-red-50',
      borderColor: 'border-red-200',
    };
  }

  return null;
}

const pluralize = (count: number, singular: string, plural: string): string => {
  return count === 1 ? singular : plural;
};

function getBannerMessage(
  state: BannerState,
  publishedCount: number,
  scheduledCount: number,
  draftsCount: number,
): BannerMessage {
  const validatedPublished = validateCount(publishedCount);
  const validatedScheduled = validateCount(scheduledCount);
  const validatedDrafts = validateCount(draftsCount);
  const totalArticles = validatedPublished + validatedScheduled + validatedDrafts;

  if (state.isExpired) {
    return {
      title: 'Your trial has ended',
      description: `You've published ${validatedPublished} ${pluralize(validatedPublished, 'article', 'articles')}, scheduled ${validatedScheduled}, and created ${validatedDrafts} ${pluralize(validatedDrafts, 'draft', 'drafts')}. Upgrade now to continue creating content and keep your progress.`,
    };
  }

  if (state.urgency === 'gentle') {
    const scheduledText = validatedScheduled > 0 ? `, scheduled ${validatedScheduled}` : '';
    const draftsText = validatedDrafts > 0
      ? `, and created ${validatedDrafts} ${pluralize(validatedDrafts, 'draft', 'drafts')}`
      : '';
    return {
      title: `${state.daysRemaining} ${pluralize(state.daysRemaining, 'day', 'days')} left in your trial`,
      description: `Great progress! You've published ${validatedPublished} ${pluralize(validatedPublished, 'article', 'articles')}${scheduledText}${draftsText}. With a paid plan, you can continue publishing articles and keep growing your content.`,
    };
  }

  if (state.urgency === 'moderate') {
    const moreText = totalArticles > validatedPublished
      ? ` and created ${totalArticles - validatedPublished} more`
      : '';
    return {
      title: `${state.daysRemaining} ${pluralize(state.daysRemaining, 'day', 'days')} left in your trial`,
      description: `You've published ${validatedPublished} ${pluralize(validatedPublished, 'article', 'articles')}${moreText}. Don't lose your progress - upgrade to continue publishing articles.`,
    };
  }

  if (state.urgency === 'urgent') {
    return {
      title: 'Your trial ends tomorrow',
      description: `You've created ${totalArticles} ${pluralize(totalArticles, 'article', 'articles')} (${validatedPublished} published, ${validatedScheduled} scheduled, ${validatedDrafts} ${pluralize(validatedDrafts, 'draft', 'drafts')}). Upgrade now to keep all your content and continue growing your blog.`,
    };
  }

  if (state.daysRemaining === EXPIRED_DAYS && !state.isExpired) {
    return {
      title: 'Last day of your trial',
      description: `Time is running out! You've published ${validatedPublished} ${pluralize(validatedPublished, 'article', 'articles')} and created ${totalArticles} total ${pluralize(totalArticles, 'piece', 'pieces')} of content. Upgrade now to avoid losing access to your work.`,
    };
  }

  return {
    title: 'Your trial has ended',
    description: `You've published ${validatedPublished} ${pluralize(validatedPublished, 'article', 'articles')}, scheduled ${validatedScheduled}, and created ${validatedDrafts} ${pluralize(validatedDrafts, 'draft', 'drafts')}. Upgrade now to continue creating content and keep your progress.`,
  };
}

const getLocalStorageValue = (key: string): string | null => {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return null;
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const setLocalStorageValue = (key: string, value: string): void => {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
  }
};

const removeLocalStorageValue = (key: string): void => {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.removeItem(key);
  } catch {
  }
};

const calculateDaysSinceDismissal = (dismissedDate: string): number => {
  try {
    const dismissed = new Date(dismissedDate);
    if (!Number.isFinite(dismissed.getTime())) {
      return -1;
    }
    const now = new Date();
    return Math.floor((now.getTime() - dismissed.getTime()) / MS_PER_DAY);
  } catch {
    return -1;
  }
};

const buildBillingUrl = (shop: string): string => {
  const trimmed = shop.trim();
  if (trimmed.length === 0) {
    return '';
  }
  return `https://${trimmed}/admin/settings/billing`;
};

const CLOSE_ICON = (
  <svg
    className="w-5 h-5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M6 18L18 6M6 6l12 12"
    />
  </svg>
);

const TrialExpirationBanner = memo(function TrialExpirationBanner({
  quota,
  publishedCount,
  scheduledCount,
  draftsCount,
  onUpgrade,
}: TrialExpirationBannerProps): JSX.Element | null {
  const isMountedRef = useRef(true);
  const navigate = useNavigate();
  const appBridge = useAppBridge();
  const { showToast } = useAppBridgeToast();
  const [isDismissed, setIsDismissed] = useState(false);

  const validatedPublished = useMemo(() => validateCount(publishedCount), [publishedCount]);
  const validatedScheduled = useMemo(() => validateCount(scheduledCount), [scheduledCount]);
  const validatedDrafts = useMemo(() => validateCount(draftsCount), [draftsCount]);

  const validatedTrialEndsAt = useMemo(
    () => (quota?.is_trial ? validateTrialEndsAt(quota.trial_ends_at) : null),
    [quota],
  );

  const bannerState = useMemo(() => {
    if (!validatedTrialEndsAt) {
      return null;
    }
    return calculateBannerState(validatedTrialEndsAt);
  }, [validatedTrialEndsAt]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!bannerState || !isMountedRef.current) {
      return;
    }

    const dismissedDate = getLocalStorageValue(DISMISSAL_STORAGE_KEY);
    if (dismissedDate && bannerState.canDismiss) {
      const daysSince = calculateDaysSinceDismissal(dismissedDate);
      if (daysSince === 0 && isMountedRef.current) {
        setIsDismissed(true);
      } else if (daysSince > 0) {
        removeLocalStorageValue(DISMISSAL_STORAGE_KEY);
        if (isMountedRef.current) {
          setIsDismissed(false);
        }
      }
    } else if (isMountedRef.current) {
      setIsDismissed(false);
    }
  }, [bannerState]);

  const handleDismiss = useCallback(() => {
    if (!bannerState?.canDismiss || !isMountedRef.current) {
      return;
    }
    setLocalStorageValue(DISMISSAL_STORAGE_KEY, new Date().toISOString());
    if (isMountedRef.current) {
      setIsDismissed(true);
    }
  }, [bannerState]);

  const handleUpgrade = useCallback(() => {
    if (!isMountedRef.current) {
      return;
    }

    if (onUpgrade) {
      try {
        onUpgrade();
      } catch {
      }
      return;
    }

    try {
      const shopDomain = getShopDomain();
      const shop = shopDomain || appBridge.shop;

      if (appBridge.isReady && typeof appBridge.navigate === 'function') {
        appBridge.navigate('/settings/billing').catch(() => {
          if (isMountedRef.current && typeof navigate === 'function') {
            navigate('/settings');
            showToast('Please navigate to the Billing section to upgrade', {
              isError: false,
            }).catch(() => {
            });
          }
        });
        return;
      }

      if (shop && typeof shop === 'string' && shop.trim().length > 0) {
        const billingUrl = buildBillingUrl(shop);
        if (billingUrl.length > 0) {
          if (appBridge.isEmbedded && typeof window !== 'undefined' && window.location) {
            window.location.href = billingUrl;
          } else if (typeof window !== 'undefined' && typeof window.open === 'function') {
            window.open(billingUrl, '_blank');
          }
          return;
        }
      }

      if (isMountedRef.current && typeof navigate === 'function') {
        navigate('/settings');
        showToast('Please navigate to the Billing section to upgrade', {
          isError: false,
        }).catch(() => {
        });
      }
    } catch {
      if (isMountedRef.current && typeof navigate === 'function') {
        navigate('/settings');
        showToast('Please navigate to the Billing section to upgrade', {
          isError: false,
        }).catch(() => {
        });
      }
    }
  }, [onUpgrade, appBridge, navigate, showToast]);

  if (!bannerState || isDismissed) {
    return null;
  }

  const message = getBannerMessage(
    bannerState,
    validatedPublished,
    validatedScheduled,
    validatedDrafts,
  );

  const containerClassName = useMemo(
    () => `${bannerState.bgColor} ${bannerState.borderColor} border-l-4 p-4 mb-6 rounded-r-lg shadow-sm`,
    [bannerState.bgColor, bannerState.borderColor],
  );

  const titleClassName = useMemo(
    () => `${bannerState.color} text-base font-semibold mb-1`,
    [bannerState.color],
  );

  const descriptionClassName = useMemo(
    () => `${bannerState.color} text-sm opacity-90 mb-3`,
    [bannerState.color],
  );

  const isCriticalOrUrgent = bannerState.urgency === 'critical' || bannerState.urgency === 'urgent';
  const buttonClassName = useMemo(
    () => {
      const base =
        'px-4 py-2 rounded-lg text-sm font-medium transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-offset-2';
      if (isCriticalOrUrgent) {
        return `${base} bg-red-600 text-white hover:bg-red-700 focus:ring-red-500`;
      }
      if (bannerState.urgency === 'moderate') {
        return `${base} bg-yellow-600 text-white hover:bg-yellow-700 focus:ring-yellow-500`;
      }
      return `${base} bg-green-600 text-white hover:bg-green-700 focus:ring-green-500`;
    },
    [bannerState.urgency, isCriticalOrUrgent],
  );

  const closeButtonClassName = useMemo(
    () => `ml-4 ${bannerState.color} opacity-70 hover:opacity-100 transition-opacity touch-manipulation focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 rounded`,
    [bannerState.color],
  );

  return (
    <div className={containerClassName}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <h3 className={titleClassName}>{message.title}</h3>
          <p className={descriptionClassName}>{message.description}</p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleUpgrade}
              type="button"
              className={buttonClassName}
            >
              {bannerState.isExpired ? 'Upgrade Now' : 'Upgrade to Continue'}
            </button>
            {bannerState.urgency === 'gentle' && (
              <button
                onClick={handleDismiss}
                type="button"
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-100 transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
              >
                Remind me later
              </button>
            )}
          </div>
        </div>
        {bannerState.canDismiss && bannerState.urgency !== 'gentle' && (
          <button
            onClick={handleDismiss}
            type="button"
            className={closeButtonClassName}
            aria-label="Dismiss banner"
          >
            {CLOSE_ICON}
          </button>
        )}
      </div>
    </div>
  );
});

export default TrialExpirationBanner;
