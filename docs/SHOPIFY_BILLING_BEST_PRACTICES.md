# Shopify Billing API Best Practices

This document outlines how the application implements Shopify's Billing API best practices.

## Overview

The application follows Shopify's recommended practices for app billing, including:
- Using Shopify's GraphQL Admin API for billing operations
- Supporting managed pricing through Partner Dashboard
- Proper webhook handling for subscription updates
- Currency-aware billing (merchant's local currency)
- Free trial support
- Subscription status verification

## Key Components

### 1. ShopifyBilling Class (`backend/src/integrations/ShopifyBilling.ts`)

Provides a clean interface to Shopify's Billing API:

- **`getBillingPreferences()`**: Gets merchant's local billing currency
- **`checkActiveSubscription()`**: Verifies subscription status
- **`createSubscription()`**: Creates subscription with proper confirmation flow
- **`cancelSubscription()`**: Handles subscription cancellation with proration
- **`getPlanSelectionUrl()`**: Returns Shopify's hosted plan selection page URL

### 2. Webhook Handler (`supabase/functions/shopify-webhook/index.ts`)

Handles `APP_SUBSCRIPTIONS_UPDATE` webhooks:

- Verifies subscription status changes
- Updates store plan automatically
- Uses enterprise-grade plan transition manager
- Comprehensive error handling and logging

### 3. Frontend Hooks (`frontend/src/hooks/useShopifyBilling.ts`)

React hooks for billing operations:

- **`useShopifyBilling()`**: Checks subscription status
- **`useRequirePayment()`**: Gates routes requiring active payment
- Automatic redirect to plan selection page

## Best Practices Implemented

### ✅ Use Merchant's Local Currency

```typescript
const billingPreferences = await shopifyBilling.getBillingPreferences();
// Returns merchant's currencyCode (e.g., 'USD', 'EUR', 'CAD')
```

**Benefit**: Merchants can budget in their local currency, reducing confusion.

### ✅ Verify Subscription Status

Always verify subscription status with Shopify API before allowing access:

```typescript
const subscriptionCheck = await shopifyBilling.checkActiveSubscription();
if (!subscriptionCheck.hasActivePayment) {
  // Redirect to plan selection
}
```

**Benefit**: Prevents unauthorized access and ensures data consistency.

### ✅ Handle Webhooks Properly

The webhook handler:
- Verifies webhook signatures (in production)
- Handles subscription status changes
- Updates store plan atomically
- Logs all operations for audit

**Benefit**: Real-time synchronization with Shopify's billing system.

### ✅ Redirect to Plan Selection Page

For managed pricing, redirect to Shopify's hosted page:

```typescript
const url = `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
```

**Benefit**: Consistent UX and reduced maintenance burden.

### ✅ Support Free Trials

Free trials are handled through:
- Shopify's trial system (for managed pricing)
- Custom trial logic (for manual pricing)
- Grace periods after trial expiration

**Benefit**: Better conversion rates and user experience.

### ✅ Atomic Plan Transitions

All plan transitions use the enterprise-grade `PlanTrialManager`:
- Distributed locking prevents race conditions
- Atomic database updates
- Comprehensive audit logging

**Benefit**: Data integrity and reliability.

## Usage Examples

### Check Subscription Status (Backend)

```typescript
const shopifyBilling = new ShopifyBilling(supabase, shopDomain, accessToken);
const status = await shopifyBilling.checkActiveSubscription();

if (status.hasActivePayment) {
  // Allow access
} else {
  // Redirect to plan selection
}
```

### Gate a Route (Frontend)

```typescript
function ProtectedRoute() {
  const { hasActivePayment, isLoading } = useRequirePayment('your-app-handle');
  
  if (isLoading) return <Loading />;
  if (!hasActivePayment) return <RedirectToPlans />;
  
  return <ProtectedContent />;
}
```

### Handle Subscription Update (Webhook)

The webhook handler automatically:
1. Receives `APP_SUBSCRIPTIONS_UPDATE` webhook
2. Verifies subscription status
3. Updates store plan using `PlanTrialManager`
4. Logs the operation

## Managed Pricing vs Manual Pricing

### Managed Pricing (Recommended)

- Plans defined in Partner Dashboard
- Shopify hosts plan selection page
- Automatic proration and trial handling
- Less code to maintain

### Manual Pricing

- Plans created via Billing API
- Custom plan selection UI
- More control, more complexity
- Requires handling proration manually

## Currency Support

The app supports all [Shopify-supported currencies](https://help.shopify.com/manual/your-account/manage-billing/your-invoice/local-currency):

- Automatically detects merchant's currency
- Uses currency for all charges
- Formats prices correctly for display

## Testing

For development stores, Shopify provides free test subscriptions:
- No charges for test subscriptions
- Test subscriptions don't convert to paid
- Use for development and testing

## Security

- Webhook signature verification (in production)
- Subscription status verification
- Atomic plan transitions
- Comprehensive audit logging

## Monitoring

Monitor the following:
- Webhook delivery success rate
- Subscription status check failures
- Plan transition errors
- Currency detection failures

## Next Steps

1. Set up managed pricing in Partner Dashboard
2. Configure webhook endpoint in Shopify
3. Test subscription flow in development store
4. Monitor webhook delivery and errors
5. Set up alerts for billing failures

