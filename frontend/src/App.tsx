import { Suspense, lazy, useMemo, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from './components/ErrorBoundary';
import Layout from './components/Layout';
import { ToastContainer, useToast } from './components/Toast';
import { LoadingSpinner } from './components/LoadingSpinner';
import { SetupGuard } from './components/SetupGuard';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Articles = lazy(() => import('./pages/Articles'));
const Analytics = lazy(() => import('./pages/Analytics').then((m) => ({ default: m.default })));
const Settings = lazy(() => import('./pages/Settings'));
const Setup = lazy(() => import('./pages/Setup'));
const Schedule = lazy(() => import('./pages/Schedule'));

const STALE_TIME_MS = 5 * 60 * 1000;
const GC_TIME_MS = 10 * 60 * 1000;
const RETRY_COUNT = 2;
const DASHBOARD_PATH = '/dashboard' as const;
const ROOT_PATH = '/' as const;
const POSTS_PATH = '/posts' as const;
const ANALYTICS_PATH = '/analytics' as const;
const SETTINGS_PATH = '/settings' as const;
const SETUP_PATH = '/setup' as const;
const SCHEDULE_PATH = '/schedule' as const;

interface RouteConfig {
  readonly path: string;
  readonly component: React.ComponentType;
}

const ROUTE_CONFIGS: readonly RouteConfig[] = [
  { path: DASHBOARD_PATH, component: Dashboard },
  { path: POSTS_PATH, component: Articles },
  { path: ANALYTICS_PATH, component: Analytics },
  { path: SETTINGS_PATH, component: Settings },
  { path: SETUP_PATH, component: Setup },
  { path: SCHEDULE_PATH, component: Schedule },
];

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
        gcTime: GC_TIME_MS,
        retry: RETRY_COUNT,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
    },
  });
}

function LoadingFallback(): JSX.Element {
  return (
    <div
      className="flex items-center justify-center min-h-[400px] w-full"
      role="status"
      aria-label="Loading page"
    >
      <div className="flex flex-col items-center gap-4">
        <LoadingSpinner size="large" label="Loading page" />
      </div>
    </div>
  );
}

function NotFoundPage(): JSX.Element {
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Page Not Found</h1>
        <p className="text-gray-600 mb-4">The page you're looking for doesn't exist.</p>
        <Navigate to={DASHBOARD_PATH} replace />
      </div>
    </div>
  );
}

function createRouteElement(Component: React.ComponentType): ReactNode {
  return (
    <Layout>
      <Suspense fallback={<LoadingFallback />}>
        <Component />
      </Suspense>
    </Layout>
  );
}

function AppRoutes(): JSX.Element {
  return (
    <Routes>
      <Route
        path={ROOT_PATH}
        element={
          <Layout>
            <Navigate to={DASHBOARD_PATH} replace />
          </Layout>
        }
      />
      {ROUTE_CONFIGS.map(({ path, component: Component }) => (
        <Route
          key={path}
          path={path}
          element={createRouteElement(Component)}
        />
      ))}
      <Route
        path="*"
        element={
          <Layout>
            <NotFoundPage />
          </Layout>
        }
      />
    </Routes>
  );
}

function AppContent(): JSX.Element {
  const { toasts, dismissToast } = useToast();

  return (
    <>
      <SetupGuard>
        <AppRoutes />
      </SetupGuard>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

function App(): JSX.Element {
  const queryClient = useMemo(() => createQueryClient(), []);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ErrorBoundary>
          <AppContent />
        </ErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
