import { useState, useEffect } from 'react';
import { supabase } from '../lib/api-client';
import { useAppBridge, useAppBridgeToast } from '../hooks/useAppBridge';
import { formatAPIErrorMessage } from '../utils/error-messages';

interface Plan {
  id: string;
  plan_name: string;
  price_monthly: number;
  price_annual: number | null;
  article_limit_monthly: number;
}

interface PlansModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentPlanName: string | null;
  storeId?: string;
}

interface Feature {
  name: string;
  description?: string;
  starter: boolean | string;
  publisher: boolean | string;
  authority: boolean | string;
}

const FEATURES: Feature[] = [
  {
    name: 'Articles per Month',
    description: 'Maximum articles you can generate each month',
    starter: '12',
    publisher: '30',
    authority: '60',
  },
  {
    name: 'Auto-Submit Sitemap',
    description: 'Automatically submit sitemap to Google Search Console when articles publish',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Featured Image Generation',
    description: 'AI-generated featured images for every article',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'SEO Optimization',
    description: 'Structured data, meta descriptions, SEO titles, and health scoring',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Analytics Dashboard',
    description: 'Track impressions, clicks, CTR, and conversions',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Google Analytics Integration',
    description: 'Track article performance with Google Analytics 4',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Google Search Console Integration',
    description: 'Monitor search performance and indexing status',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Content Quality Validation',
    description: 'AI-powered quality scoring and recommendations',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Brand Voice Customization',
    description: 'Customize brand DNA, tone matrix, and audience personas',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Internal Linking',
    description: 'Automatic internal links between related articles',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Keyword Mining',
    description: 'AI-powered keyword research and clustering',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Scheduled Publishing',
    description: 'Schedule articles to publish at specific dates and times',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Approval Workflow',
    description: 'Review and approve articles before publishing',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Content Strategy',
    description: 'Topic preferences, keyword focus, and content angles',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Citations & Sources',
    description: 'Automatic fact-checking and citation generation',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Multiple Content Structures',
    description: 'How-to, listicle, comparison, tutorial, case-study formats',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Email Notifications',
    description: 'Get notified when articles are published or scheduled',
    starter: true,
    publisher: true,
    authority: true,
  },
  {
    name: 'Brand Safety Filters',
    description: 'Automatic filtering of disallowed claims and blacklisted words',
    starter: true,
    publisher: true,
    authority: true,
  },
];

export default function PlansModal({ isOpen, onClose, currentPlanName, storeId }: PlansModalProps) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingPlan, setProcessingPlan] = useState<string | null>(null);
  const [isAnnual, setIsAnnual] = useState(false);
  const appBridge = useAppBridge();
  const { showToast } = useAppBridgeToast();

  useEffect(() => {
    if (!isOpen) return;

    const fetchPlans = async () => {
      try {
        setLoading(true);
        const { data, error } = await supabase
          .from('plan_limits')
          .select('id, plan_name, price_monthly, price_annual, article_limit_monthly')
          .neq('plan_name', 'free_trial')
          .order('price_monthly', { ascending: true });

        if (error) throw error;
        setPlans((data as Plan[]) || []);
      } catch (error) {
        console.error('Failed to fetch plans:', error);
        const errorMessage = formatAPIErrorMessage(error, { action: 'load plans', resource: 'plans' });
        showToast(errorMessage, { isError: true });
      } finally {
        setLoading(false);
      }
    };

    fetchPlans();
  }, [isOpen, showToast]);

  const formatPlanName = (planName: string): string => {
    return planName
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const calculateAnnualPrice = (monthlyPrice: number, annualPrice: number | null): number => {
    if (annualPrice !== null && annualPrice !== undefined) {
      return typeof annualPrice === 'string' ? parseFloat(annualPrice) : annualPrice;
    }
    return monthlyPrice * 10;
  };

  const handleSelectPlan = async (planName: string) => {
    if (!storeId) {
      showToast("Store information is missing. Please refresh the page.", { isError: true });
      return;
    }

    try {
      setProcessingPlan(planName);

      const { data, error } = await supabase.functions.invoke('shopify-api/create-subscription', {
        body: {
          storeId,
          planName,
          isAnnual,
          returnUrl: window.location.href, // Return to wherever we currently are
        },
      });

      if (error) throw error;

      if (data?.confirmationUrl) {
        // Redirect to Shopify confirmation URL
        if (appBridge.isEmbedded) {
          // If we are embedded, we might need to use appBridge to redirect, 
          // or top-level redirect if it's a Shopify Admin URL.
          // Shopify billing URLs are typically top-level.
          // Using window.top.location.href or appBridge.dispatch(Redirect.toRemote({ url }))

          // However, Shopify App Bridge 3/4 handles this often via simple window.open or href if allowed.
          // Given the context, let's try window.open which is safer for breaking out of iframe if needed,
          // or relying on Shopify to handle the 'admin.shopify.com' link correctly.
          // Best practice for billing is usually a top-level redirect.
          window.open(data.confirmationUrl, '_top');
        } else {
          window.location.href = data.confirmationUrl;
        }
        onClose();
      } else {
        throw new Error('No confirmation URL returned');
      }

    } catch (error) {
      console.error('Failed to create subscription:', error);
      const errorMessage = formatAPIErrorMessage(error, { action: 'create subscription', resource: 'billing' });
      showToast(errorMessage, { isError: true });
    } finally {
      setProcessingPlan(null);
    }
  };

  const getFeatureValue = (feature: Feature, planName: string): boolean | string => {
    switch (planName) {
      case 'starter':
        return feature.starter;
      case 'publisher':
        return feature.publisher;
      case 'authority':
        return feature.authority;
      default:
        return false;
    }
  };

  const formatFeatureValue = (value: boolean | string): string => {
    if (typeof value === 'boolean') {
      return value ? '✓' : '—';
    }
    return String(value);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="modal-title" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-gray-900 bg-opacity-75 transition-opacity"
        onClick={onClose}
      ></div>

      {/* Modal */}
      <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
        <div className="relative transform overflow-hidden rounded-2xl bg-white text-left shadow-2xl transition-all sm:my-8 sm:w-full sm:max-w-6xl">
          {/* Header */}
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
                onClick={onClose}
                className="text-white hover:text-purple-200 focus:outline-none focus:ring-2 focus:ring-white rounded-lg p-1 transition-colors"
                aria-label="Close modal"
              >
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {currentPlanName && currentPlanName !== 'free_trial' && (
              <p className="text-sm text-purple-100">
                Current plan: <span className="font-semibold text-white">{formatPlanName(currentPlanName)}</span>
              </p>
            )}
            {currentPlanName === 'free_trial' && (
              <p className="text-sm text-purple-100 font-medium">
                You're currently on a free trial. Choose a plan to continue.
              </p>
            )}
          </div>

          {/* Billing Toggle */}
          <div className="bg-gray-50 px-6 py-4 sm:px-8 sm:py-5 border-b border-gray-200">
            <div className="flex items-center justify-center gap-4">
              <span className={`text-sm font-semibold ${!isAnnual ? 'text-gray-900' : 'text-gray-500'}`}>
                Monthly
              </span>
              <button
                type="button"
                onClick={() => setIsAnnual(!isAnnual)}
                className={`relative inline-flex h-7 w-14 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 ${isAnnual ? 'bg-purple-600' : 'bg-gray-300'
                  }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform shadow-md ${isAnnual ? 'translate-x-8' : 'translate-x-1'
                    }`}
                />
              </button>
              <span className={`text-sm font-semibold ${isAnnual ? 'text-gray-900' : 'text-gray-500'}`}>
                Annual
              </span>
              {isAnnual && (
                <span className="text-xs text-green-700 font-bold bg-green-100 px-3 py-1.5 rounded-full border border-green-300">
                  Save 17%
                </span>
              )}
            </div>
          </div>

          {/* Plans Grid */}
          <div className="bg-white px-6 py-6 sm:px-8 sm:py-8">
            {loading ? (
              <div className="text-center py-12">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
                <p className="mt-2 text-sm text-gray-500">Loading plans...</p>
              </div>
            ) : (
              <>
                {/* Plan Cards */}
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-3 mb-8">
                  {plans.map((plan) => {
                    const isCurrentPlan = currentPlanName === plan.plan_name;
                    const isPublisher = plan.plan_name === 'publisher';
                    const monthlyPrice = typeof plan.price_monthly === 'string'
                      ? parseFloat(plan.price_monthly)
                      : plan.price_monthly;
                    const planAnnualPrice = plan.price_annual !== null && plan.price_annual !== undefined
                      ? (typeof plan.price_annual === 'string' ? parseFloat(plan.price_annual) : plan.price_annual)
                      : null;
                    const annualPrice = calculateAnnualPrice(monthlyPrice, planAnnualPrice);
                    const displayPrice = isAnnual ? annualPrice : monthlyPrice;
                    const pricePerMonth = isAnnual ? annualPrice / 12 : monthlyPrice;
                    const savings = isAnnual ? ((monthlyPrice * 12) - annualPrice) : 0;

                    return (
                      <div
                        key={plan.id}
                        className={`relative rounded-xl border-2 transition-all ${isPublisher
                          ? 'border-purple-600 bg-gradient-to-br from-purple-50 to-blue-50 shadow-xl scale-105 z-10'
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

                        <div className="p-6">
                          {/* Plan Header */}
                          <div className="text-center mb-6">
                            <h4 className="text-xl font-bold text-gray-900 mb-3">
                              {formatPlanName(plan.plan_name)}
                            </h4>

                            {/* Articles per Month - Prominent Display */}
                            <div className="mb-4">
                              <div className="inline-flex items-center justify-center bg-purple-100 rounded-lg px-4 py-2 mb-2">
                                <svg className="w-5 h-5 text-purple-600 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                                <span className="text-2xl font-bold text-purple-900">{plan.article_limit_monthly}</span>
                                <span className="text-sm text-purple-700 ml-1">articles/month</span>
                              </div>
                            </div>

                            {/* Price */}
                            <div className="mb-4">
                              <div className="flex items-baseline justify-center">
                                <span className="text-5xl font-extrabold text-gray-900">${displayPrice.toFixed(0)}</span>
                                {isAnnual && (
                                  <span className="ml-2 text-xl text-gray-500">/year</span>
                                )}
                                {!isAnnual && (
                                  <span className="ml-2 text-xl text-gray-500">/month</span>
                                )}
                              </div>
                              {isAnnual && (
                                <div className="mt-2">
                                  <p className="text-sm text-gray-600">
                                    ${pricePerMonth.toFixed(2)}/month
                                  </p>
                                  {savings > 0 && (
                                    <p className="text-xs text-green-600 font-medium mt-1">
                                      Save ${savings.toFixed(0)}/year
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Key Features Preview */}
                          <div className="space-y-2 mb-6 text-left">
                            <div className="flex items-center text-sm text-gray-700">
                              <svg className="h-4 w-4 text-green-500 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                              </svg>
                              <span>All premium features included</span>
                            </div>
                            <div className="flex items-center text-sm text-gray-700">
                              <svg className="h-4 w-4 text-green-500 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                              </svg>
                              <span>AI-powered content generation</span>
                            </div>
                            <div className="flex items-center text-sm text-gray-700">
                              <svg className="h-4 w-4 text-green-500 mr-2 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                              </svg>
                              <span>Full SEO optimization</span>
                            </div>
                          </div>

                          <button
                            onClick={() => handleSelectPlan(plan.plan_name)}
                            disabled={isCurrentPlan}
                            className={`w-full px-6 py-3 rounded-lg font-semibold text-base transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 transform hover:scale-105 ${isCurrentPlan
                              ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                              : isPublisher
                                ? 'bg-gradient-to-r from-purple-600 to-blue-600 text-white hover:from-purple-700 hover:to-blue-700 focus:ring-purple-500 shadow-lg'
                                : 'bg-gray-900 text-white hover:bg-gray-800 focus:ring-gray-500'
                              }`}
                          >
                            {isCurrentPlan ? 'Current Plan' : 'Select Plan'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Feature Comparison Table */}
                <div className="border-t border-gray-200 pt-8">
                  <h4 className="text-xl font-bold text-gray-900 mb-6 text-center">
                    Everything You Need to Succeed
                  </h4>
                  <div className="overflow-x-auto -mx-6 sm:mx-0">
                    <div className="inline-block min-w-full align-middle px-6 sm:px-0">
                      <table className="min-w-full">
                        <thead>
                          <tr className="border-b-2 border-gray-200">
                            <th className="text-left py-3 px-4 font-semibold text-gray-900">Feature</th>
                            {plans.map((plan) => (
                              <th key={plan.id} className={`text-center py-3 px-4 font-semibold ${plan.plan_name === 'publisher' ? 'text-purple-600' : 'text-gray-900'
                                }`}>
                                {formatPlanName(plan.plan_name)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {FEATURES.map((feature, idx) => (
                            <tr
                              key={idx}
                              className={`border-b border-gray-100 ${idx % 2 === 0 ? 'bg-gray-50' : 'bg-white'}`}
                            >
                              <td className="py-4 px-4">
                                <div className="flex items-start">
                                  <div>
                                    <div className="font-medium text-gray-900 text-sm">{feature.name}</div>
                                    {feature.description && (
                                      <div className="text-xs text-gray-500 mt-0.5">{feature.description}</div>
                                    )}
                                  </div>
                                </div>
                              </td>
                              {plans.map((plan) => {
                                const value = getFeatureValue(feature, plan.plan_name);
                                const isIncluded = typeof value === 'boolean' ? value : true;
                                const displayValue = formatFeatureValue(value);

                                return (
                                  <td key={plan.id} className={`text-center py-4 px-4 ${plan.plan_name === 'publisher' ? 'bg-purple-50' : ''
                                    }`}>
                                    {typeof value === 'boolean' ? (
                                      <div className="flex items-center justify-center">
                                        {isIncluded ? (
                                          <svg className="h-6 w-6 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                          </svg>
                                        ) : (
                                          <span className="text-gray-400 text-xl">—</span>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="font-semibold text-gray-900">{displayValue}</span>
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

                {/* CTA Footer */}
                <div className="mt-8 text-center">
                  <p className="text-sm text-gray-600 mb-4">
                    All plans include a 14-day free trial. Cancel anytime.
                  </p>
                  <div className="flex items-center justify-center gap-6 text-xs text-gray-500">
                    <div className="flex items-center gap-1">
                      <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      </svg>
                      <span>No credit card required</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      </svg>
                      <span>Cancel anytime</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
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
