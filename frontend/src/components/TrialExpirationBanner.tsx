import { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppBridge, useAppBridgeToast } from '../hooks/useAppBridge';
import { getShopDomain } from '../lib/app-bridge';
import type { QuotaStatus } from '../lib/api-client';

interface TrialExpirationBannerProps {
  quota: QuotaStatus | null;
  publishedCount: number;
  scheduledCount: number;
  draftsCount: number;
  onUpgrade?: () => void;
}

interface BannerState {
  daysRemaining: number;
  isExpired: boolean;
  urgency: 'gentle' | 'moderate' | 'urgent' | 'critical';
  canDismiss: boolean;
  color: string;
  bgColor: string;
  borderColor: string;
}

function calculateBannerState(trialEndsAt: string | null): BannerState | null {
  if (!trialEndsAt) return null;

  const now = new Date();
  const endDate = new Date(trialEndsAt);
  const diffTime = endDate.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    // Expired
    return {
      daysRemaining: 0,
      isExpired: true,
      urgency: 'critical',
      canDismiss: false,
      color: 'text-red-800',
      bgColor: 'bg-red-50',
      borderColor: 'border-red-200',
    };
  }

  // Days 1-7 remaining: Don't show (trial days 1-7)
  if (diffDays > 7) {
    return null;
  }

  // Days 5-7 remaining: Gentle reminder (trial days 8-10)
  if (diffDays >= 5 && diffDays <= 7) {
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

  // Days 3-4 remaining: Moderate urgency (trial days 11-12)
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

  // Day 2 remaining: Urgent (trial day 13)
  if (diffDays === 2) {
    return {
      daysRemaining: diffDays,
      isExpired: false,
      urgency: 'urgent',
      canDismiss: false,
      color: 'text-orange-800',
      bgColor: 'bg-orange-50',
      borderColor: 'border-orange-200',
    };
  }

  // Day 1 remaining: Critical (trial day 14 - last day)
  if (diffDays === 1) {
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

  // Day 0 (expires today): Critical
  if (diffDays === 0) {
    return {
      daysRemaining: 0,
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

function getBannerMessage(
  state: BannerState,
  publishedCount: number,
  scheduledCount: number,
  draftsCount: number,
): { title: string; description: string } {
  const totalArticles = publishedCount + scheduledCount + draftsCount;

  if (state.isExpired) {
    return {
      title: 'Your trial has ended',
      description: `You've published ${publishedCount} article${publishedCount !== 1 ? 's' : ''}, scheduled ${scheduledCount}, and created ${draftsCount} draft${draftsCount !== 1 ? 's' : ''}. Upgrade now to continue creating content and keep your progress.`,
    };
  }

  if (state.urgency === 'gentle') {
    return {
      title: `${state.daysRemaining} day${state.daysRemaining !== 1 ? 's' : ''} left in your trial`,
      description: `Great progress! You've published ${publishedCount} article${publishedCount !== 1 ? 's' : ''}${scheduledCount > 0 ? `, scheduled ${scheduledCount}` : ''}${draftsCount > 0 ? `, and created ${draftsCount} draft${draftsCount !== 1 ? 's' : ''}` : ''}. With a paid plan, you can continue publishing articles and keep growing your content.`,
    };
  }

  if (state.urgency === 'moderate') {
    return {
      title: `${state.daysRemaining} day${state.daysRemaining !== 1 ? 's' : ''} left in your trial`,
      description: `You've published ${publishedCount} article${publishedCount !== 1 ? 's' : ''}${totalArticles > publishedCount ? ` and created ${totalArticles - publishedCount} more` : ''}. Don't lose your progress - upgrade to continue publishing articles.`,
    };
  }

  if (state.urgency === 'urgent') {
    return {
      title: 'Your trial ends tomorrow',
      description: `You've created ${totalArticles} article${totalArticles !== 1 ? 's' : ''} (${publishedCount} published, ${scheduledCount} scheduled, ${draftsCount} draft${draftsCount !== 1 ? 's' : ''}). Upgrade now to keep all your content and continue growing your blog.`,
    };
  }

  // Critical (last day or expired)
  if (state.daysRemaining === 0 && !state.isExpired) {
    return {
      title: 'Last day of your trial',
      description: `Time is running out! You've published ${publishedCount} article${publishedCount !== 1 ? 's' : ''} and created ${totalArticles} total piece${totalArticles !== 1 ? 's' : ''} of content. Upgrade now to avoid losing access to your work.`,
    };
  }

  // Expired
  return {
    title: 'Your trial has ended',
    description: `You've published ${publishedCount} article${publishedCount !== 1 ? 's' : ''}, scheduled ${scheduledCount}, and created ${draftsCount} draft${draftsCount !== 1 ? 's' : ''}. Upgrade now to continue creating content and keep your progress.`,
  };
}

const DISMISSAL_STORAGE_KEY = 'trial_banner_dismissed';

export default function TrialExpirationBanner({
  quota,
  publishedCount,
  scheduledCount,
  draftsCount,
  onUpgrade,
}: TrialExpirationBannerProps) {
  const navigate = useNavigate();
  const appBridge = useAppBridge();
  const { showToast } = useAppBridgeToast();
  const [isDismissed, setIsDismissed] = useState(false);

  const bannerState = useMemo(() => {
    if (!quota?.is_trial || !quota.trial_ends_at) return null;
    return calculateBannerState(quota.trial_ends_at);
  }, [quota]);

  // Check localStorage for dismissal state
  useEffect(() => {
    if (!bannerState) return;

    const dismissedDate = localStorage.getItem(DISMISSAL_STORAGE_KEY);
    if (dismissedDate && bannerState.canDismiss) {
      const dismissed = new Date(dismissedDate);
      const now = new Date();
      const daysSinceDismissal = Math.floor((now.getTime() - dismissed.getTime()) / (1000 * 60 * 60 * 24));

      // If dismissed today and banner is dismissible, keep it dismissed
      if (daysSinceDismissal === 0) {
        setIsDismissed(true);
      } else {
        // Clear old dismissal if it's been more than a day
        localStorage.removeItem(DISMISSAL_STORAGE_KEY);
        setIsDismissed(false);
      }
    } else {
      setIsDismissed(false);
    }
  }, [bannerState]);

  const handleDismiss = useCallback(() => {
    if (!bannerState?.canDismiss) return;
    localStorage.setItem(DISMISSAL_STORAGE_KEY, new Date().toISOString());
    setIsDismissed(true);
  }, [bannerState]);

  const handleUpgrade = useCallback(() => {
    if (onUpgrade) {
      onUpgrade();
    } else {
      // Fallback to original behavior if no callback provided
      try {
        const shopDomain = getShopDomain();
        // Use App Bridge to navigate to billing page if available
        if (appBridge.isReady && appBridge.navigate) {
          appBridge.navigate('/settings/billing');
        } else {
          // Fallback: construct Shopify admin billing URL
          const shop = shopDomain || appBridge.shop;
          if (shop) {
            const billingUrl = `https://${shop}/admin/settings/billing`;
            if (appBridge.isEmbedded) {
              window.location.href = billingUrl;
            } else {
              window.open(billingUrl, '_blank');
            }
          } else {
            // Fallback to settings page
            navigate('/settings');
            showToast({ message: 'Please navigate to the Billing section to upgrade', isError: false });
          }
        }
      } catch (error) {
        console.error('Failed to navigate to billing:', error);
        // Fallback to settings page
        navigate('/settings');
        showToast({ message: 'Please navigate to the Billing section to upgrade', isError: false });
      }
    }
  }, [onUpgrade, appBridge, navigate, showToast]);

  // Don't show if:
  // - Not on trial
  // - Banner state is null (days 1-7)
  // - Dismissed and can be dismissed
  if (!bannerState || isDismissed) {
    return null;
  }

  const message = getBannerMessage(bannerState, publishedCount, scheduledCount, draftsCount);

  return (
    <div
      className={`${bannerState.bgColor} ${bannerState.borderColor} border-l-4 p-4 mb-6 rounded-r-lg shadow-sm`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <h3 className={`${bannerState.color} text-base font-semibold mb-1`}>
            {message.title}
          </h3>
          <p className={`${bannerState.color} text-sm opacity-90 mb-3`}>
            {message.description}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleUpgrade}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors touch-manipulation focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                bannerState.urgency === 'critical' || bannerState.urgency === 'urgent'
                  ? 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500'
                  : bannerState.urgency === 'moderate'
                  ? 'bg-yellow-600 text-white hover:bg-yellow-700 focus:ring-yellow-500'
                  : 'bg-green-600 text-white hover:bg-green-700 focus:ring-green-500'
              }`}
            >
              {bannerState.isExpired ? 'Upgrade Now' : 'Upgrade to Continue'}
            </button>
            {bannerState.urgency === 'gentle' && (
              <button
                onClick={handleDismiss}
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
            className={`ml-4 ${bannerState.color} opacity-70 hover:opacity-100 transition-opacity touch-manipulation focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 rounded`}
            aria-label="Dismiss banner"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
