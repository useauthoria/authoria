/**
 * Frontend utilities for Shopify Billing API
 * Provides helpers for checking subscription status and redirecting to plan selection
 */

import { getShopDomain } from '../lib/app-bridge';

/**
 * Get plan selection page URL for managed pricing
 * Best Practice: Use Shopify's hosted plan selection page
 */
export function getPlanSelectionUrl(appHandle: string): string {
  try {
    const shopDomain = getShopDomain();
    const storeHandle = shopDomain.replace('.myshopify.com', '');
    return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
  } catch {
    // Fallback if shop domain can't be determined
    return '/settings?billing=required';
  }
}

/**
 * Redirect to plan selection page
 * Best Practice: Use target="_top" for external URLs in embedded apps
 */
export function redirectToPlanSelection(appHandle: string): void {
  const url = getPlanSelectionUrl(appHandle);
  // In embedded app, use window.top to navigate outside iframe
  if (window.top && window.top !== window.self) {
    window.top.location.href = url;
  } else {
    window.location.href = url;
  }
}

/**
 * Check if subscription status indicates active payment
 */
export function hasActivePayment(status: string): boolean {
  return status === 'ACTIVE' || status === 'PENDING';
}

/**
 * Format currency for display
 */
export function formatCurrency(amount: number, currencyCode: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
  }).format(amount);
}

