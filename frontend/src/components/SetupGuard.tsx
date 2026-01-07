import { type ReactNode, useMemo } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useStore } from '../lib/api-cache';
import { getShopDomain } from '../lib/app-bridge';
import { isSetupComplete } from '../utils/setup-check';
import { LoadingSpinner } from './LoadingSpinner';

interface SetupGuardProps {
  readonly children: ReactNode;
}

interface StoreWithId {
  readonly id?: string;
  readonly frequency_settings?: unknown;
}

interface ErrorWithStatusCode {
  readonly statusCode?: number;
}

const SETUP_PATH = '/setup';
const MAX_SHOP_DOMAIN_LENGTH = 200;
const DEFAULT_SHOP_DOMAIN = '';

const validateShopDomain = (shopDomain: string | null | undefined): string => {
  if (!shopDomain || typeof shopDomain !== 'string') {
    return DEFAULT_SHOP_DOMAIN;
  }
  const trimmed = shopDomain.trim();
  if (trimmed.length > MAX_SHOP_DOMAIN_LENGTH) {
    return DEFAULT_SHOP_DOMAIN;
  }
  return trimmed;
};

const hasStatusCode = (error: unknown): error is ErrorWithStatusCode => {
  return (
    error !== null &&
    typeof error === 'object' &&
    'statusCode' in error &&
    typeof (error as ErrorWithStatusCode).statusCode === 'number'
  );
};

const isStoreWithId = (store: unknown): store is StoreWithId => {
  return (
    store !== null &&
    typeof store === 'object' &&
    ('id' in store || 'frequency_settings' in store)
  );
};

const isNotFoundError = (error: unknown): boolean => {
  return hasStatusCode(error) && error.statusCode === 404;
};

const isSetupPath = (pathname: string): boolean => {
  return pathname === SETUP_PATH;
};

export function SetupGuard({ children }: SetupGuardProps): JSX.Element {
  const location = useLocation();
  const rawShopDomain = getShopDomain();
  const shopDomain = useMemo(
    () => validateShopDomain(rawShopDomain),
    [rawShopDomain],
  );

  const { data: store, isLoading, error } = useStore(shopDomain);

  const currentPath = useMemo(() => location.pathname, [location.pathname]);

  const isOnSetupPage = useMemo(
    () => isSetupPath(currentPath),
    [currentPath],
  );

  const shouldRedirectToSetup = useMemo(() => {
    if (!store) {
      return true;
    }
    if (error && isNotFoundError(error)) {
      return true;
    }
    if (!isSetupComplete(store)) {
      return true;
    }
    return false;
  }, [store, error]);

  if (isOnSetupPage) {
    return <>{children}</>;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen w-full">
        <div className="flex flex-col items-center gap-4">
          <LoadingSpinner size="large" label="Loading..." />
        </div>
      </div>
    );
  }

  if (shouldRedirectToSetup) {
    return <Navigate to={SETUP_PATH} replace />;
  }

  return <>{children}</>;
}
