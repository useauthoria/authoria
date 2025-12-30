import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';
import type { WebVitalsMetrics } from './lib/webVitals';

interface ShopifyAppBridge {
  readonly webVitals?: {
    readonly onReport: (callback: (metrics: WebVitalsMetrics) => void) => void;
  };
}

interface WindowWithShopify extends Window {
  readonly shopify?: ShopifyAppBridge;
}

const SERVICE_WORKER_PATH = '/sw.js';
const ROOT_ELEMENT_ID = 'root';
const LOAD_EVENT = 'load';

if ('serviceWorker' in navigator) {
  window.addEventListener(LOAD_EVENT, () => {
    navigator.serviceWorker
      .register(SERVICE_WORKER_PATH)
      .catch(() => {});
  });
}

if (typeof window !== 'undefined') {
  import('./lib/webVitals')
    .then(({ initWebVitalsMonitoring }) => {
      const checkAppBridge = (): void => {
        const shopify = (window as WindowWithShopify).shopify;

        if (shopify?.webVitals) {
          initWebVitalsMonitoring(() => {});
        } else {
          setTimeout(checkAppBridge, 100);
        }
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkAppBridge);
      } else {
        checkAppBridge();
      }
    })
    .catch(() => {});
}

import('./utils/prefetch')
  .then(({ setupLinkPrefetching, prefetchCriticalRoutes }) => {
    setupLinkPrefetching();
    prefetchCriticalRoutes();
  })
  .catch(() => {});

const rootElement = document.getElementById(ROOT_ELEMENT_ID);
if (!rootElement) {
  throw new Error('Root element not found');
}

// Show loading state
rootElement.innerHTML = `
  <div style="display: flex; align-items: center; justify-content: center; height: 100vh; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
    <div style="text-align: center;">
      <div style="width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px;"></div>
      <div style="color: #666; font-size: 14px;">Loading Authoria...</div>
    </div>
  </div>
  <style>
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
`;

// Dismiss App Bridge loading if available
const dismissLoading = () => {
  const shopify = (window as WindowWithShopify).shopify;
  if (shopify && typeof (shopify as { loading?: () => void }).loading === 'function') {
    try {
      (shopify as { loading: (show: boolean) => void }).loading(false);
    } catch (error) {
      // Ignore errors
    }
  }
};

// Clear loading state and render
setTimeout(() => {
  rootElement.innerHTML = '';
  dismissLoading();
  
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary onError={() => {}}>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
  
  // Additional attempts to dismiss loading
  setTimeout(dismissLoading, 100);
  setTimeout(dismissLoading, 500);
}, 100);
