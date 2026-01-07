import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

interface ShopifyAppBridge {
  readonly loading?: (show: boolean) => void;
}

interface WindowWithShopify extends Window {
  readonly shopify?: ShopifyAppBridge;
}

const SERVICE_WORKER_PATH = '/sw.js' as const;
const ROOT_ELEMENT_ID = 'root' as const;
const LOAD_EVENT = 'load' as const;
const INITIAL_RENDER_DELAY_MS = 100;
const DISMISS_LOADING_DELAYS_MS = [100, 500] as const;
const LOADING_SPINNER_SIZE = 40;
const LOADING_SPINNER_BORDER_WIDTH = 4;
const LOADING_TEXT_SIZE = 14;

function isWindowWithShopify(window: Window): window is WindowWithShopify {
  return 'shopify' in window;
}

function hasLoadingMethod(shopify: unknown): shopify is { loading: (show: boolean) => void } {
  return (
    shopify !== null &&
    typeof shopify === 'object' &&
    'loading' in shopify &&
    typeof (shopify as { loading?: unknown }).loading === 'function'
  );
}

function createLoadingHTML(): string {
  return `
    <div style="display: flex; align-items: center; justify-content: center; height: 100vh; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="text-align: center;">
        <div style="width: ${LOADING_SPINNER_SIZE}px; height: ${LOADING_SPINNER_SIZE}px; border: ${LOADING_SPINNER_BORDER_WIDTH}px solid #f3f3f3; border-top: ${LOADING_SPINNER_BORDER_WIDTH}px solid #3498db; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px;"></div>
        <div style="color: #666; font-size: ${LOADING_TEXT_SIZE}px;">Loading Authoria...</div>
      </div>
    </div>
    <style>
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    </style>
  `;
}

function dismissShopifyLoading(): void {
  if (!isWindowWithShopify(window)) {
    return;
  }

  const shopify = window.shopify;
  if (!shopify || !hasLoadingMethod(shopify)) {
    return;
  }

  try {
    shopify.loading(false);
  } catch {
  }
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  const handleLoad = (): void => {
    navigator.serviceWorker
      .register(SERVICE_WORKER_PATH)
      .catch(() => {});
  };

  window.addEventListener(LOAD_EVENT, handleLoad, { once: true });
}

function initializePrefetching(): void {
  import('./utils/prefetch')
    .then(({ setupLinkPrefetching, prefetchCriticalRoutes }) => {
      setupLinkPrefetching();
      prefetchCriticalRoutes();
    })
    .catch(() => {});
}

function getRootElement(): HTMLElement {
  const element = document.getElementById(ROOT_ELEMENT_ID);
  if (!element) {
    throw new Error(`Root element with id "${ROOT_ELEMENT_ID}" not found`);
  }
  return element;
}

function renderApp(rootElement: HTMLElement): void {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

function scheduleDismissLoadingAttempts(): void {
  for (const delay of DISMISS_LOADING_DELAYS_MS) {
    setTimeout(dismissShopifyLoading, delay);
  }
}

function initializeApp(): void {
  const rootElement = getRootElement();
  rootElement.innerHTML = createLoadingHTML();

  setTimeout(() => {
    rootElement.innerHTML = '';
    dismissShopifyLoading();
    renderApp(rootElement);
    scheduleDismissLoadingAttempts();
  }, INITIAL_RENDER_DELAY_MS);
}

registerServiceWorker();
initializePrefetching();
initializeApp();
