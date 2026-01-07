interface FrequencySettings {
  readonly interval?: string;
  readonly count?: number;
  readonly preferredDays?: readonly number[] | number[];
  readonly preferredTimes?: readonly string[] | string[];
}

interface StoreWithFrequencySettings {
  readonly frequency_settings?: FrequencySettings | null;
}

function isValidDayIndex(day: unknown): day is number {
  return Number.isInteger(day) && typeof day === 'number' && day >= 0 && day <= 6;
}

function isValidDayArray(days: unknown): days is readonly number[] | number[] {
  if (!Array.isArray(days) || days.length === 0) {
    return false;
  }
  return days.every(isValidDayIndex);
}

function isValidTimeString(time: unknown): time is string {
  return typeof time === 'string' && time.trim().length > 0;
}

function isValidTimeArray(times: unknown): times is readonly string[] | string[] {
  if (!Array.isArray(times) || times.length === 0) {
    return false;
  }
  return times.every(isValidTimeString);
}

function isValidFrequencySettings(value: unknown): value is FrequencySettings {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const settings = value as Record<string, unknown>;

  if (!('preferredDays' in settings) || !isValidDayArray(settings.preferredDays)) {
    return false;
  }

  if (!('preferredTimes' in settings) || !isValidTimeArray(settings.preferredTimes)) {
    return false;
  }

  return true;
}

export function isSetupComplete(store: StoreWithFrequencySettings | null | undefined): boolean {
  if (!store || typeof store !== 'object') {
    return false;
  }

  const frequencySettings = store.frequency_settings;

  if (frequencySettings === null || frequencySettings === undefined) {
    return false;
  }

  return isValidFrequencySettings(frequencySettings);
}
