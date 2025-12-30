import { useMemo, useEffect, useCallback, useState } from 'react';
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
  readonly updateSettings: (updates: Partial<SettingsData>) => void;
  readonly resetSettings: () => void;
  readonly isSaving: boolean;
  readonly saveError: Error | null;
  readonly saveSuccess: boolean;
  readonly isOnline: boolean;
}

interface StoreWithSettings extends Store {
  readonly brand_safety_enabled?: boolean; // Now stored in stores.brand_safety_enabled column
  readonly notifications?: SettingsData['notifications'];
}

function mapStoreToSettings(store: StoreWithSettings | null): SettingsData | null {
  if (!store) return null;
  return {
    brand_safety_enabled: store.brand_safety_enabled ?? true,
    notifications: store.notifications,
  };
}

export function useSettingsData(options: UseSettingsDataOptions = {}): UseSettingsDataReturn {
  const {
    enableRealTime = false,
    refetchInterval = 300000, // 5 minute interval to reduce API load
    autoSave = false,
    autoSaveDelay = 2000,
    onError,
  } = options;

  const queryClient = useQueryClient();
  const { isOnline } = useNetworkStatus();
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [localSettings, setLocalSettings] = useState<Partial<SettingsData>>({});

  const shopDomain = useMemo(() => {
    const domain = getShopDomain();
    if (!domain && onError) {
      onError(new Error('Shop domain not available'));
    }
    return domain;
  }, [onError]);

  const {
    data: store,
    isLoading: storeLoading,
    error: storeError,
    refetch: refetchStore,
  } = useStore(shopDomain ?? '');

  const settings = useMemo(() => mapStoreToSettings(store as StoreWithSettings | null), [store]);

  const mergedSettings = useMemo((): SettingsData | null => {
    if (!settings) return null;
    return { ...settings, ...localSettings };
  }, [settings, localSettings]);

  const saveMutation = useMutation({
    mutationFn: async (settingsToSave: SettingsData): Promise<SettingsData> => {
      if (!store?.id) throw new Error('Store not loaded');
      await storeApi.updateStore(store.id, settingsToSave);
      return settingsToSave;
    },
    onSuccess: () => {
      setHasUnsavedChanges(false);
      setLocalSettings({});
      queryClient.invalidateQueries({ queryKey: queryKeys.store(shopDomain ?? '') });
    },
    onError: (error: Error) => {
      if (onError) {
        onError(error);
      }
    },
  });

  useEffect(() => {
    if (!autoSave || !hasUnsavedChanges || !mergedSettings || saveMutation.isPending) {
      return;
    }

    const timer = setTimeout(() => {
      if (mergedSettings) {
        saveMutation.mutate(mergedSettings);
      }
    }, autoSaveDelay);

    return () => clearTimeout(timer);
  }, [autoSave, hasUnsavedChanges, mergedSettings, autoSaveDelay, saveMutation]);

  const updateSettings = useCallback((updates: Partial<SettingsData>) => {
    setLocalSettings((prev) => ({ ...prev, ...updates }));
    setHasUnsavedChanges(true);
  }, []);

  const saveSettings = useCallback(() => {
    if (mergedSettings) {
      saveMutation.mutate(mergedSettings);
    }
  }, [mergedSettings, saveMutation]);

  const resetSettings = useCallback(() => {
    setLocalSettings({});
    setHasUnsavedChanges(false);
  }, []);

  const isLoading = storeLoading || saveMutation.isPending;
  const isError = !!storeError;
  const error = storeError || null;

  useEffect(() => {
    if (error && onError) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }, [error, onError]);

  useEffect(() => {
    if (isOnline && !isLoading) {
      refetchStore();
    }
  }, [isOnline, isLoading, refetchStore]);

  useEffect(() => {
    if (!enableRealTime || !store?.id) {
      return;
    }

    const interval = setInterval(() => {
      refetchStore();
    }, refetchInterval);

    return () => clearInterval(interval);
  }, [enableRealTime, refetchInterval, store?.id, refetchStore]);

  return {
    settings: mergedSettings,
    hasUnsavedChanges,
    isLoading,
    isError,
    error,
    saveSettings,
    updateSettings,
    resetSettings,
    isSaving: saveMutation.isPending,
    saveError: saveMutation.error ?? null,
    saveSuccess: saveMutation.isSuccess,
    isOnline,
  };
}
