import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { getShopDomain } from '../lib/app-bridge';
import { useStore, useQuotaStatus, queryKeys } from '../lib/api-cache';
import { api, storeApi, type Store, type QuotaStatus } from '../lib/api-client';
import { getPlanFrequencyConfig, validateSelectedDays, getFrequencySettings } from '../utils/plan-frequency';
import { isSetupComplete } from '../utils/setup-check';
import { useAppBridgeToast } from '../hooks/useAppBridge';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { formatAPIErrorMessage } from '../utils/error-messages';

type OnboardingStep =
  | 'welcome'
  | 'problem'
  | 'solution'
  | 'features'
  | 'analyzing'
  | 'integrations'
  | 'preferences'
  | 'schedule'
  | 'complete';

const STEP_ORDER: readonly OnboardingStep[] = [
  'welcome',
  'problem',
  'solution',
  'features',
  'analyzing',
  'integrations',
  'preferences',
  'schedule',
  'complete',
] as const;

const FADE_IN_UP = 'animate-[fadeInUp_0.6s_ease-out_forwards]';
const FADE_IN = 'animate-[fadeIn_0.5s_ease-out_forwards]';

const STATS = [
  { value: '55%', label: 'More organic traffic', sublabel: 'with consistent blogging' },
  { value: '434%', label: 'More indexed pages', sublabel: 'means more search visibility' },
  { value: '3.5x', label: 'Higher conversion', sublabel: 'from content-engaged visitors' },
] as const;

const FEATURES = [
  {
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
      </svg>
    ),
    title: 'AI-Powered Content',
    description: 'Articles written in your brand voice, optimized for your products and audience.',
    gradient: 'from-amber-500 to-orange-600',
  },
  {
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    ),
    title: 'SEO Optimization',
    description: 'Every article is crafted to rank in search results and drive organic traffic.',
    gradient: 'from-emerald-500 to-teal-600',
  },
  {
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    title: 'Automated Publishing',
    description: 'Set your schedule once. We handle the rest, publishing at optimal times.',
    gradient: 'from-blue-500 to-indigo-600',
  },
  {
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
      </svg>
    ),
    title: 'Product Integration',
    description: 'Smart internal linking connects articles to your products, driving sales.',
    gradient: 'from-purple-500 to-pink-600',
  },
] as const;

const ANALYSIS_PHASES = [
  {
    title: 'Scanning your store',
    items: ['Products & collections', 'Existing content', 'Store branding'],
    duration: 15000,
  },
  {
    title: 'Understanding your brand',
    items: ['Voice & tone', 'Unique selling points', 'Brand personality'],
    duration: 20000,
  },
  {
    title: 'Building customer profiles',
    items: ['Target demographics', 'Purchase motivations', 'Shopping behavior'],
    duration: 15000,
  },
] as const;

const PROGRESS_UPDATE_INTERVAL_MS = 100;
const ANALYSIS_COMPLETE_DELAY_MS = 500;
const SETUP_COMPLETE_DELAY_MS = 300;
const STORE_SETUP_TIMEOUT_MS = 300000;
const MAX_PROPERTY_ID_LENGTH = 50;
const MAX_SITE_URL_LENGTH = 500;
const MAX_TOPIC_LENGTH = 100;
const MAX_KEYWORD_LENGTH = 100;
const MAX_ANGLE_LENGTH = 100;
const MAX_TOPICS = 50;
const MAX_KEYWORDS = 50;
const MAX_ANGLES = 50;
const DEFAULT_PUBLISH_TIME = '14:00';
const DEFAULT_SELECTED_DAYS = [0, 2, 4] as const;

interface GradientTextProps {
  readonly children: React.ReactNode;
  readonly className?: string;
}

interface PrimaryButtonProps {
  readonly children: React.ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly className?: string;
  readonly size?: 'md' | 'lg';
}

interface SecondaryButtonProps {
  readonly children: React.ReactNode;
  readonly onClick: () => void;
  readonly className?: string;
}

interface StepIndicatorProps {
  readonly current: number;
  readonly total: number;
}

interface FeatureCardProps {
  readonly feature: (typeof FEATURES)[number];
  readonly index: number;
}

interface StatCardProps {
  readonly stat: (typeof STATS)[number];
  readonly index: number;
}

interface AnalyzingScreenProps {
  readonly onComplete: () => void;
  readonly storeId: string | null;
}

interface IntegrationsScreenProps {
  readonly onNext: () => void;
  readonly onBack: () => void;
  readonly googleAnalyticsEnabled: boolean;
  readonly setGoogleAnalyticsEnabled: (v: boolean) => void;
  readonly googleAnalyticsPropertyId: string;
  readonly setGoogleAnalyticsPropertyId: (v: string) => void;
  readonly googleSearchConsoleEnabled: boolean;
  readonly setGoogleSearchConsoleEnabled: (v: boolean) => void;
  readonly googleSearchConsoleSiteUrl: string;
  readonly setGoogleSearchConsoleSiteUrl: (v: string) => void;
}

interface PreferencesScreenProps {
  readonly onNext: () => void;
  readonly onBack: () => void;
  readonly topicPreferences: readonly string[];
  readonly setTopicPreferences: (v: readonly string[]) => void;
  readonly keywordFocus: readonly string[];
  readonly setKeywordFocus: (v: readonly string[]) => void;
  readonly contentAngles: readonly string[];
  readonly setContentAngles: (v: readonly string[]) => void;
}

interface ScheduleScreenProps {
  readonly onComplete: () => void;
  readonly onBack: () => void;
  readonly selectedDays: Set<number>;
  readonly setSelectedDays: (v: Set<number>) => void;
  readonly publishTime: string;
  readonly setPublishTime: (v: string) => void;
  readonly planFrequencyConfig: { readonly maxDays: number; readonly minDays: number; readonly displayName: string };
  readonly planName: string | null;
  readonly isCompleting: boolean;
  readonly error: Error | null;
}

interface CompleteScreenProps {
  readonly onGoToDashboard: () => void;
}

const isStore = (store: unknown): store is Store => {
  return store !== null && typeof store === 'object' && 'id' in store && typeof (store as Store).id === 'string';
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

const GradientText = ({ children, className = '' }: GradientTextProps): JSX.Element => {
  return (
    <span className={`bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600 bg-clip-text text-transparent ${className}`}>
      {children}
    </span>
  );
};

const PrimaryButton = ({ children, onClick, disabled = false, loading = false, className = '', size = 'lg' }: PrimaryButtonProps): JSX.Element => {
  const sizeClasses = size === 'lg' ? 'px-8 py-4 text-lg' : 'px-6 py-3 text-base';

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`
        relative overflow-hidden group
        ${sizeClasses} font-semibold rounded-2xl
        bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600
        text-white shadow-xl shadow-purple-500/25
        hover:shadow-2xl hover:shadow-purple-500/40
        hover:scale-[1.02] active:scale-[0.98]
        transition-all duration-300 ease-out
        disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100
        ${className}
      `}
      type="button"
    >
      <span className="relative z-10 flex items-center justify-center gap-2">
        {loading && <LoadingSpinner size="small" />}
        {children}
      </span>
      <div className="absolute inset-0 bg-gradient-to-r from-indigo-600 via-purple-600 to-violet-600 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
    </button>
  );
};

const SecondaryButton = ({ children, onClick, className = '' }: SecondaryButtonProps): JSX.Element => {
  return (
    <button
      onClick={onClick}
      className={`
        px-6 py-3 text-base font-medium rounded-xl
        text-gray-600 hover:text-gray-900
        bg-white/50 hover:bg-white
        border border-gray-200 hover:border-gray-300
        shadow-sm hover:shadow-md
        transition-all duration-200
        ${className}
      `}
      type="button"
    >
      {children}
    </button>
  );
};

const StepIndicator = ({ current, total }: StepIndicatorProps): JSX.Element => {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`
            h-1.5 rounded-full transition-all duration-500
            ${i < current
              ? 'w-8 bg-gradient-to-r from-violet-500 to-purple-600'
              : i === current
                ? 'w-8 bg-purple-300'
                : 'w-1.5 bg-gray-200'
            }
          `}
        />
      ))}
    </div>
  );
};

const FeatureCard = ({ feature, index }: FeatureCardProps): JSX.Element => {
  return (
    <div
      className={`
        group relative p-6 rounded-2xl bg-white border border-gray-100
        shadow-lg shadow-gray-100/50 hover:shadow-xl hover:shadow-gray-200/50
        hover:-translate-y-1 transition-all duration-300
        opacity-0 ${FADE_IN_UP}
      `}
      style={{ animationDelay: `${index * 100 + 200}ms` }}
    >
      <div className={`
        w-14 h-14 rounded-xl bg-gradient-to-br ${feature.gradient}
        flex items-center justify-center text-white mb-4
        group-hover:scale-110 transition-transform duration-300
      `}>
        {feature.icon}
      </div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{feature.title}</h3>
      <p className="text-gray-600 text-sm leading-relaxed">{feature.description}</p>
    </div>
  );
};

const StatCard = ({ stat, index }: StatCardProps): JSX.Element => {
  return (
    <div className={`text-center opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: `${index * 150 + 300}ms` }}>
      <div className="text-4xl sm:text-5xl font-bold bg-gradient-to-r from-violet-600 to-purple-600 bg-clip-text text-transparent mb-2">
        {stat.value}
      </div>
      <div className="text-gray-900 font-medium">{stat.label}</div>
      <div className="text-gray-500 text-sm">{stat.sublabel}</div>
    </div>
  );
};

const WelcomeScreen = ({ onNext }: { readonly onNext: () => void }): JSX.Element => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-violet-50 via-white to-purple-50" />
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-200/30 rounded-full blur-3xl" />
      <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-indigo-200/30 rounded-full blur-3xl" />

      <div className="relative z-10 max-w-4xl mx-auto text-center">
        <div className={`mb-8 opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: '100ms' }}>
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-600 to-purple-600 shadow-xl shadow-purple-500/30">
            <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </div>
        </div>

        <h1 className={`text-4xl sm:text-5xl lg:text-6xl font-bold text-gray-900 mb-6 opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: '200ms' }}>
          Turn Your Products Into<br />
          <GradientText>Organic Growth</GradientText>
        </h1>

        <p className={`text-xl text-gray-600 max-w-2xl mx-auto mb-12 opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: '300ms' }}>
          Automated SEO content that brings customers to your store—while you focus on what you do best.
        </p>

        <div className={`opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: '400ms' }}>
          <PrimaryButton onClick={onNext}>
            Get Started
            <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </PrimaryButton>
          <p className="mt-4 text-sm text-gray-500">Takes about 2 minutes · No credit card required</p>
        </div>
      </div>
    </div>
  );
};

const ProblemScreen = ({ onNext, onBack }: { readonly onNext: () => void; readonly onBack: () => void }): JSX.Element => {
  return (
    <div className="min-h-screen flex flex-col p-6 relative overflow-hidden bg-gradient-to-b from-gray-900 to-gray-800">
      <div className="absolute inset-0 opacity-5">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
            backgroundSize: '40px 40px',
          }}
        />
      </div>

      <div className="relative z-10 flex-1 flex flex-col max-w-5xl mx-auto w-full">
        <div className="flex items-center justify-between py-4">
          <SecondaryButton onClick={onBack}>← Back</SecondaryButton>
          <StepIndicator current={1} total={4} />
        </div>

        <div className="flex-1 flex flex-col justify-center py-12">
          <div className="text-center mb-16">
            <p className={`text-purple-400 font-medium mb-4 opacity-0 ${FADE_IN}`} style={{ animationDelay: '100ms' }}>
              THE CHALLENGE
            </p>
            <h2 className={`text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-6 opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: '200ms' }}>
              Paid ads are getting expensive.<br />
              <span className="text-gray-400">Organic traffic is the answer.</span>
            </h2>
            <p className={`text-lg text-gray-400 max-w-2xl mx-auto opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: '300ms' }}>
              But creating content consistently takes time you don't have. What if you could automate it?
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-12">
            {STATS.map((stat, i) => (
              <div key={i} className={`text-center opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: `${i * 150 + 400}ms` }}>
                <div className="text-4xl sm:text-5xl font-bold text-white mb-2">{stat.value}</div>
                <div className="text-gray-300 font-medium">{stat.label}</div>
                <div className="text-gray-500 text-sm">{stat.sublabel}</div>
              </div>
            ))}
          </div>
        </div>

        <div className={`text-center pb-8 opacity-0 ${FADE_IN}`} style={{ animationDelay: '800ms' }}>
          <PrimaryButton onClick={onNext}>
            See the Solution
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
};

const SolutionScreen = ({ onNext, onBack }: { readonly onNext: () => void; readonly onBack: () => void }): JSX.Element => {
  const steps = [
    {
      num: '01',
      title: 'We learn your brand',
      desc: 'Our AI analyzes your store, products, and existing content to understand your unique voice.',
    },
    {
      num: '02',
      title: 'We create content',
      desc: 'SEO-optimized articles written in your brand voice, naturally featuring your products.',
    },
    {
      num: '03',
      title: 'We publish automatically',
      desc: 'Articles go live on your schedule, with internal links that drive product discovery.',
    },
  ] as const;

  return (
    <div className="min-h-screen flex flex-col p-6 relative overflow-hidden bg-white">
      <div className="absolute top-0 right-0 w-1/2 h-full bg-gradient-to-l from-purple-50 to-transparent" />

      <div className="relative z-10 flex-1 flex flex-col max-w-5xl mx-auto w-full">
        <div className="flex items-center justify-between py-4">
          <SecondaryButton onClick={onBack}>← Back</SecondaryButton>
          <StepIndicator current={2} total={4} />
        </div>

        <div className="flex-1 flex flex-col justify-center py-12">
          <div className="text-center mb-16">
            <p className={`text-purple-600 font-medium mb-4 opacity-0 ${FADE_IN}`} style={{ animationDelay: '100ms' }}>
              HOW IT WORKS
            </p>
            <h2 className={`text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-6 opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: '200ms' }}>
              Content on autopilot.<br />
              <GradientText>Growth on repeat.</GradientText>
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {steps.map((step, i) => (
              <div key={i} className={`relative opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: `${i * 150 + 300}ms` }}>
                {i < steps.length - 1 && (
                  <div className="hidden md:block absolute top-8 left-full w-full h-0.5 bg-gradient-to-r from-purple-200 to-transparent" />
                )}
                <div className="text-6xl font-bold text-purple-100 mb-4">{step.num}</div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">{step.title}</h3>
                <p className="text-gray-600">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>

        <div className={`text-center pb-8 opacity-0 ${FADE_IN}`} style={{ animationDelay: '700ms' }}>
          <PrimaryButton onClick={onNext}>
            Explore Features
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
};

const FeaturesScreen = ({ onNext, onBack }: { readonly onNext: () => void; readonly onBack: () => void }): JSX.Element => {
  return (
    <div className="min-h-screen flex flex-col p-6 relative overflow-hidden bg-gradient-to-br from-gray-50 to-white">
      <div className="absolute top-20 left-10 w-72 h-72 bg-purple-100/50 rounded-full blur-3xl" />
      <div className="absolute bottom-20 right-10 w-72 h-72 bg-indigo-100/50 rounded-full blur-3xl" />

      <div className="relative z-10 flex-1 flex flex-col max-w-5xl mx-auto w-full">
        <div className="flex items-center justify-between py-4">
          <SecondaryButton onClick={onBack}>← Back</SecondaryButton>
          <StepIndicator current={3} total={4} />
        </div>

        <div className="flex-1 flex flex-col justify-center py-12">
          <div className="text-center mb-12">
            <p className={`text-purple-600 font-medium mb-4 opacity-0 ${FADE_IN}`} style={{ animationDelay: '100ms' }}>
              WHAT YOU GET
            </p>
            <h2 className={`text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-6 opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: '200ms' }}>
              Everything you need to<br />
              <GradientText>grow organically</GradientText>
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {FEATURES.map((feature, i) => (
              <FeatureCard key={i} feature={feature} index={i} />
            ))}
          </div>
        </div>

        <div className={`text-center pb-8 opacity-0 ${FADE_IN}`} style={{ animationDelay: '800ms' }}>
          <PrimaryButton onClick={onNext}>
            Start Setup
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
};

const AnalyzingScreen = ({ onComplete, storeId }: AnalyzingScreenProps): JSX.Element => {
  const [currentPhase, setCurrentPhase] = useState(0);
  const [progress, setProgress] = useState(0);
  const [currentItemIndex, setCurrentItemIndex] = useState(0);
  const isMountedRef = useRef(true);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const completeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isMountedRef.current = true;

    if (storeId) {
      void (async () => {
        try {
          await api.post(
            '/store-setup',
            { storeId },
            {
              priority: 'high',
              cache: { enabled: false },
              timeout: STORE_SETUP_TIMEOUT_MS,
            },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const is404 = message.includes('404') || message.includes('Not Found');
          if (!is404 && isMountedRef.current) {
          }
        }
      })();
    }

    const totalDuration = ANALYSIS_PHASES.reduce((acc, p) => acc + p.duration, 0);
    let elapsed = 0;

    const progressInterval = setInterval(() => {
      if (!isMountedRef.current) {
        return;
      }

      elapsed += PROGRESS_UPDATE_INTERVAL_MS;
      const newProgress = Math.min((elapsed / totalDuration) * 100, 100);
      setProgress(newProgress);

      let phaseElapsed = 0;
      for (let i = 0; i < ANALYSIS_PHASES.length; i++) {
        if (elapsed < phaseElapsed + ANALYSIS_PHASES[i].duration) {
          setCurrentPhase(i);
          const phaseProgress = (elapsed - phaseElapsed) / ANALYSIS_PHASES[i].duration;
          const itemIdx = Math.floor(phaseProgress * ANALYSIS_PHASES[i].items.length);
          setCurrentItemIndex(Math.min(itemIdx, ANALYSIS_PHASES[i].items.length - 1));
          break;
        }
        phaseElapsed += ANALYSIS_PHASES[i].duration;
      }

      if (elapsed >= totalDuration) {
        clearInterval(progressInterval);
        if (isMountedRef.current) {
          completeTimeoutRef.current = setTimeout(() => {
            if (isMountedRef.current) {
              onComplete();
            }
          }, ANALYSIS_COMPLETE_DELAY_MS);
        }
      }
    }, PROGRESS_UPDATE_INTERVAL_MS);

    progressIntervalRef.current = progressInterval;

    return () => {
      isMountedRef.current = false;
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
      if (completeTimeoutRef.current) {
        clearTimeout(completeTimeoutRef.current);
      }
    };
  }, [storeId, onComplete]);

  const phase = ANALYSIS_PHASES[currentPhase];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden bg-gradient-to-br from-violet-600 via-purple-600 to-indigo-700">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-white/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-white/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      <div className="relative z-10 max-w-lg w-full text-center">
        <div className="mb-8">
          <div className="relative w-24 h-24 mx-auto">
            <div className="absolute inset-0 rounded-full border-4 border-white/20" />
            <div className="absolute inset-0 rounded-full border-4 border-white border-t-transparent animate-spin" style={{ animationDuration: '1.5s' }} />
            <div className="absolute inset-3 rounded-full bg-white/10 backdrop-blur flex items-center justify-center">
              <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>
        </div>

        <h2 className="text-2xl sm:text-3xl font-bold text-white mb-4">{phase.title}</h2>

        <div className="space-y-2 mb-8">
          {phase.items.map((item, i) => (
            <div
              key={item}
              className={`
                flex items-center justify-center gap-2 text-white/80
                transition-all duration-300
                ${i === currentItemIndex ? 'opacity-100 scale-100' : i < currentItemIndex ? 'opacity-50 scale-95' : 'opacity-30 scale-95'}
              `}
            >
              {i < currentItemIndex ? (
                <svg className="w-4 h-4 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : i === currentItemIndex ? (
                <div className="w-4 h-4 border-2 border-white/60 border-t-transparent rounded-full animate-spin" />
              ) : (
                <div className="w-4 h-4 rounded-full border border-white/30" />
              )}
              <span>{item}</span>
            </div>
          ))}
        </div>

        <div className="w-full max-w-xs mx-auto">
          <div className="h-2 bg-white/20 rounded-full overflow-hidden">
            <div className="h-full bg-white rounded-full transition-all duration-300 ease-out" style={{ width: `${progress}%` }} />
          </div>
          <p className="text-white/60 text-sm mt-2">{Math.round(progress)}% complete</p>
        </div>
      </div>
    </div>
  );
};

const IntegrationsScreen = ({
  onNext,
  onBack,
  googleAnalyticsEnabled,
  setGoogleAnalyticsEnabled,
  googleAnalyticsPropertyId,
  setGoogleAnalyticsPropertyId,
  googleSearchConsoleEnabled,
  setGoogleSearchConsoleEnabled,
  googleSearchConsoleSiteUrl,
  setGoogleSearchConsoleSiteUrl,
}: IntegrationsScreenProps): JSX.Element => {
  return (
    <div className="min-h-screen flex flex-col p-6 relative overflow-hidden bg-white">
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600" />

      <div className="relative z-10 flex-1 flex flex-col max-w-2xl mx-auto w-full">
        <div className="flex items-center justify-between py-4">
          <button onClick={onBack} className="text-gray-500 hover:text-gray-700 text-sm font-medium" type="button">
            ← Back
          </button>
          <span className="text-sm text-gray-500">Step 1 of 3</span>
        </div>

        <div className="flex-1 flex flex-col justify-center py-8">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-yellow-400 to-orange-500 shadow-lg mb-4">
              <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-3">Connect your analytics</h2>
            <p className="text-gray-600">Optional—track how your content performs. You can always add these later.</p>
          </div>

          <div className="space-y-4">
            <div
              className={`
              p-5 rounded-2xl border-2 transition-all duration-200
              ${googleSearchConsoleEnabled ? 'border-purple-200 bg-purple-50/50' : 'border-gray-100 bg-gray-50/50 hover:border-gray-200'}
            `}
            >
              <label className="flex items-start gap-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={googleSearchConsoleEnabled}
                  onChange={(e) => setGoogleSearchConsoleEnabled(e.target.checked)}
                  className="w-5 h-5 mt-0.5 text-purple-600 rounded-lg border-gray-300 focus:ring-purple-500 focus:ring-offset-0"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-gray-900">Google Search Console</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">Recommended</span>
                  </div>
                  <p className="text-sm text-gray-600 mb-3">Submit sitemaps automatically when articles are published for faster indexing.</p>
                  {googleSearchConsoleEnabled && (
                    <input
                      type="url"
                      value={googleSearchConsoleSiteUrl}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value.length <= MAX_SITE_URL_LENGTH) {
                          setGoogleSearchConsoleSiteUrl(value);
                        }
                      }}
                      placeholder="https://yourstore.com"
                      maxLength={MAX_SITE_URL_LENGTH}
                      className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    />
                  )}
                </div>
              </label>
            </div>

            <div
              className={`
              p-5 rounded-2xl border-2 transition-all duration-200
              ${googleAnalyticsEnabled ? 'border-purple-200 bg-purple-50/50' : 'border-gray-100 bg-gray-50/50 hover:border-gray-200'}
            `}
            >
              <label className="flex items-start gap-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={googleAnalyticsEnabled}
                  onChange={(e) => setGoogleAnalyticsEnabled(e.target.checked)}
                  className="w-5 h-5 mt-0.5 text-purple-600 rounded-lg border-gray-300 focus:ring-purple-500 focus:ring-offset-0"
                />
                <div className="flex-1">
                  <div className="font-semibold text-gray-900 mb-1">Google Analytics 4</div>
                  <p className="text-sm text-gray-600 mb-3">Track which articles drive traffic and conversions.</p>
                  {googleAnalyticsEnabled && (
                    <input
                      type="text"
                      value={googleAnalyticsPropertyId}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value.length <= MAX_PROPERTY_ID_LENGTH) {
                          setGoogleAnalyticsPropertyId(value);
                        }
                      }}
                      placeholder="G-XXXXXXXXXX"
                      maxLength={MAX_PROPERTY_ID_LENGTH}
                      className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    />
                  )}
                </div>
              </label>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 py-6 border-t border-gray-100">
          <button onClick={onNext} className="text-gray-500 hover:text-gray-700 text-sm font-medium order-2 sm:order-1" type="button">
            Skip for now
          </button>
          <PrimaryButton onClick={onNext} size="md" className="order-1 sm:order-2">
            Continue
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
};

const PreferencesScreen = ({
  onNext,
  onBack,
  topicPreferences,
  setTopicPreferences,
  keywordFocus,
  setKeywordFocus,
  contentAngles,
  setContentAngles,
}: PreferencesScreenProps): JSX.Element => {
  const [newTopic, setNewTopic] = useState('');
  const [newKeyword, setNewKeyword] = useState('');
  const [newAngle, setNewAngle] = useState('');

  const handleAddTopic = useCallback(() => {
    if (!validateTopic(newTopic)) {
      return;
    }
    const trimmed = newTopic.trim();
    if (topicPreferences.includes(trimmed) || topicPreferences.length >= MAX_TOPICS) {
      return;
    }
    setTopicPreferences([...topicPreferences, trimmed]);
    setNewTopic('');
  }, [newTopic, topicPreferences, setTopicPreferences]);

  const handleAddKeyword = useCallback(() => {
    if (!validateKeyword(newKeyword)) {
      return;
    }
    const trimmed = newKeyword.trim();
    if (keywordFocus.includes(trimmed) || keywordFocus.length >= MAX_KEYWORDS) {
      return;
    }
    setKeywordFocus([...keywordFocus, trimmed]);
    setNewKeyword('');
  }, [newKeyword, keywordFocus, setKeywordFocus]);

  const handleAddAngle = useCallback(() => {
    if (!validateAngle(newAngle)) {
      return;
    }
    const trimmed = newAngle.trim();
    if (contentAngles.includes(trimmed) || contentAngles.length >= MAX_ANGLES) {
      return;
    }
    setContentAngles([...contentAngles, trimmed]);
    setNewAngle('');
  }, [newAngle, contentAngles, setContentAngles]);

  const handleRemoveTopic = useCallback(
    (index: number) => {
      setTopicPreferences(topicPreferences.filter((_, i) => i !== index));
    },
    [topicPreferences, setTopicPreferences],
  );

  const handleRemoveKeyword = useCallback(
    (index: number) => {
      setKeywordFocus(keywordFocus.filter((_, i) => i !== index));
    },
    [keywordFocus, setKeywordFocus],
  );

  const handleRemoveAngle = useCallback(
    (index: number) => {
      setContentAngles(contentAngles.filter((_, i) => i !== index));
    },
    [contentAngles, setContentAngles],
  );

  return (
    <div className="min-h-screen flex flex-col p-6 relative overflow-hidden bg-white">
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600" />

      <div className="relative z-10 flex-1 flex flex-col max-w-2xl mx-auto w-full">
        <div className="flex items-center justify-between py-4">
          <button onClick={onBack} className="text-gray-500 hover:text-gray-700 text-sm font-medium" type="button">
            ← Back
          </button>
          <span className="text-sm text-gray-500">Step 2 of 3</span>
        </div>

        <div className="flex-1 flex flex-col py-8 overflow-y-auto">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-400 to-purple-600 shadow-lg mb-4">
              <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-3">Content preferences</h2>
            <p className="text-gray-600">Optional—guide what topics and keywords to focus on. Skip to let AI decide based on your products.</p>
          </div>

          <div className="space-y-6">
            <div>
              <label className="block text-sm font-semibold text-gray-900 mb-2">Topics to cover</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newTopic}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value.length <= MAX_TOPIC_LENGTH) {
                      setNewTopic(value);
                    }
                  }}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTopic();
                    }
                  }}
                  placeholder="e.g., sustainable fashion, skincare routines"
                  maxLength={MAX_TOPIC_LENGTH}
                  className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
                <button
                  onClick={handleAddTopic}
                  className="px-4 py-2.5 bg-purple-600 text-white rounded-xl text-sm font-medium hover:bg-purple-700 transition-colors"
                  type="button"
                >
                  Add
                </button>
              </div>
              {topicPreferences.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {topicPreferences.map((topic, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-purple-100 text-purple-800 rounded-full text-sm font-medium">
                      {topic}
                      <button onClick={() => handleRemoveTopic(i)} className="hover:text-purple-900" type="button">
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-900 mb-2">SEO keywords to target</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newKeyword}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value.length <= MAX_KEYWORD_LENGTH) {
                      setNewKeyword(value);
                    }
                  }}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddKeyword();
                    }
                  }}
                  placeholder="e.g., organic cotton, eco-friendly"
                  maxLength={MAX_KEYWORD_LENGTH}
                  className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
                <button
                  onClick={handleAddKeyword}
                  className="px-4 py-2.5 bg-purple-600 text-white rounded-xl text-sm font-medium hover:bg-purple-700 transition-colors"
                  type="button"
                >
                  Add
                </button>
              </div>
              {keywordFocus.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {keywordFocus.map((keyword, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-100 text-blue-800 rounded-full text-sm font-medium">
                      {keyword}
                      <button onClick={() => handleRemoveKeyword(i)} className="hover:text-blue-900" type="button">
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-900 mb-2">Content formats</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newAngle}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value.length <= MAX_ANGLE_LENGTH) {
                      setNewAngle(value);
                    }
                  }}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddAngle();
                    }
                  }}
                  placeholder="e.g., how-to guides, product comparisons"
                  maxLength={MAX_ANGLE_LENGTH}
                  className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
                <button
                  onClick={handleAddAngle}
                  className="px-4 py-2.5 bg-purple-600 text-white rounded-xl text-sm font-medium hover:bg-purple-700 transition-colors"
                  type="button"
                >
                  Add
                </button>
              </div>
              {contentAngles.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {contentAngles.map((angle, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-100 text-emerald-800 rounded-full text-sm font-medium">
                      {angle}
                      <button onClick={() => handleRemoveAngle(i)} className="hover:text-emerald-900" type="button">
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 py-6 border-t border-gray-100">
          <button onClick={onNext} className="text-gray-500 hover:text-gray-700 text-sm font-medium order-2 sm:order-1" type="button">
            Skip for now
          </button>
          <PrimaryButton onClick={onNext} size="md" className="order-1 sm:order-2">
            Continue
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
};

const ScheduleScreen = ({
  onComplete,
  onBack,
  selectedDays,
  setSelectedDays,
  publishTime,
  setPublishTime,
  planFrequencyConfig,
  planName,
  isCompleting,
  error,
}: ScheduleScreenProps): JSX.Element => {
  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
  const dayAbbr = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

  const handleDayToggle = useCallback(
    (index: number) => {
      const newDays = new Set(selectedDays);
      if (newDays.has(index)) {
        newDays.delete(index);
      } else if (newDays.size < planFrequencyConfig.maxDays) {
        newDays.add(index);
      }
      setSelectedDays(newDays);
    },
    [selectedDays, planFrequencyConfig.maxDays, setSelectedDays],
  );

  const isValid = selectedDays.size >= planFrequencyConfig.minDays;

  return (
    <div className="min-h-screen flex flex-col p-6 relative overflow-hidden bg-white">
      <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-violet-600 via-purple-600 to-indigo-600" />

      <div className="relative z-10 flex-1 flex flex-col max-w-2xl mx-auto w-full">
        <div className="flex items-center justify-between py-4">
          <button onClick={onBack} className="text-gray-500 hover:text-gray-700 text-sm font-medium" type="button">
            ← Back
          </button>
          <span className="text-sm text-gray-500">Step 3 of 3</span>
        </div>

        <div className="flex-1 flex flex-col justify-center py-8">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-400 to-indigo-600 shadow-lg mb-4">
              <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-3">Set your publishing schedule</h2>
            <p className="text-gray-600">
              Choose when articles go live. Your plan allows up to {planFrequencyConfig.maxDays} article{planFrequencyConfig.maxDays > 1 ? 's' : ''} per week.
            </p>
          </div>

          <div className="mb-8">
            <label className="block text-sm font-semibold text-gray-900 mb-4 text-center">
              Publishing days ({selectedDays.size} of {planFrequencyConfig.maxDays} selected)
            </label>
            <div className="flex justify-center gap-2 flex-wrap">
              {dayNames.map((day, i) => {
                const isSelected = selectedDays.has(i);
                const isDisabled = !isSelected && selectedDays.size >= planFrequencyConfig.maxDays;

                return (
                  <button
                    key={day}
                    onClick={() => handleDayToggle(i)}
                    disabled={isDisabled}
                    className={`
                      w-14 h-14 sm:w-16 sm:h-16 rounded-2xl font-medium text-sm
                      transition-all duration-200
                      ${isSelected
                        ? 'bg-gradient-to-br from-violet-600 to-purple-600 text-white shadow-lg shadow-purple-500/30 scale-105'
                        : isDisabled
                          ? 'bg-gray-100 text-gray-300 cursor-not-allowed'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }
                    `}
                    type="button"
                  >
                    {dayAbbr[i]}
                  </button>
                );
              })}
            </div>
            {selectedDays.size < planFrequencyConfig.minDays && (
              <p className="text-amber-600 text-sm text-center mt-4">
                Please select at least {planFrequencyConfig.minDays} day{planFrequencyConfig.minDays > 1 ? 's' : ''}.
              </p>
            )}
          </div>

          <div className="mb-8">
            <label className="block text-sm font-semibold text-gray-900 mb-3 text-center">Publishing time</label>
            <div className="flex justify-center">
              <input
                type="time"
                value={publishTime}
                onChange={(e) => setPublishTime(e.target.value)}
                className="px-6 py-3 border border-gray-200 rounded-xl text-lg text-center focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              />
            </div>
          </div>

          <div className="bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 rounded-2xl p-6 text-center">
            <div className="inline-flex items-center gap-2 text-emerald-700 font-semibold mb-2">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
              </svg>
              14-day free trial
            </div>
            <p className="text-emerald-700 text-sm">No credit card required. Full access to all features.</p>
          </div>

          {error && (
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm text-center">
              {error.message}
            </div>
          )}
        </div>

        <div className="flex justify-center py-6 border-t border-gray-100">
          <PrimaryButton onClick={onComplete} disabled={!isValid} loading={isCompleting} className="w-full sm:w-auto">
            {isCompleting ? 'Starting your trial...' : 'Start Free Trial'}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
};

const CompleteScreen = ({ onGoToDashboard }: CompleteScreenProps): JSX.Element => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-emerald-50 via-white to-teal-50" />
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-emerald-200/30 rounded-full blur-3xl animate-pulse" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-teal-200/30 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />

      <div className="relative z-10 max-w-lg mx-auto text-center">
        <div className={`mb-8 opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: '100ms' }}>
          <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 shadow-xl shadow-emerald-500/30">
            <svg className="w-12 h-12 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        </div>

        <h1 className={`text-3xl sm:text-4xl font-bold text-gray-900 mb-4 opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: '200ms' }}>
          You're all set! 🎉
        </h1>

        <p className={`text-lg text-gray-600 mb-8 opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: '300ms' }}>
          Your store is configured and ready to start generating content. Your first article will be created according to your schedule.
        </p>

        <div className={`opacity-0 ${FADE_IN_UP}`} style={{ animationDelay: '400ms' }}>
          <PrimaryButton onClick={onGoToDashboard}>
            Go to Dashboard
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
};

export default function Setup(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [currentStep, setCurrentStep] = useState<OnboardingStep>('welcome');
  const [isCompleting, setIsCompleting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [selectedDays, setSelectedDays] = useState<Set<number>>(new Set(DEFAULT_SELECTED_DAYS));
  const [publishTime, setPublishTime] = useState(DEFAULT_PUBLISH_TIME);
  const [googleAnalyticsEnabled, setGoogleAnalyticsEnabled] = useState(false);
  const [googleAnalyticsPropertyId, setGoogleAnalyticsPropertyId] = useState('');
  const [googleSearchConsoleEnabled, setGoogleSearchConsoleEnabled] = useState(false);
  const [googleSearchConsoleSiteUrl, setGoogleSearchConsoleSiteUrl] = useState('');
  const [topicPreferences, setTopicPreferences] = useState<readonly string[]>([]);
  const [keywordFocus, setKeywordFocus] = useState<readonly string[]>([]);
  const [contentAngles, setContentAngles] = useState<readonly string[]>([]);
  const hasCompletedSetupRef = useRef(false);
  const isMountedRef = useRef(true);
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
  } = useStore(shopDomain ?? '');

  const storeId = useMemo(() => {
    if (isStore(store)) {
      return store.id;
    }
    return '';
  }, [store]);

  const {
    data: quota,
    isLoading: quotaLoading,
  } = useQuotaStatus(storeId);

  const planName = useMemo(() => {
    if (!quota) {
      return null;
    }
    if (isQuotaWithError(quota)) {
      return null;
    }
    if (!isQuotaStatus(quota)) {
      return null;
    }
    return quota.plan_name || null;
  }, [quota]);

  const planFrequencyConfig = useMemo(() => getPlanFrequencyConfig(planName), [planName]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (isStore(store) && isSetupComplete(store) && !hasCompletedSetupRef.current) {
      navigate('/dashboard', { replace: true });
    }
  }, [store, navigate]);

  const goToStep = useCallback((step: OnboardingStep) => {
    setCurrentStep(step);
  }, []);

  const handleComplete = useCallback(async () => {
    if (!isMountedRef.current) {
      return;
    }

    setIsCompleting(true);
    setError(null);

    let currentStore = store;
    if (!isStore(currentStore) && shopDomain) {
      try {
        const createdStore = await storeApi.getStore(shopDomain);
        currentStore = createdStore;
        queryClient.invalidateQueries({ queryKey: queryKeys.store(shopDomain) });
      } catch (err) {
        if (!isMountedRef.current) {
          return;
        }
        setIsCompleting(false);
        const friendlyError = formatAPIErrorMessage(err, { action: 'create store', resource: 'store' });
        setError(new Error(friendlyError));
        showToast(friendlyError, { isError: true });
        return;
      }
    }

    if (!isStore(currentStore)) {
      if (!isMountedRef.current) {
        return;
      }
      setIsCompleting(false);
      setError(new Error("Couldn't find your store. Please refresh and try again."));
      return;
    }

    const validation = validateSelectedDays(selectedDays, planName);
    if (!validation.valid) {
      if (!isMountedRef.current) {
        return;
      }
      setIsCompleting(false);
      setError(new Error(validation.error || 'Please select the required number of days.'));
      return;
    }

    try {
      const frequencySettings = getFrequencySettings(planName, selectedDays, [publishTime]);

      const contentPreferences = {
        topic_preferences: topicPreferences,
        keyword_focus: keywordFocus,
        content_angles: contentAngles,
        internal_linking_preferences: {},
      };

      const integrations: Record<string, unknown> = {};
      if (googleAnalyticsEnabled && validatePropertyId(googleAnalyticsPropertyId)) {
        integrations.google_analytics = {
          enabled: true,
          property_id: googleAnalyticsPropertyId.trim(),
        };
      }
      if (googleSearchConsoleEnabled && validateSiteUrl(googleSearchConsoleSiteUrl)) {
        integrations.google_search_console = {
          enabled: true,
          site_url: googleSearchConsoleSiteUrl.trim(),
        };
      }

      if (Object.keys(integrations).length > 0) {
        try {
          await storeApi.updateStore(currentStore.id, integrations as Parameters<typeof storeApi.updateStore>[1]);
        } catch (integrationError) {
        }
      }

      const updatedStore = await api.post(
        '/api-router/complete-setup',
        {
          storeId: currentStore.id,
          shopDomain: shopDomain ?? undefined,
          frequencySettings,
          contentPreferences,
        },
        {
          priority: 'high',
          cache: { enabled: false },
        },
      );

      if (!isMountedRef.current) {
        return;
      }

      hasCompletedSetupRef.current = true;

      if (shopDomain) {
        const storeKey = queryKeys.store(shopDomain);
        queryClient.setQueryData(storeKey, updatedStore);
        queryClient.invalidateQueries({ queryKey: storeKey });
        await queryClient.refetchQueries({ queryKey: storeKey });
      }

      await new Promise((resolve) => setTimeout(resolve, SETUP_COMPLETE_DELAY_MS));

      if (!isMountedRef.current) {
        return;
      }

      setIsCompleting(false);
      setCurrentStep('complete');
      showToast('Setup completed successfully!', { isError: false });
    } catch (err) {
      if (!isMountedRef.current) {
        return;
      }
      setIsCompleting(false);
      const friendly = formatAPIErrorMessage(err, { action: 'complete setup', resource: 'setup' });
      setError(new Error(friendly));
      showToast(friendly, { isError: true });
    }
  }, [
    store,
    shopDomain,
    planName,
    selectedDays,
    publishTime,
    topicPreferences,
    keywordFocus,
    contentAngles,
    googleAnalyticsEnabled,
    googleAnalyticsPropertyId,
    googleSearchConsoleEnabled,
    googleSearchConsoleSiteUrl,
    showToast,
    queryClient,
  ]);

  if (storeLoading && !store) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-violet-50 via-white to-purple-50">
        <LoadingSpinner size="large" label="Loading..." />
      </div>
    );
  }

  switch (currentStep) {
    case 'welcome':
      return <WelcomeScreen onNext={() => goToStep('problem')} />;

    case 'problem':
      return <ProblemScreen onNext={() => goToStep('solution')} onBack={() => goToStep('welcome')} />;

    case 'solution':
      return <SolutionScreen onNext={() => goToStep('features')} onBack={() => goToStep('problem')} />;

    case 'features':
      return <FeaturesScreen onNext={() => goToStep('analyzing')} onBack={() => goToStep('solution')} />;

    case 'analyzing':
      return <AnalyzingScreen storeId={storeId || null} onComplete={() => goToStep('integrations')} />;

    case 'integrations':
      return (
        <IntegrationsScreen
          onNext={() => goToStep('preferences')}
          onBack={() => goToStep('features')}
          googleAnalyticsEnabled={googleAnalyticsEnabled}
          setGoogleAnalyticsEnabled={setGoogleAnalyticsEnabled}
          googleAnalyticsPropertyId={googleAnalyticsPropertyId}
          setGoogleAnalyticsPropertyId={setGoogleAnalyticsPropertyId}
          googleSearchConsoleEnabled={googleSearchConsoleEnabled}
          setGoogleSearchConsoleEnabled={setGoogleSearchConsoleEnabled}
          googleSearchConsoleSiteUrl={googleSearchConsoleSiteUrl}
          setGoogleSearchConsoleSiteUrl={setGoogleSearchConsoleSiteUrl}
        />
      );

    case 'preferences':
      return (
        <PreferencesScreen
          onNext={() => goToStep('schedule')}
          onBack={() => goToStep('integrations')}
          topicPreferences={topicPreferences}
          setTopicPreferences={setTopicPreferences}
          keywordFocus={keywordFocus}
          setKeywordFocus={setKeywordFocus}
          contentAngles={contentAngles}
          setContentAngles={setContentAngles}
        />
      );

    case 'schedule':
      return (
        <ScheduleScreen
          onComplete={handleComplete}
          onBack={() => goToStep('preferences')}
          selectedDays={selectedDays}
          setSelectedDays={setSelectedDays}
          publishTime={publishTime}
          setPublishTime={setPublishTime}
          planFrequencyConfig={planFrequencyConfig}
          planName={planName}
          isCompleting={isCompleting}
          error={error}
        />
      );

    case 'complete':
      return <CompleteScreen onGoToDashboard={() => navigate('/dashboard', { replace: true })} />;

    default:
      return <WelcomeScreen onNext={() => goToStep('problem')} />;
  }
}
