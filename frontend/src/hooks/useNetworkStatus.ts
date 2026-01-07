import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

export interface NetworkStatus {
  readonly isOnline: boolean;
}

const getInitialOnlineStatus = (): boolean => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return true;
  }
  if (typeof navigator.onLine !== 'boolean') {
    return true;
  }
  return navigator.onLine;
};

const hasWindow = (): boolean => {
  return typeof window !== 'undefined';
};

const hasNavigator = (): boolean => {
  return typeof navigator !== 'undefined';
};

export function useNetworkStatus(): NetworkStatus {
  const isMountedRef = useRef(true);
  const [isOnline, setIsOnline] = useState(getInitialOnlineStatus);

  const handleOnline = useCallback(() => {
    if (isMountedRef.current) {
      setIsOnline(true);
    }
  }, []);

  const handleOffline = useCallback(() => {
    if (isMountedRef.current) {
      setIsOnline(false);
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    if (!hasWindow() || !hasNavigator()) {
      return;
    }

    try {
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        if (typeof navigator.onLine === 'boolean') {
          setIsOnline(navigator.onLine);
        }
      }
    } catch {
    }

    return () => {
      isMountedRef.current = false;
      if (!hasWindow()) {
        return;
      }
      try {
        if (typeof window.removeEventListener === 'function') {
          window.removeEventListener('online', handleOnline);
          window.removeEventListener('offline', handleOffline);
        }
      } catch {
      }
    };
  }, [handleOnline, handleOffline]);

  return useMemo(
    () => ({
      isOnline,
    }),
    [isOnline],
  );
}
