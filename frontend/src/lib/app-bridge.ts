/**
 * Shopify App Bridge utilities
 * Provides access to App Bridge APIs for navigation, modals, toasts, etc.
 */


interface ShopifyAppBridge {
  readonly app?: {
    readonly navigate?: (path: string) => void;
  };
  readonly config?: {
    readonly shop?: string;
  };
  readonly environment?: {
    readonly embedded?: boolean;
  };
  readonly ready?: Promise<void>;
  readonly intents?: {
    readonly navigate?: (path: string) => void;
  };
}

interface WindowWithShopify extends Window {
  readonly shopify?: ShopifyAppBridge;
}

let appBridgeInstance: ShopifyAppBridge | null = null;

/**
 * Get the App Bridge instance
 */
function getAppBridge(): ShopifyAppBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if (appBridgeInstance) {
    return appBridgeInstance;
  }

  const shopify = (window as WindowWithShopify).shopify;
  if (shopify) {
    appBridgeInstance = shopify;
    return shopify;
  }

  return null;
}

/**
 * Wait for App Bridge to be ready
 */
export async function waitForAppBridge(): Promise<ShopifyAppBridge | null> {
  const appBridge = getAppBridge();
  if (appBridge?.ready) {
    await appBridge.ready;
    return appBridge;
  }

  // Poll for App Bridge
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      const bridge = getAppBridge();
      if (bridge) {
        clearInterval(checkInterval);
        if (bridge.ready) {
          bridge.ready.then(() => resolve(bridge)).catch(() => resolve(bridge));
        } else {
          resolve(bridge);
        }
      }
    }, 100);

    // Timeout after 5 seconds
    setTimeout(() => {
      clearInterval(checkInterval);
      resolve(getAppBridge());
    }, 5000);
  });
}

/**
 * Navigate using App Bridge
 */
export async function navigate(path: string): Promise<void> {
  const appBridge = await waitForAppBridge();
  if (appBridge?.app?.navigate) {
    appBridge.app.navigate(path);
  } else if (appBridge?.intents?.navigate) {
    appBridge.intents.navigate(path);
  } else {
    // Fallback to regular navigation
    window.location.href = path;
  }
}

/**
 * Check if app is embedded
 */
export function isEmbedded(): boolean {
  const appBridge = getAppBridge();
  return appBridge?.environment?.embedded ?? false;
}

/**
 * Shop context utilities
 */

const SHOPIFY_DOMAIN_SUFFIX = 'myshopify.com';
const DEV_SHOP_DOMAIN = 'example.myshopify.com';
const URL_PARAM_SHOP = 'shop';

function getShopFromAppBridge(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const shopify = (window as WindowWithShopify).shopify;
  return shopify?.config?.shop ?? null;
}

function getShopFromUrl(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(URL_PARAM_SHOP);
}

function getShopFromHostname(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const hostname = window.location.hostname;
  if (hostname.includes(SHOPIFY_DOMAIN_SUFFIX)) {
    return hostname;
  }

  return null;
}

/**
 * Get the shop domain from App Bridge, URL, or hostname
 */
export function getShopDomain(): string {
  const appBridgeShop = getShopFromAppBridge();
  if (appBridgeShop) {
    return appBridgeShop;
  }

  const urlShop = getShopFromUrl();
  if (urlShop) {
    return urlShop;
  }

  const hostnameShop = getShopFromHostname();
  if (hostnameShop) {
    return hostnameShop;
  }

  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    return DEV_SHOP_DOMAIN;
  }

  throw new Error('Unable to determine shop domain');
}

