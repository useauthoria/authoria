import { useEffect, useState, useCallback } from 'react';
import { waitForAppBridge, navigate as appBridgeNavigate, isEmbedded } from '../lib/app-bridge';

export interface AppBridgeState {
  readonly isReady: boolean;
  readonly isEmbedded: boolean;
  readonly shop?: string;
}

export interface ToastOptions {
  readonly duration?: number;
  readonly isError?: boolean;
}

/**
 * Hook to access App Bridge functionality
 */
export function useAppBridge(): AppBridgeState & {
  readonly navigate: (path: string) => Promise<void>;
} {
  const [state, setState] = useState<AppBridgeState>({
    isReady: false,
    isEmbedded: false,
  });

  useEffect(() => {
    waitForAppBridge().then((appBridge) => {
      if (appBridge) {
        setState({
          isReady: true,
          isEmbedded: isEmbedded(),
          shop: appBridge.config?.shop,
        });
      }
    });
  }, []);

  const handleNavigate = useCallback(async (path: string) => {
    await appBridgeNavigate(path);
  }, []);

  return {
    ...state,
    navigate: handleNavigate,
  };
}

/**
 * Hook to show toast notifications via App Bridge
 */
export function useAppBridgeToast(): {
  readonly showToast: (message: string, options?: ToastOptions) => Promise<void>;
} {
  const showToast = useCallback(async (message: string, options?: ToastOptions) => {
    const appBridge = await waitForAppBridge();
    if (appBridge?.toast?.show) {
      appBridge.toast.show(message, {
        duration: options?.duration ?? 3000,
        isError: options?.isError ?? false,
      });
    }
    // Fallback: If App Bridge toast is not available, silently fail
  }, []);

  return { showToast };
}
