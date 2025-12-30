/**
 * Plan-based frequency configuration
 * Users can only select days, not frequency - frequency is determined by their plan
 */

export interface PlanFrequencyConfig {
  readonly articlesPerWeek: number;
  readonly minDays: number;
  readonly maxDays: number;
  readonly displayName: string;
}

export const PLAN_FREQUENCY_CONFIG: Readonly<Record<string, PlanFrequencyConfig>> = {
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
  authority: {
    articlesPerWeek: 14,
    minDays: 7,
    maxDays: 7,
    displayName: '14 articles per week (2 per day)',
  },
};

/**
 * Get frequency configuration for a plan
 */
export function getPlanFrequencyConfig(planName: string | null | undefined): PlanFrequencyConfig {
  if (!planName) {
    // Default to free_trial if no plan
    return PLAN_FREQUENCY_CONFIG.free_trial;
  }
  
  const normalizedPlanName = planName.toLowerCase().replace(/\s+/g, '_');
  return PLAN_FREQUENCY_CONFIG[normalizedPlanName] || PLAN_FREQUENCY_CONFIG.free_trial;
}

/**
 * Validate selected days against plan limits
 */
export function validateSelectedDays(
  selectedDays: Set<number>,
  planName: string | null | undefined
): { valid: boolean; error?: string } {
  const config = getPlanFrequencyConfig(planName);
  const dayCount = selectedDays.size;
  
  if (dayCount < config.minDays) {
    return {
      valid: false,
      error: `You must select at least ${config.minDays} day${config.minDays > 1 ? 's' : ''} for your plan (${config.displayName})`,
    };
  }
  
  if (dayCount > config.maxDays) {
    return {
      valid: false,
      error: `You can only select up to ${config.maxDays} day${config.maxDays > 1 ? 's' : ''} for your plan (${config.displayName})`,
    };
  }
  
  return { valid: true };
}

/**
 * Get the frequency settings object for a plan and selected days
 */
export function getFrequencySettings(
  planName: string | null | undefined,
  selectedDays: Set<number>,
  preferredTimes: string[] = ['14:00']
): {
  interval: string;
  count: number;
  preferredDays: number[];
  preferredTimes: string[];
} {
  const config = getPlanFrequencyConfig(planName);
  
  // Convert our day indices (Mon=0, ..., Sun=6) to JS day format (Sun=0, Mon=1, ..., Sat=6)
  const indexToJsDay = (index: number): number => {
    return index === 6 ? 0 : index + 1;
  };
  
  return {
    interval: 'weekly',
    count: config.articlesPerWeek,
    preferredDays: Array.from(selectedDays).map(indexToJsDay).sort((a, b) => a - b),
    preferredTimes,
  };
}
