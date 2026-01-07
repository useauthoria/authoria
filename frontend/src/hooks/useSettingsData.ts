import { useMemo, useEffect, useCallback, useState, useRef } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { useStore, queryKeys } from '../lib/api-cache';
import { getShopDomain } from '../lib/app-bridge';
import { storeApi } from '../lib/api-client';
import type { Store } from '../lib/api-client';
import { useNetworkStatus } from './useNetworkStatus';

export interface SettingsData {
  readonly brand_safety_enabled: boolean;
  readonly notifications?: {
    readonly email?: {
      readonly enabled: boolean;
      readonly article_published?: boolean;
      readonly article_scheduled?: boolean;
    };
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// Deep-partial shape for UI updates (lets us toggle individual notification fields without requiring `enabled`)
export interface SettingsUpdates {
  readonly brand_safety_enabled?: boolean;
  readonly notifications?: {
    readonly email?: {
      readonly enabled?: boolean;
      readonly article_published?: boolean;
      readonly article_scheduled?: boolean;
    };
  };
}

export interface UseSettingsDataOptions {
  readonly enableRealTime?: boolean;
  readonly refetchInterval?: number;
  readonly autoSave?: boolean;
  readonly autoSaveDelay?: number;
  readonly onError?: (error: Error) => void;
}

export interface UseSettingsDataReturn {
  readonly settings: SettingsData | null;
  readonly hasUnsavedChanges: boolean;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
  readonly saveSettings: () => void;
  readonly updateSettings: (updates: SettingsUpdates) => void;
  readonly resetSettings: () => void;
  readonly isSaving: boolean;
  readonly saveError: Error | null;
  readonly saveSuccess: boolean;
  readonly isOnline: boolean;
}

interface StoreWithSettings extends Store {
  readonly brand_safety_enabled?: boolean;
  readonly notifications?: SettingsData['notifications'];
}

const DEFAULT_ENABLE_REAL_TIME = false;
const DEFAULT_REFETCH_INTERVAL = 300000;
const DEFAULT_AUTO_SAVE = false;
const DEFAULT_AUTO_SAVE_DELAY = 2000;
const MIN_REFETCH_INTERVAL = 30000;
const MIN_AUTO_SAVE_DELAY = 0;
const MAX_AUTO_SAVE_DELAY = 30000;
const MAX_SHOP_DOMAIN_LENGTH = 200;

const isStoreWithSettings = (store: Store | null): store is StoreWithSettings => {
  return store !== null && typeof store === 'object';
};

const validateRefetchInterval = (interval: number | undefined): number => {
  if (interval === undefined || interval === null) {
    return DEFAULT_REFETCH_INTERVAL;
  }
  if (typeof interval !== 'number' || !Number.isFinite(interval)) {
    return DEFAULT_REFETCH_INTERVAL;
  }
  if (interval < MIN_REFETCH_INTERVAL) {
    return MIN_REFETCH_INTERVAL;
  }
  return Math.floor(interval);
};

const validateAutoSaveDelay = (delay: number | undefined): number => {
  if (delay === undefined || delay === null) {
    return DEFAULT_AUTO_SAVE_DELAY;
  }
  if (typeof delay !== 'number' || !Number.isFinite(delay)) {
    return DEFAULT_AUTO_SAVE_DELAY;
  }
  if (delay < MIN_AUTO_SAVE_DELAY) {
    return MIN_AUTO_SAVE_DELAY;
  }
  if (delay > MAX_AUTO_SAVE_DELAY) {
    return MAX_AUTO_SAVE_DELAY;
  }
  return Math.floor(delay);
};

const validateShopDomain = (shopDomain: string | null | undefined): string | null => {
  if (!shopDomain || typeof shopDomain !== 'string') {
    return null;
  }
  const trimmed = shopDomain.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SHOP_DOMAIN_LENGTH) {
    return null;
  }
  return trimmed;
};

const normalizeError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = String(error.message);
    return new Error(message.length > 0 ? message : 'Unknown error');
  }
  return new Error(String(error));
};

const validateSettingsData = (settings: SettingsData | null): SettingsData | null => {
  if (!settings || typeof settings !== 'object') {
    return null;
  }
  if (typeof settings.brand_safety_enabled !== 'boolean') {
    return null;
  }
  const email = settings.notifications?.email;
  if (email && typeof email === 'object' && typeof email.enabled !== 'boolean') {
    return null;
  }
  return settings;
};

const validatePartialSettings = (updates: SettingsUpdates | null | undefined): SettingsUpdates => {
  if (!updates || typeof updates !== 'object') {
    return {};
  }
  const validated: Mutable<SettingsUpdates> = {};
  if ('brand_safety_enabled' in updates && typeof updates.brand_safety_enabled === 'boolean') {
    validated.brand_safety_enabled = updates.brand_safety_enabled;
  }
  if ('notifications' in updates && updates.notifications !== null && typeof updates.notifications === 'object') {
    const notifications = updates.notifications;
    const email = notifications.email;
    if (email !== null && typeof email === 'object') {
      const validatedEmail: Mutable<NonNullable<NonNullable<SettingsUpdates['notifications']>['email']>> = {};
      if (typeof email.enabled === 'boolean') {
        validatedEmail.enabled = email.enabled;
      }
      if (typeof email.article_published === 'boolean') {
        validatedEmail.article_published = email.article_published;
      }
      if (typeof email.article_scheduled === 'boolean') {
        validatedEmail.article_scheduled = email.article_scheduled;
      }
      if (Object.keys(validatedEmail).length > 0) {
        validated.notifications = { email: validatedEmail };
      }
    }
  }
  return validated;
};

function mergeSettings(base: SettingsData, updates: SettingsUpdates): SettingsData {
  const baseEmail = base.notifications?.email;
  const updEmail = updates.notifications?.email;

  const mergedEmail =
    baseEmail || updEmail
      ? {
          enabled: (updEmail?.enabled ?? baseEmail?.enabled ?? false) as boolean,
          article_published: updEmail?.article_published ?? baseEmail?.article_published,
          article_scheduled: updEmail?.article_scheduled ?? baseEmail?.article_scheduled,
        }
      : undefined;

  const mergedNotifications =
    base.notifications || updates.notifications
      ? {
          email: mergedEmail,
        }
      : undefined;

  return {
    brand_safety_enabled: updates.brand_safety_enabled ?? base.brand_safety_enabled,
    notifications: mergedNotifications,
  };
}

function mapStoreToSettings(store: StoreWithSettings | null): SettingsData | null {
  if (!isStoreWithSettings(store)) {
    return null;
  }
  try {
    const email = store.notifications?.email;
    const normalizedNotifications =
      email && typeof email === 'object'
        ? {
            email: {
              enabled: typeof email.enabled === 'boolean' ? email.enabled : false,
              article_published: typeof email.article_published === 'boolean' ? email.article_published : undefined,
              article_scheduled: typeof email.article_scheduled === 'boolean' ? email.article_scheduled : undefined,
            },
          }
        : store.notifications || undefined;

    return {
      brand_safety_enabled: typeof store.brand_safety_enabled === 'boolean' ? store.brand_safety_enabled : true,
      notifications: normalizedNotifications,
    };
  } catch {
    return null;
  }
}

export function useSettingsData(
  options: UseSettingsDataOptions = {},
): UseSettingsDataReturn {
  const isMountedRef = useRef(true);
  const {
    enableRealTime = DEFAULT_ENABLE_REAL_TIME,
    refetchInterval = DEFAULT_REFETCH_INTERVAL,
    autoSave = DEFAULT_AUTO_SAVE,
    autoSaveDelay = DEFAULT_AUTO_SAVE_DELAY,
    onError,
  } = options;

  const queryClient = useQueryClient();
  const { isOnline } = useNetworkStatus();
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [localSettings, setLocalSettings] = useState<SettingsUpdates>({});

  const validatedRefetchInterval = useMemo(
    () => validateRefetchInterval(refetchInterval),
    [refetchInterval],
  );

  const validatedAutoSaveDelay = useMemo(
    () => validateAutoSaveDelay(autoSaveDelay),
    [autoSaveDelay],
  );

  const shopDomain = useMemo(() => {
    const domain = getShopDomain();
    const validated = validateShopDomain(domain);
    if (!validated && onError && isMountedRef.current) {
      try {
        onError(new Error('Shop domain not available'));
      } catch {
      }
    }
    return validated;
  }, [onError]);

  const validatedShopDomain = useMemo(() => shopDomain ?? '', [shopDomain]);

  const {
    data: store,
    isLoading: storeLoading,
    error: storeError,
    refetch: refetchStore,
  } = useStore(validatedShopDomain);

  const storeWithSettings = useMemo((): StoreWithSettings | null => {
    if (!isStoreWithSettings(store)) {
      return null;
    }
    return store;
  }, [store]);

  const settings = useMemo(
    () => mapStoreToSettings(storeWithSettings),
    [storeWithSettings],
  );

  const mergedSettings = useMemo((): SettingsData | null => {
    if (!settings) {
      return null;
    }
    try {
      const merged = mergeSettings(settings, localSettings);
      return validateSettingsData(merged);
    } catch {
      return settings;
    }
  }, [settings, localSettings]);

  const saveMutation = useMutation({
    mutationFn: async (settingsToSave: SettingsData): Promise<SettingsData> => {
      if (!store?.id || typeof store.id !== 'string' || store.id.trim().length === 0) {
        throw new Error('Store not loaded');
      }
      const validated = validateSettingsData(settingsToSave);
      if (!validated) {
        throw new Error('Invalid settings data');
      }
      try {
        await storeApi.updateStore(store.id, validated);
        return validated;
      } catch (error) {
        throw normalizeError(error);
      }
    },
    onSuccess: () => {
      if (isMountedRef.current) {
        setHasUnsavedChanges(false);
        setLocalSettings({});
      }
      try {
        queryClient.invalidateQueries({ queryKey: queryKeys.store(validatedShopDomain) });
      } catch {
      }
    },
    onError: (error: unknown) => {
      if (onError && isMountedRef.current) {
        try {
          onError(normalizeError(error));
        } catch {
        }
      }
    },
  });

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!autoSave || !hasUnsavedChanges || !mergedSettings || saveMutation.isPending || !isMountedRef.current) {
      return;
    }

    const timerId = setTimeout(() => {
      if (mergedSettings && isMountedRef.current) {
        try {
          saveMutation.mutate(mergedSettings);
        } catch {
        }
      }
    }, validatedAutoSaveDelay);

    return () => {
      clearTimeout(timerId);
    };
  }, [autoSave, hasUnsavedChanges, mergedSettings, validatedAutoSaveDelay, saveMutation]);

  const updateSettings = useCallback(
    (updates: SettingsUpdates) => {
      if (!isMountedRef.current) {
        return;
      }
      try {
        const validated = validatePartialSettings(updates);
        if (Object.keys(validated).length === 0) {
          return;
        }
        setLocalSettings((prev) => {
          try {
            // Deep-merge notifications.email
            const nextEmail = validated.notifications?.email
              ? { ...(prev.notifications?.email ?? {}), ...validated.notifications.email }
              : prev.notifications?.email;
            const nextNotifications = validated.notifications
              ? { ...(prev.notifications ?? {}), ...(validated.notifications ?? {}), email: nextEmail }
              : prev.notifications;
            return { ...prev, ...validated, notifications: nextNotifications };
          } catch {
            return prev;
          }
        });
        setHasUnsavedChanges(true);
      } catch {
      }
    },
    [],
  );

  const saveSettings = useCallback(() => {
    if (!isMountedRef.current || !mergedSettings) {
      return;
    }
    try {
      saveMutation.mutate(mergedSettings);
    } catch {
    }
  }, [mergedSettings, saveMutation]);

  const resetSettings = useCallback(() => {
    if (!isMountedRef.current) {
      return;
    }
    setLocalSettings({});
    setHasUnsavedChanges(false);
  }, []);

  const isLoading = useMemo(
    () => storeLoading || saveMutation.isPending,
    [storeLoading, saveMutation.isPending],
  );

  const isError = useMemo(() => !!storeError, [storeError]);

  const error = useMemo(() => {
    if (storeError) {
      return normalizeError(storeError);
    }
    return null;
  }, [storeError]);

  const saveError = useMemo(() => {
    if (saveMutation.error) {
      return normalizeError(saveMutation.error);
    }
    return null;
  }, [saveMutation.error]);

  useEffect(() => {
    if (!error || !onError || !isMountedRef.current) {
      return;
    }
    try {
      onError(error);
    } catch {
    }
  }, [error, onError]);

  useEffect(() => {
    if (!isOnline || isLoading || !isMountedRef.current) {
      return;
    }
    try {
      refetchStore();
    } catch {
    }
  }, [isOnline, isLoading, refetchStore]);

  useEffect(() => {
    if (!enableRealTime || !store?.id || !isMountedRef.current) {
      return;
    }

    const intervalId = setInterval(() => {
      if (isMountedRef.current) {
        try {
          refetchStore();
        } catch {
        }
      }
    }, validatedRefetchInterval);

    return () => {
      clearInterval(intervalId);
    };
  }, [enableRealTime, validatedRefetchInterval, store?.id, refetchStore]);

  return useMemo(
    () => ({
      settings: mergedSettings,
      hasUnsavedChanges,
      isLoading,
      isError,
      error,
      saveSettings,
      updateSettings,
      resetSettings,
      isSaving: saveMutation.isPending,
      saveError,
      saveSuccess: saveMutation.isSuccess,
      isOnline,
    }),
    [
      mergedSettings,
      hasUnsavedChanges,
      isLoading,
      isError,
      error,
      saveSettings,
      updateSettings,
      resetSettings,
      saveMutation.isPending,
      saveError,
      saveMutation.isSuccess,
      isOnline,
    ],
  );
}
