import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
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

interface UseAppBridgeReturn extends AppBridgeState {
  readonly navigate: (path: string) => Promise<void>;
}

interface UseAppBridgeToastReturn {
  readonly showToast: (message: string, options?: ToastOptions) => Promise<void>;
}

interface AppBridgeWithToast {
  readonly toast?: {
    readonly show?: (message: string, options?: { readonly duration?: number; readonly isError?: boolean }) => void;
  };
}

const DEFAULT_TOAST_DURATION = 3000;
const MIN_DURATION = 0;
const MAX_DURATION = 10000;
const MIN_PATH_LENGTH = 1;
const MAX_PATH_LENGTH = 500;
const MIN_MESSAGE_LENGTH = 1;
const MAX_MESSAGE_LENGTH = 500;

const hasToast = (appBridge: unknown): appBridge is AppBridgeWithToast => {
  return (
    appBridge !== null &&
    typeof appBridge === 'object' &&
    'toast' in appBridge &&
    appBridge.toast !== null &&
    typeof appBridge.toast === 'object'
  );
};

const validatePath = (path: string): string | null => {
  if (!path || typeof path !== 'string') {
    return null;
  }
  const trimmed = path.trim();
  if (trimmed.length < MIN_PATH_LENGTH || trimmed.length > MAX_PATH_LENGTH) {
    return null;
  }
  return trimmed;
};

const validateMessage = (message: string): string | null => {
  if (!message || typeof message !== 'string') {
    return null;
  }
  const trimmed = message.trim();
  if (trimmed.length < MIN_MESSAGE_LENGTH || trimmed.length > MAX_MESSAGE_LENGTH) {
    return null;
  }
  return trimmed;
};

const validateDuration = (duration: number | undefined): number => {
  if (duration === undefined || duration === null) {
    return DEFAULT_TOAST_DURATION;
  }
  if (typeof duration !== 'number' || !Number.isFinite(duration)) {
    return DEFAULT_TOAST_DURATION;
  }
  if (duration < MIN_DURATION) {
    return MIN_DURATION;
  }
  if (duration > MAX_DURATION) {
    return MAX_DURATION;
  }
  return Math.floor(duration);
};

export function useAppBridge(): UseAppBridgeReturn {
  const isMountedRef = useRef(true);
  const [state, setState] = useState<AppBridgeState>({
    isReady: false,
    isEmbedded: false,
  });

  useEffect(() => {
    isMountedRef.current = true;
    let isCancelled = false;

    const initializeAppBridge = async (): Promise<void> => {
      try {
        const appBridge = await waitForAppBridge();
        if (!isCancelled && isMountedRef.current && appBridge) {
          setState({
            isReady: true,
            isEmbedded: isEmbedded(),
            shop: appBridge.config?.shop || undefined,
          });
        }
      } catch {
        if (!isCancelled && isMountedRef.current) {
          setState({
            isReady: false,
            isEmbedded: false,
          });
        }
      }
    };

    initializeAppBridge().catch(() => {
    });

    return () => {
      isCancelled = true;
      isMountedRef.current = false;
    };
  }, []);

  const handleNavigate = useCallback(
    async (path: string): Promise<void> => {
      if (!isMountedRef.current) {
        return;
      }

      const validatedPath = validatePath(path);
      if (!validatedPath) {
        return;
      }

      try {
        await appBridgeNavigate(validatedPath);
      } catch {
      }
    },
    [],
  );

  return useMemo(
    () => ({
      ...state,
      navigate: handleNavigate,
    }),
    [state, handleNavigate],
  );
}

export function useAppBridgeToast(): UseAppBridgeToastReturn {
  const showToast = useCallback(
    async (message: string, options?: ToastOptions): Promise<void> => {
      const validatedMessage = validateMessage(message);
      if (!validatedMessage) {
        return;
      }

      const validatedDuration = validateDuration(options?.duration);
      const validatedIsError = options?.isError === true;

      try {
        const appBridge = await waitForAppBridge();
        if (appBridge && hasToast(appBridge)) {
          const toastShow = appBridge.toast?.show;
          if (typeof toastShow === 'function') {
            toastShow(validatedMessage, {
              duration: validatedDuration,
              isError: validatedIsError,
            });
          }
        }
      } catch {
      }
    },
    [],
  );

  return useMemo(
    () => ({
      showToast,
    }),
    [showToast],
  );
}
