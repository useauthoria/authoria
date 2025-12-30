import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useStore } from '../lib/api-cache';
import { getShopDomain } from '../lib/app-bridge';
import { isSetupComplete } from '../utils/setup-check';
import { LoadingSpinner } from './LoadingSpinner';

interface SetupGuardProps {
  children: ReactNode;
}

/**
 * SetupGuard component that redirects to setup if store setup is not complete
 * This makes setup mandatory - users cannot access other pages until setup is done
 */
export function SetupGuard({ children }: SetupGuardProps) {
  const location = useLocation();
  const shopDomain = getShopDomain() || '';
  const { data: store, isLoading, error } = useStore(shopDomain);

  // Always allow access to setup page
  if (location.pathname === '/setup') {
    return <>{children}</>;
  }

  // Show loading while checking store
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen w-full">
        <div className="flex flex-col items-center gap-4">
          <LoadingSpinner size="large" label="Loading..." />
        </div>
      </div>
    );
  }

  // If store doesn't exist (404) or is null, redirect to setup
  // The API will auto-create the store, but setup needs to run first
  if (!store || (error && (error as { statusCode?: number })?.statusCode === 404)) {
    return <Navigate to="/setup" replace />;
  }

  // Redirect to setup if not complete
  if (!isSetupComplete(store)) {
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
      // eslint-disable-next-line no-console
      console.debug('[SetupGuard] Setup incomplete, redirecting to /setup', {
        shopDomain,
        storeId: (store as { id?: string }).id,
        frequency_settings: (store as { frequency_settings?: unknown }).frequency_settings,
      });
    }
    return <Navigate to="/setup" replace />;
  }

  // Allow access if setup is complete
  return <>{children}</>;
}

