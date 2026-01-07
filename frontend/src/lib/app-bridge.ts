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

interface ImportMetaEnv {
  readonly DEV?: boolean;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}

const POLL_INTERVAL_MS = 100;
const WAIT_TIMEOUT_MS = 5000;
const SHOPIFY_DOMAIN_SUFFIX = 'myshopify.com';
const DEV_SHOP_DOMAIN = 'example.myshopify.com';
const URL_PARAM_SHOP = 'shop';
const MAX_PATH_LENGTH = 2048;
const MAX_SHOP_DOMAIN_LENGTH = 255;

let appBridgeInstance: ShopifyAppBridge | null = null;

const hasWindow = (): boolean => {
  return typeof window !== 'undefined';
};

const hasShopify = (window: Window): window is WindowWithShopify => {
  return 'shopify' in window;
};

const validatePath = (path: string | undefined | null): string | null => {
  if (!path || typeof path !== 'string') {
    return null;
  }
  const trimmed = path.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PATH_LENGTH) {
    return null;
  }
  return trimmed;
};

const validateShopDomain = (shopDomain: string | undefined | null): string | null => {
  if (!shopDomain || typeof shopDomain !== 'string') {
    return null;
  }
  const trimmed = shopDomain.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SHOP_DOMAIN_LENGTH) {
    return null;
  }
  if (!trimmed.includes('.')) {
    return null;
  }
  return trimmed;
};

const isShopifyDomain = (hostname: string): boolean => {
  return typeof hostname === 'string' && hostname.includes(SHOPIFY_DOMAIN_SUFFIX);
};

function getAppBridge(): ShopifyAppBridge | null {
  if (!hasWindow()) {
    return null;
  }

  if (appBridgeInstance) {
    return appBridgeInstance;
  }

  if (hasShopify(window)) {
    const shopify = window.shopify;
    if (shopify) {
      appBridgeInstance = shopify;
      return shopify;
    }
  }

  return null;
}

export async function waitForAppBridge(): Promise<ShopifyAppBridge | null> {
  const appBridge = getAppBridge();
  if (appBridge?.ready) {
    try {
      await appBridge.ready;
      return appBridge;
    } catch {
      return appBridge;
    }
  }

  return new Promise<ShopifyAppBridge | null>((resolve) => {
    let checkIntervalId: ReturnType<typeof setInterval> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (checkIntervalId !== null) {
        clearInterval(checkIntervalId);
        checkIntervalId = null;
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    checkIntervalId = setInterval(() => {
      const bridge = getAppBridge();
      if (bridge) {
        cleanup();
        if (bridge.ready) {
          bridge.ready
            .then(() => {
              resolve(bridge);
            })
            .catch(() => {
              resolve(bridge);
            });
        } else {
          resolve(bridge);
        }
      }
    }, POLL_INTERVAL_MS);

    timeoutId = setTimeout(() => {
      cleanup();
      resolve(getAppBridge());
    }, WAIT_TIMEOUT_MS);
  });
}

export async function navigate(path: string): Promise<void> {
  const validatedPath = validatePath(path);
  if (!validatedPath) {
    throw new Error('Invalid path');
  }

  if (!hasWindow()) {
    throw new Error('Window is not available');
  }

  try {
    const appBridge = await waitForAppBridge();
    if (appBridge?.app?.navigate && typeof appBridge.app.navigate === 'function') {
      appBridge.app.navigate(validatedPath);
      return;
    }

    if (appBridge?.intents?.navigate && typeof appBridge.intents.navigate === 'function') {
      appBridge.intents.navigate(validatedPath);
      return;
    }
  } catch {
  }

  try {
    window.location.href = validatedPath;
  } catch {
    throw new Error('Failed to navigate');
  }
}

export function isEmbedded(): boolean {
  const appBridge = getAppBridge();
  if (!appBridge?.environment) {
    return false;
  }
  return appBridge.environment.embedded === true;
}

function getShopFromAppBridge(): string | null {
  if (!hasWindow()) {
    return null;
  }

  if (hasShopify(window)) {
    const shopify = window.shopify;
    if (shopify?.config?.shop) {
      const validated = validateShopDomain(shopify.config.shop);
      if (validated) {
        return validated;
      }
    }
  }

  return null;
}

function getShopFromUrl(): string | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    const urlParams = new URLSearchParams(window.location.search);
    const shop = urlParams.get(URL_PARAM_SHOP);
    if (shop) {
      const validated = validateShopDomain(shop);
      if (validated) {
        return validated;
      }
    }
  } catch {
  }

  return null;
}

function getShopFromHostname(): string | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    const hostname = window.location.hostname;
    if (isShopifyDomain(hostname)) {
      const validated = validateShopDomain(hostname);
      if (validated) {
        return validated;
      }
    }
  } catch {
  }

  return null;
}

const isDevMode = (): boolean => {
  try {
    const meta = import.meta as ImportMeta;
    return meta.env?.DEV === true;
  } catch {
    return false;
  }
};

export function getShopDomain(): string | null {
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

  if (isDevMode()) {
    return DEV_SHOP_DOMAIN;
  }

  return null;
}
