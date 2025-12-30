/**
 * Utility to check if store setup is complete
 * Setup is considered complete when frequency_settings has been properly configured
 * (not just the default value)
 */

export interface Store {
  id?: string;
  frequency_settings?: {
    interval?: string;
    count?: number;
    preferredDays?: number[];
    preferredTimes?: string[];
  } | null;
}

/**
 * Check if setup is complete by verifying frequency_settings has been configured
 * Setup is complete if:
 * 1. frequency_settings exists
 * 2. preferredDays array exists and has at least 1 day selected
 * 3. preferredTimes array exists and has at least 1 time
 */
export function isSetupComplete(store: Store | null | undefined): boolean {
  if (!store) {
    return false;
  }

  const frequencySettings = store.frequency_settings;
  
  // If no frequency_settings, setup is not complete
  if (!frequencySettings || typeof frequencySettings !== 'object') {
    return false;
  }

  // Check if preferredDays is configured (not just default)
  const preferredDays = frequencySettings.preferredDays;
  if (!Array.isArray(preferredDays) || preferredDays.length === 0) {
    return false;
  }

  // Check if preferredTimes is configured
  const preferredTimes = frequencySettings.preferredTimes;
  if (!Array.isArray(preferredTimes) || preferredTimes.length === 0) {
    return false;
  }

  // Setup is complete if we have both days and times configured
  return true;
}

