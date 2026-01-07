import { getShopDomain } from '../lib/app-bridge';

const SHOPIFY_DOMAIN_SUFFIX = '.myshopify.com' as const;
const ADMIN_BASE_URL = 'https://admin.shopify.com/store' as const;
const PRICING_PLANS_PATH = 'pricing_plans' as const;
const FALLBACK_BILLING_URL = '/settings?billing=required' as const;
const ACTIVE_STATUS = 'ACTIVE' as const;
const PENDING_STATUS = 'PENDING' as const;
const DEFAULT_LOCALE = 'en-US' as const;
const MIN_APP_HANDLE_LENGTH = 1;
const MAX_APP_HANDLE_LENGTH = 200;
const MIN_AMOUNT = 0;
const MAX_AMOUNT = 999999999.99;

function validateAppHandle(appHandle: string): string {
  if (!appHandle || typeof appHandle !== 'string') {
    throw new Error('App handle must be a non-empty string');
  }
  const trimmed = appHandle.trim();
  if (trimmed.length < MIN_APP_HANDLE_LENGTH || trimmed.length > MAX_APP_HANDLE_LENGTH) {
    throw new Error(`App handle must be between ${MIN_APP_HANDLE_LENGTH} and ${MAX_APP_HANDLE_LENGTH} characters`);
  }
  return trimmed;
}

function validateCurrencyCode(currencyCode: string): string {
  if (!currencyCode || typeof currencyCode !== 'string') {
    throw new Error('Currency code must be a non-empty string');
  }
  const trimmed = currencyCode.trim().toUpperCase();
  if (trimmed.length !== 3) {
    throw new Error('Currency code must be a 3-letter ISO code');
  }
  return trimmed;
}

function validateAmount(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new Error('Amount must be a finite number');
  }
  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    throw new Error(`Amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT}`);
  }
  return amount;
}

function extractStoreHandle(shopDomain: string): string {
  if (!shopDomain || typeof shopDomain !== 'string') {
    throw new Error('Shop domain is required');
  }
  
  const trimmed = shopDomain.trim();
  if (!trimmed.endsWith(SHOPIFY_DOMAIN_SUFFIX)) {
    throw new Error('Invalid Shopify domain format');
  }
  
  const storeHandle = trimmed.replace(SHOPIFY_DOMAIN_SUFFIX, '');
  if (storeHandle.length === 0) {
    throw new Error('Store handle cannot be empty');
  }
  
  return storeHandle;
}

function buildPlanSelectionUrl(storeHandle: string, appHandle: string): string {
  const encodedStoreHandle = encodeURIComponent(storeHandle);
  const encodedAppHandle = encodeURIComponent(appHandle);
  return `${ADMIN_BASE_URL}/${encodedStoreHandle}/charges/${encodedAppHandle}/${PRICING_PLANS_PATH}`;
}

function isWindowAccessible(window: Window | null): window is Window {
  return window !== null && typeof window === 'object' && 'location' in window;
}

export function getPlanSelectionUrl(appHandle: string): string {
  try {
    const validatedAppHandle = validateAppHandle(appHandle);
    const shopDomain = getShopDomain();
    const storeHandle = extractStoreHandle(shopDomain);
    return buildPlanSelectionUrl(storeHandle, validatedAppHandle);
  } catch {
    return FALLBACK_BILLING_URL;
  }
}

export function redirectToPlanSelection(appHandle: string): void {
  const url = getPlanSelectionUrl(appHandle);
  
  if (typeof window === 'undefined') {
    return;
  }
  
  const targetWindow = window.top && window.top !== window.self ? window.top : window;
  
  if (isWindowAccessible(targetWindow)) {
    try {
      targetWindow.location.href = url;
    } catch {
      if (isWindowAccessible(window)) {
        window.location.href = url;
      }
    }
  }
}

export function hasActivePayment(status: string): boolean {
  if (!status || typeof status !== 'string') {
    return false;
  }
  const normalizedStatus = status.trim().toUpperCase();
  return normalizedStatus === ACTIVE_STATUS || normalizedStatus === PENDING_STATUS;
}

export function formatCurrency(amount: number, currencyCode: string): string {
  const validatedAmount = validateAmount(amount);
  const validatedCurrencyCode = validateCurrencyCode(currencyCode);
  
  try {
    return new Intl.NumberFormat(DEFAULT_LOCALE, {
      style: 'currency',
      currency: validatedCurrencyCode,
    }).format(validatedAmount);
  } catch {
    return `${validatedCurrencyCode} ${validatedAmount.toFixed(2)}`;
  }
}
