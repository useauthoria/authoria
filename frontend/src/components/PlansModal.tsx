import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '../lib/api-client';
import { useAppBridge, useAppBridgeToast } from '../hooks/useAppBridge';
import { formatAPIErrorMessage } from '../utils/error-messages';

interface Plan {
  readonly id: string;
  readonly plan_name: string;
  readonly price_monthly: number | string;
  readonly price_annual: number | string | null;
  readonly article_limit_monthly: number;
}

interface PlansModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly currentPlanName: string | null;
  readonly storeId?: string;
}

interface Feature {
  readonly name: string;
  readonly description?: string;
  readonly starter: boolean | string;
  readonly publisher: boolean | string;
}

interface SubscriptionResponse {
  readonly confirmationUrl?: string;
  readonly error?: unknown;
}

const FEATURES: readonly Feature[] = [
  {
    name: 'Articles per Month',
    description: 'Maximum articles you can generate each month',
    starter: '12',
    publisher: '30',
  },
  {
    name: 'Auto-Submit Sitemap',
    description:
      'Automatically submit sitemap to Google Search Console when articles publish',
    starter: true,
    publisher: true,
  },
  {
    name: 'Featured Image Generation',
    description: 'AI-generated featured images for every article',
    starter: true,
    publisher: true,
  },
  {
    name: 'SEO Optimization',
    description: 'Structured data, meta descriptions, SEO titles, and health scoring',
    starter: true,
    publisher: true,
  },
  {
    name: 'Analytics Dashboard',
    description: 'Track impressions, clicks, CTR, and conversions',
    starter: true,
    publisher: true,
  },
  {
    name: 'Google Analytics Integration',
    description: 'Track article performance with Google Analytics 4',
    starter: true,
    publisher: true,
  },
  {
    name: 'Google Search Console Integration',
    description: 'Monitor search performance and indexing status',
    starter: true,
    publisher: true,
  },
  {
    name: 'Content Quality Validation',
    description: 'AI-powered quality scoring and recommendations',
    starter: true,
    publisher: true,
  },
  {
    name: 'Brand Voice Customization',
    description: 'Customize brand DNA, tone matrix, and audience personas',
    starter: true,
    publisher: true,
  },
  {
    name: 'Internal Linking',
    description: 'Automatic internal links between related articles',
    starter: true,
    publisher: true,
  },
  {
    name: 'Keyword Mining',
    description: 'AI-powered keyword research and clustering',
    starter: true,
    publisher: true,
  },
  {
    name: 'Scheduled Publishing',
    description: 'Schedule articles to publish at specific dates and times',
    starter: true,
    publisher: true,
  },
  {
    name: 'Approval Workflow',
    description: 'Review and approve articles before publishing',
    starter: true,
    publisher: true,
  },
  {
    name: 'Content Strategy',
    description: 'Topic preferences, keyword focus, and content angles',
    starter: true,
    publisher: true,
  },
  {
    name: 'Citations & Sources',
    description: 'Automatic fact-checking and citation generation',
    starter: true,
    publisher: true,
  },
  {
    name: 'Multiple Content Structures',
    description: 'How-to, listicle, comparison, tutorial, case-study formats',
    starter: true,
    publisher: true,
  },
  {
    name: 'Email Notifications',
    description: 'Get notified when articles are published or scheduled',
    starter: true,
    publisher: true,
  },
  {
    name: 'Brand Safety Filters',
    description: 'Automatic filtering of disallowed claims and blacklisted words',
    starter: true,
    publisher: true,
  },
] as const;

const FREE_TRIAL_PLAN = 'free_trial';
const MONTHS_PER_YEAR = 12;
const DEFAULT_ANNUAL_MULTIPLIER = 10;
const ANNUAL_DISCOUNT_PERCENTAGE = 17;
const MAX_PLAN_NAME_LENGTH = 100;
const MAX_STORE_ID_LENGTH = 200;

const validatePlanName = (planName: string): void => {
  if (!planName || typeof planName !== 'string' || planName.trim().length === 0) {
    throw new Error('Invalid plan name: must be a non-empty string');
  }
  if (planName.length > MAX_PLAN_NAME_LENGTH) {
    throw new Error(`Invalid plan name: exceeds maximum length of ${MAX_PLAN_NAME_LENGTH}`);
  }
};

const validateStoreId = (storeId: string | undefined): void => {
  if (storeId !== undefined && (typeof storeId !== 'string' || storeId.trim().length === 0)) {
    throw new Error('Invalid store ID: must be a non-empty string');
  }
  if (storeId && storeId.length > MAX_STORE_ID_LENGTH) {
    throw new Error(`Invalid store ID: exceeds maximum length of ${MAX_STORE_ID_LENGTH}`);
  }
};

const formatPlanName = (planName: string): string => {
  return planName
    .split('_')
    .map((word) => {
      if (word.length === 0) return '';
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
};

const parsePrice = (price: number | string): number => {
  if (typeof price === 'number') {
    return Number.isFinite(price) && price >= 0 ? price : 0;
  }
  if (typeof price === 'string') {
    const parsed = Number.parseFloat(price);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  return 0;
};

const calculateAnnualPrice = (monthlyPrice: number, annualPrice: number | string | null): number => {
  const parsedMonthly = parsePrice(monthlyPrice);
  if (annualPrice !== null && annualPrice !== undefined) {
    const parsedAnnual = parsePrice(annualPrice);
    return parsedAnnual > 0 ? parsedAnnual : parsedMonthly * DEFAULT_ANNUAL_MULTIPLIER;
  }
  return parsedMonthly * DEFAULT_ANNUAL_MULTIPLIER;
};

const isPlanName = (planName: string): planName is 'starter' | 'publisher' => {
  return planName === 'starter' || planName === 'publisher';
};

const getFeatureValue = (feature: Feature, planName: string): boolean | string => {
  if (!isPlanName(planName)) {
    return false;
  }
  return planName === 'starter' ? feature.starter : feature.publisher;
};

const formatFeatureValue = (value: boolean | string): string => {
  if (typeof value === 'boolean') {
    return value ? '✓' : '—';
  }
  return String(value);
};

export default function PlansModal({
  isOpen,
  onClose,
  currentPlanName,
  storeId,
}: PlansModalProps): JSX.Element | null {
  validateStoreId(storeId);

  const isMountedRef = useRef(true);
  const [plans, setPlans] = useState<readonly Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingPlan, setProcessingPlan] = useState<string | null>(null);
  const [isAnnual, setIsAnnual] = useState(false);
  const appBridge = useAppBridge();
  const { showToast } = useAppBridgeToast();

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isOpen || !isMountedRef.current) {
      return;
    }

    let isCancelled = false;

    const fetchPlans = async (): Promise<void> => {
      try {
        setLoading(true);
        const { data, error } = await supabase
          .from('plan_limits')
          .select('id, plan_name, price_monthly, price_annual, article_limit_monthly')
          .neq('plan_name', FREE_TRIAL_PLAN)
          .order('price_monthly', { ascending: true });

        if (error) {
          throw error;
        }

        if (!isCancelled && isMountedRef.current) {
          const validatedPlans = (data || []).filter(
            (plan): plan is Plan =>
              plan !== null &&
              typeof plan === 'object' &&
              typeof plan.id === 'string' &&
              typeof plan.plan_name === 'string' &&
              (typeof plan.price_monthly === 'number' ||
                typeof plan.price_monthly === 'string') &&
              (plan.price_annual === null ||
                typeof plan.price_annual === 'number' ||
                typeof plan.price_annual === 'string') &&
              typeof plan.article_limit_monthly === 'number',
          );
          setPlans(validatedPlans);
        }
      } catch (error) {
        if (!isCancelled && isMountedRef.current) {
          const errorMessage = formatAPIErrorMessage(error, {
            action: 'load plans',
            resource: 'plans',
          });
          showToast(errorMessage, { isError: true });
        }
      } finally {
        if (!isCancelled && isMountedRef.current) {
          setLoading(false);
        }
      }
    };

    fetchPlans().catch(() => {
    });

    return () => {
      isCancelled = true;
    };
  }, [isOpen, showToast]);

  const handleToggleAnnual = useCallback((): void => {
    if (isMountedRef.current) {
      setIsAnnual((prev) => !prev);
    }
  }, []);

  const handleSelectPlan = useCallback(
    async (planName: string): Promise<void> => {
      if (!isMountedRef.current) {
        return;
      }

      try {
        validatePlanName(planName);

        if (!storeId || typeof storeId !== 'string' || storeId.trim().length === 0) {
          showToast('Store information is missing. Please refresh the page.', {
            isError: true,
          });
          return;
        }

        validateStoreId(storeId);

        setProcessingPlan(planName);

        if (typeof window === 'undefined' || !window.location) {
          throw new Error('Window location is not available');
        }

        const returnUrl = window.location.href;
        if (returnUrl.length > 2000) {
          throw new Error('Return URL exceeds maximum length');
        }

        const { data, error } = await supabase.functions.invoke<
          SubscriptionResponse
        >('shopify-api/create-subscription', {
          body: {
            storeId: storeId.trim(),
            planName: planName.trim(),
            isAnnual,
            returnUrl,
          },
        });

        if (error) {
          throw error;
        }

        if (!isMountedRef.current) {
          return;
        }

        const confirmationUrl = data?.confirmationUrl;
        if (!confirmationUrl || typeof confirmationUrl !== 'string') {
          throw new Error('No confirmation URL returned');
        }

        if (confirmationUrl.length > 2000) {
          throw new Error('Confirmation URL exceeds maximum length');
        }

        if (appBridge.isEmbedded) {
          if (typeof window.open === 'function') {
            window.open(confirmationUrl, '_top');
          } else if (typeof window.location !== 'undefined') {
            window.location.href = confirmationUrl;
          }
        } else {
          if (typeof window.location !== 'undefined') {
            window.location.href = confirmationUrl;
          }
        }

        onClose();
      } catch (error) {
        if (isMountedRef.current) {
          const errorMessage = formatAPIErrorMessage(error, {
            action: 'create subscription',
            resource: 'billing',
          });
          showToast(errorMessage, { isError: true });
        }
      } finally {
        if (isMountedRef.current) {
          setProcessingPlan(null);
        }
      }
    },
    [storeId, isAnnual, appBridge.isEmbedded, onClose, showToast],
  );

  const handleClose = useCallback((): void => {
    if (isMountedRef.current && onClose) {
      onClose();
    }
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      if (e.target === e.currentTarget && isMountedRef.current) {
        handleClose();
      }
    },
    [handleClose],
  );

  const formattedPlans = useMemo(() => {
    return plans.map((plan) => {
      const monthlyPrice = parsePrice(plan.price_monthly);
      const planAnnualPrice = plan.price_annual;
      const annualPrice = calculateAnnualPrice(monthlyPrice, planAnnualPrice);
      const displayPrice = isAnnual ? annualPrice : monthlyPrice;
      const pricePerMonth = isAnnual ? annualPrice / MONTHS_PER_YEAR : monthlyPrice;
      const savings = isAnnual
        ? monthlyPrice * MONTHS_PER_YEAR - annualPrice
        : 0;

      return {
        ...plan,
        monthlyPrice,
        annualPrice,
        displayPrice,
        pricePerMonth,
        savings,
      };
    });
  }, [plans, isAnnual]);

  const currentPlanDisplay = useMemo(() => {
    if (!currentPlanName || currentPlanName === FREE_TRIAL_PLAN) {
      return null;
    }
    return formatPlanName(currentPlanName);
  }, [currentPlanName]);

  const isOnFreeTrial = useMemo(() => {
    return currentPlanName === FREE_TRIAL_PLAN;
  }, [currentPlanName]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto"
      aria-labelledby="modal-title"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="fixed inset-0 bg-gray-900 bg-opacity-75 transition-opacity"
        onClick={handleBackdropClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            handleClose();
          }
        }}
        aria-label="Close modal"
      />
      <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
        <div className="relative transform overflow-hidden rounded-2xl bg-white text-left shadow-2xl transition-all sm:my-8 sm:w-full sm:max-w-5xl">
          <div className="bg-gradient-to-r from-purple-600 to-blue-600 px-6 pt-6 pb-4 sm:px-8 sm:pt-8 sm:pb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-3xl font-bold text-white" id="modal-title">
                  Choose Your Plan
                </h3>
                <p className="mt-2 text-purple-100 text-sm sm:text-base">
                  Select the perfect plan for your content needs
                </p>
              </div>
              <button
                onClick={handleClose}
                type="button"
                className="text-white hover:text-purple-200 focus:outline-none focus:ring-2 focus:ring-white rounded-lg p-1 transition-colors"
                aria-label="Close modal"
              >
                <svg
                  className="h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            {currentPlanDisplay && (
              <p className="text-sm text-purple-100">
                Current plan:{' '}
                <span className="font-semibold text-white">{currentPlanDisplay}</span>
              </p>
            )}
            {isOnFreeTrial && (
              <p className="text-sm text-purple-100 font-medium">
                You&apos;re currently on a free trial. Choose a plan to continue.
              </p>
            )}
          </div>

          <div className="bg-gray-50 px-6 py-4 sm:px-8 sm:py-5 border-b border-gray-200">
            <div className="flex items-center justify-center gap-4">
              <span
                className={`text-sm font-semibold ${
                  !isAnnual ? 'text-gray-900' : 'text-gray-500'
                }`}
              >
                Monthly
              </span>
              <button
                type="button"
                onClick={handleToggleAnnual}
                className={`relative inline-flex h-7 w-14 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 ${
                  isAnnual ? 'bg-purple-600' : 'bg-gray-300'
                }`}
                aria-label={isAnnual ? 'Switch to monthly billing' : 'Switch to annual billing'}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform shadow-md ${
                    isAnnual ? 'translate-x-8' : 'translate-x-1'
                  }`}
                />
              </button>
              <span
                className={`text-sm font-semibold ${
                  isAnnual ? 'text-gray-900' : 'text-gray-500'
                }`}
              >
                Annual
              </span>
              {isAnnual && (
                <span className="text-xs text-green-700 font-bold bg-green-100 px-3 py-1.5 rounded-full border border-green-300">
                  Save {ANNUAL_DISCOUNT_PERCENTAGE}%
                </span>
              )}
            </div>
          </div>

          <div className="bg-white px-6 py-6 sm:px-8 sm:py-8">
            {loading ? (
              <div className="text-center py-12">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600" />
                <p className="mt-2 text-sm text-gray-500">Loading plans...</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 max-w-4xl mx-auto mb-8">
                  {formattedPlans.map((plan) => {
                    const isCurrentPlan = currentPlanName === plan.plan_name;
                    const isPublisher = plan.plan_name === 'publisher';

                    return (
                      <div
                        key={plan.id}
                        className={`relative rounded-xl border-2 transition-all ${
                          isPublisher
                            ? 'border-purple-600 bg-gradient-to-br from-purple-50 to-blue-50 shadow-xl z-10'
                            : isCurrentPlan
                              ? 'border-purple-400 bg-purple-50 shadow-lg'
                              : 'border-gray-200 bg-white shadow-sm hover:shadow-md'
                        }`}
                      >
                        {isPublisher && (
                          <div className="absolute -top-4 left-1/2 transform -translate-x-1/2 z-20">
                            <span className="bg-gradient-to-r from-purple-600 to-blue-600 text-white text-xs font-bold px-4 py-1.5 rounded-full shadow-lg">
                              Most Popular
                            </span>
                          </div>
                        )}

                        {isCurrentPlan && !isPublisher && (
                          <div className="absolute -top-4 left-1/2 transform -translate-x-1/2 z-20">
                            <span className="bg-green-600 text-white text-xs font-bold px-4 py-1.5 rounded-full shadow-lg">
                              Current Plan
                            </span>
                          </div>
                        )}

                        <div className="p-8">
                          <div className="text-center mb-6">
                            <h4 className="text-2xl font-bold text-gray-900 mb-4">
                              {formatPlanName(plan.plan_name)}
                            </h4>

                            <div className="mb-4">
                              <div className="inline-flex items-center justify-center bg-purple-100 rounded-lg px-4 py-2 mb-2">
                                <svg
                                  className="w-5 h-5 text-purple-600 mr-2"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                  aria-hidden="true"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                  />
                                </svg>
                                <span className="text-2xl font-bold text-purple-900">
                                  {plan.article_limit_monthly}
                                </span>
                                <span className="text-sm text-purple-700 ml-1">
                                  articles/month
                                </span>
                              </div>
                            </div>

                            <div className="mb-4">
                              <div className="flex items-baseline justify-center">
                                <span className="text-5xl font-extrabold text-gray-900">
                                  ${plan.displayPrice.toFixed(0)}
                                </span>
                                {isAnnual ? (
                                  <span className="ml-2 text-xl text-gray-500">/year</span>
                                ) : (
                                  <span className="ml-2 text-xl text-gray-500">/month</span>
                                )}
                              </div>
                              {isAnnual && (
                                <div className="mt-2">
                                  <p className="text-sm text-gray-600">
                                    ${plan.pricePerMonth.toFixed(2)}/month
                                  </p>
                                  {plan.savings > 0 && (
                                    <p className="text-xs text-green-600 font-medium mt-1">
                                      Save ${plan.savings.toFixed(0)}/year
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="space-y-2 mb-6 text-left">
                            <div className="flex items-center text-sm text-gray-700">
                              <svg
                                className="h-4 w-4 text-green-500 mr-2 flex-shrink-0"
                                fill="currentColor"
                                viewBox="0 0 20 20"
                                aria-hidden="true"
                              >
                                <path
                                  fillRule="evenodd"
                                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                                  clipRule="evenodd"
                                />
                              </svg>
                              <span>All premium features included</span>
                            </div>
                            <div className="flex items-center text-sm text-gray-700">
                              <svg
                                className="h-4 w-4 text-green-500 mr-2 flex-shrink-0"
                                fill="currentColor"
                                viewBox="0 0 20 20"
                                aria-hidden="true"
                              >
                                <path
                                  fillRule="evenodd"
                                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                                  clipRule="evenodd"
                                />
                              </svg>
                              <span>AI-powered content generation</span>
                            </div>
                            <div className="flex items-center text-sm text-gray-700">
                              <svg
                                className="h-4 w-4 text-green-500 mr-2 flex-shrink-0"
                                fill="currentColor"
                                viewBox="0 0 20 20"
                                aria-hidden="true"
                              >
                                <path
                                  fillRule="evenodd"
                                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                                  clipRule="evenodd"
                                />
                              </svg>
                              <span>Full SEO optimization</span>
                            </div>
                          </div>

                          <button
                            onClick={() => handleSelectPlan(plan.plan_name)}
                            disabled={isCurrentPlan || processingPlan === plan.plan_name}
                            type="button"
                            className={`w-full px-6 py-3 rounded-lg font-semibold text-base transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 transform hover:scale-105 ${
                              isCurrentPlan
                                ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                                : isPublisher
                                  ? 'bg-gradient-to-r from-purple-600 to-blue-600 text-white hover:from-purple-700 hover:to-blue-700 focus:ring-purple-500 shadow-lg'
                                  : 'bg-gray-900 text-white hover:bg-gray-800 focus:ring-gray-500'
                            }`}
                          >
                            {processingPlan === plan.plan_name
                              ? 'Processing...'
                              : isCurrentPlan
                                ? 'Current Plan'
                                : 'Select Plan'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="border-t border-gray-200 pt-8">
                  <h4 className="text-xl font-bold text-gray-900 mb-6 text-center">
                    Everything You Need to Succeed
                  </h4>
                  <div className="overflow-x-auto -mx-6 sm:mx-0">
                    <div className="inline-block min-w-full align-middle px-6 sm:px-0">
                      <table className="min-w-full">
                        <thead>
                          <tr className="border-b-2 border-gray-200">
                            <th className="text-left py-3 px-4 font-semibold text-gray-900">
                              Feature
                            </th>
                            {plans.map((plan) => (
                              <th
                                key={plan.id}
                                className={`text-center py-3 px-4 font-semibold ${
                                  plan.plan_name === 'publisher'
                                    ? 'text-purple-600'
                                    : 'text-gray-900'
                                }`}
                              >
                                {formatPlanName(plan.plan_name)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {FEATURES.map((feature, idx) => (
                            <tr
                              key={idx}
                              className={`border-b border-gray-100 ${
                                idx % 2 === 0 ? 'bg-gray-50' : 'bg-white'
                              }`}
                            >
                              <td className="py-4 px-4">
                                <div className="flex items-start">
                                  <div>
                                    <div className="font-medium text-gray-900 text-sm">
                                      {feature.name}
                                    </div>
                                    {feature.description && (
                                      <div className="text-xs text-gray-500 mt-0.5">
                                        {feature.description}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </td>
                              {plans.map((plan) => {
                                const value = getFeatureValue(feature, plan.plan_name);
                                const isIncluded =
                                  typeof value === 'boolean' ? value : true;
                                const displayValue = formatFeatureValue(value);

                                return (
                                  <td
                                    key={plan.id}
                                    className={`text-center py-4 px-4 ${
                                      plan.plan_name === 'publisher' ? 'bg-purple-50' : ''
                                    }`}
                                  >
                                    {typeof value === 'boolean' ? (
                                      <div className="flex items-center justify-center">
                                        {isIncluded ? (
                                          <svg
                                            className="h-6 w-6 text-green-500"
                                            fill="currentColor"
                                            viewBox="0 0 20 20"
                                            aria-hidden="true"
                                          >
                                            <path
                                              fillRule="evenodd"
                                              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                                              clipRule="evenodd"
                                            />
                                          </svg>
                                        ) : (
                                          <span className="text-gray-400 text-xl">—</span>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="font-semibold text-gray-900">
                                        {displayValue}
                                      </span>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                <div className="mt-8 text-center">
                  <p className="text-sm text-gray-600 mb-4">
                    All plans include a 14-day free trial. Cancel anytime.
                  </p>
                  <div className="flex items-center justify-center gap-6 text-xs text-gray-500">
                    <div className="flex items-center gap-1">
                      <svg
                        className="w-4 h-4 text-green-500"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <span>No credit card required</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <svg
                        className="w-4 h-4 text-green-500"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <span>Cancel anytime</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <svg
                        className="w-4 h-4 text-green-500"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <span>14-day money-back guarantee</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
