export interface PlanFrequencyConfig {
  readonly articlesPerWeek: number;
  readonly minDays: number;
  readonly maxDays: number;
  readonly displayName: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

export interface FrequencySettings {
  readonly interval: string;
  readonly count: number;
  readonly preferredDays: readonly number[];
  readonly preferredTimes: readonly string[];
}

type PlanName = 'free_trial' | 'starter' | 'publisher';

export const PLAN_FREQUENCY_CONFIG: Readonly<Record<PlanName, PlanFrequencyConfig>> = {
  free_trial: {
    articlesPerWeek: 3,
    minDays: 1,
    maxDays: 3,
    displayName: '3 articles per week',
  },
  starter: {
    articlesPerWeek: 3,
    minDays: 1,
    maxDays: 3,
    displayName: '3 articles per week',
  },
  publisher: {
    articlesPerWeek: 7,
    minDays: 1,
    maxDays: 7,
    displayName: '7 articles per week',
  },
} as const;

const DEFAULT_PLAN: PlanName = 'free_trial';
const DEFAULT_PREFERRED_TIME = '14:00' as const;
const WEEKLY_INTERVAL = 'weekly' as const;
const JS_DAY_SUNDAY = 0;
const JS_DAY_MONDAY = 1;
const INTERNAL_DAY_SUNDAY = 6;

const planNameCache = new Map<string, PlanName>();

function normalizePlanName(planName: string): PlanName {
  const cached = planNameCache.get(planName);
  if (cached) {
    return cached;
  }

  const normalized = planName.toLowerCase().replace(/\s+/g, '_') as PlanName;
  const validPlan = normalized in PLAN_FREQUENCY_CONFIG ? normalized : DEFAULT_PLAN;
  
  if (planNameCache.size < 100) {
    planNameCache.set(planName, validPlan);
  }
  
  return validPlan;
}

function formatPlural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function indexToJsDay(index: number): number {
  return index === INTERNAL_DAY_SUNDAY ? JS_DAY_SUNDAY : index + JS_DAY_MONDAY;
}

function validateDayIndex(day: number): boolean {
  return Number.isInteger(day) && day >= 0 && day <= INTERNAL_DAY_SUNDAY;
}

function validateSelectedDaysInput(selectedDays: Set<number>): boolean {
  if (!(selectedDays instanceof Set)) {
    return false;
  }
  
  const days = Array.from(selectedDays);
  for (const day of days) {
    if (!validateDayIndex(day)) {
      return false;
    }
  }
  
  return true;
}

export function getPlanFrequencyConfig(planName: string | null | undefined): PlanFrequencyConfig {
  if (!planName || typeof planName !== 'string' || planName.trim().length === 0) {
    return PLAN_FREQUENCY_CONFIG[DEFAULT_PLAN];
  }
  
  const normalized = normalizePlanName(planName.trim());
  return PLAN_FREQUENCY_CONFIG[normalized];
}

export function validateSelectedDays(
  selectedDays: Set<number>,
  planName: string | null | undefined
): ValidationResult {
  if (!validateSelectedDaysInput(selectedDays)) {
    return {
      valid: false,
      error: 'Invalid day selection format',
    };
  }

  const config = getPlanFrequencyConfig(planName);
  const dayCount = selectedDays.size;
  
  if (dayCount < config.minDays) {
    return {
      valid: false,
      error: `You must select at least ${config.minDays} ${formatPlural(config.minDays, 'day')} for your plan (${config.displayName})`,
    };
  }
  
  if (dayCount > config.maxDays) {
    return {
      valid: false,
      error: `You can only select up to ${config.maxDays} ${formatPlural(config.maxDays, 'day')} for your plan (${config.displayName})`,
    };
  }
  
  return { valid: true };
}

function validatePreferredTimes(times: readonly string[]): readonly string[] {
  if (!Array.isArray(times) || times.length === 0) {
    return [DEFAULT_PREFERRED_TIME];
  }
  
  return times.filter((time): time is string => 
    typeof time === 'string' && time.trim().length > 0
  );
}

export function getFrequencySettings(
  planName: string | null | undefined,
  selectedDays: Set<number>,
  preferredTimes: readonly string[] = [DEFAULT_PREFERRED_TIME]
): FrequencySettings {
  if (!validateSelectedDaysInput(selectedDays)) {
    throw new Error('Invalid selectedDays: must be a Set of valid day indices (0-6)');
  }

  const config = getPlanFrequencyConfig(planName);
  const validTimes = validatePreferredTimes(preferredTimes);
  const jsDays = Array.from(selectedDays)
    .map(indexToJsDay)
    .sort((a, b) => a - b);
  
  return {
    interval: WEEKLY_INTERVAL,
    count: config.articlesPerWeek,
    preferredDays: jsDays,
    preferredTimes: validTimes,
  };
}
