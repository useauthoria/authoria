import { Suspense, lazy, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from './components/ErrorBoundary';
import Layout from './components/Layout';
import { ToastContainer, useToast } from './components/Toast';
import { LoadingSpinner } from './components/LoadingSpinner';
import { SetupGuard } from './components/SetupGuard';
import AppNav from './components/AppNav';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Articles = lazy(() => import('./pages/Articles'));
const Analytics = lazy(() => import('./pages/Analytics').then(m => ({ default: m.default })));
const Settings = lazy(() => import('./pages/Settings'));
const Setup = lazy(() => import('./pages/Setup'));
const Schedule = lazy(() => import('./pages/Schedule'));

const STALE_TIME_MS = 5 * 60 * 1000;
const GC_TIME_MS = 10 * 60 * 1000;
const RETRY_COUNT = 2;
const DASHBOARD_PATH = '/dashboard';
const ROOT_PATH = '/';
const POSTS_PATH = '/posts';
const ANALYTICS_PATH = '/analytics';
const SETTINGS_PATH = '/settings';
const SETUP_PATH = '/setup';
const SCHEDULE_PATH = '/schedule';

const queryClient = new QueryClient({
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


function LoadingFallback() {
  return (
    <div className="flex items-center justify-center min-h-[400px] w-full" role="status" aria-label="Loading page">
      <div className="flex flex-col items-center gap-4">
        <LoadingSpinner size="large" label="Loading page" />
      </div>
    </div>
  );
}

function AppContent() {
  const { toasts, dismissToast } = useToast();

  return (
    <>
      <SetupGuard>
        <Routes>
          <Route
            path={ROOT_PATH}
            element={
              <Layout>
                <Navigate to={DASHBOARD_PATH} replace />
              </Layout>
            }
          />
          <Route
            path={DASHBOARD_PATH}
            element={
              <Layout>
                <Suspense fallback={<LoadingFallback />}>
                  <Dashboard />
                </Suspense>
              </Layout>
            }
          />
          <Route
            path={POSTS_PATH}
            element={
              <Layout>
                <Suspense fallback={<LoadingFallback />}>
                  <Articles />
                </Suspense>
              </Layout>
            }
          />
          <Route
            path={ANALYTICS_PATH}
            element={
              <Layout>
                <Suspense fallback={<LoadingFallback />}>
                  <Analytics />
                </Suspense>
              </Layout>
            }
          />
          <Route
            path={SETTINGS_PATH}
            element={
              <Layout>
                <Suspense fallback={<LoadingFallback />}>
                  <Settings />
                </Suspense>
              </Layout>
            }
          />
          <Route
            path={SETUP_PATH}
            element={
              <Layout>
                <Suspense fallback={<LoadingFallback />}>
                  <Setup />
                </Suspense>
              </Layout>
            }
          />
          <Route
            path={SCHEDULE_PATH}
            element={
              <Layout>
                <Suspense fallback={<LoadingFallback />}>
                  <Schedule />
                </Suspense>
              </Layout>
            }
          />
          <Route
            path="*"
            element={
              <Layout>
                <div className="flex items-center justify-center min-h-[400px]">
                  <div className="text-center">
                    <h1 className="text-2xl font-bold text-gray-900 mb-2">Page Not Found</h1>
                    <p className="text-gray-600 mb-4">The page you're looking for doesn't exist.</p>
                    <Navigate to={DASHBOARD_PATH} replace />
                  </div>
                </div>
              </Layout>
            }
          />
        </Routes>
      </SetupGuard>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}


function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ErrorBoundary>
          <AppNav />
          <AppContent />
        </ErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
