# Enterprise-Grade Plan & Trial Management System

## Overview

This document describes the enterprise-grade plan and trial management system designed to handle high-concurrency scenarios with bulletproof reliability.

## Key Features

### 1. **Distributed Locking**
- Prevents race conditions in quota checks and plan updates
- Uses database-backed locks with automatic expiration
- Ensures only one operation per store at a time
- Lock timeout: 30 seconds (configurable)

### 2. **Atomic Operations**
- All plan transitions are atomic
- Trial initialization is transactional
- Quota enforcement uses locks to prevent double-counting
- Rollback support for failed operations

### 3. **Trial Management**
- **Grace Period**: 3-day grace period after trial expiration
- **Smart Initialization**: Only initializes trial when appropriate
- **Expiration Handling**: Automatic store pausing after grace period
- **Prevention of Reset**: Active trials are never reset accidentally

### 4. **Comprehensive Validation**
- Plan transition validation
- Store state validation
- Quota boundary checking
- Trial status validation

### 5. **Audit Logging**
- All plan/trial operations are logged
- Includes correlation IDs for tracing
- Metadata stored for debugging
- Queryable audit trail

### 6. **Quota Period Management**
- Handles monthly/weekly rollovers correctly
- Prevents quota bypass at period boundaries
- Accurate usage tracking

## Architecture

### Core Components

#### `PlanTrialManager`
The main enterprise-grade manager class that handles:
- Quota enforcement with locking
- Trial initialization and management
- Plan transitions
- Grace period handling

#### Database Tables

1. **`plan_operation_locks`**
   - Stores distributed locks
   - Auto-expires after timeout
   - Prevents concurrent operations

2. **`plan_audit_log`**
   - Comprehensive audit trail
   - All plan/trial operations logged
   - Includes metadata and correlation IDs

3. **`stores.grace_period_ends_at`**
   - Tracks grace period expiration
   - Used for trial expiration handling

## Usage Examples

### Quota Enforcement

```typescript
const planTrialManager = new PlanTrialManager(supabase);
const result = await planTrialManager.enforceQuotaWithLock(
  storeId,
  'create_article',
  correlationId,
);

if (!result.allowed) {
  // Handle quota exceeded
  return error(result.reason);
}
```

### Trial Initialization

```typescript
const result = await planTrialManager.initializeTrial(
  storeId,
  14, // trial days
  correlationId,
  false, // force reset
);

if (result.success) {
  // Trial initialized
  console.log('Trial status:', result.trialStatus);
}
```

### Plan Transition

```typescript
const result = await planTrialManager.transitionPlan(
  storeId,
  {
    fromPlanId: oldPlanId,
    toPlanId: newPlanId,
    reason: 'upgrade',
    subscriptionId: subscriptionId,
    metadata: { /* additional data */ },
  },
  correlationId,
);
```

## Race Condition Prevention

### Problem
Multiple concurrent requests could:
- Bypass quota checks
- Create duplicate articles
- Reset trial dates incorrectly
- Cause quota overruns

### Solution
1. **Distributed Locks**: Each quota check acquires a lock
2. **Atomic Updates**: All plan/trial updates are atomic
3. **Lock Timeout**: Locks expire after 30 seconds
4. **Lock Cleanup**: Periodic cleanup job removes expired locks

## Trial Expiration Flow

1. **Trial Active**: Store can use quota normally
2. **Trial Expires**: Trial ends, grace period starts (3 days)
3. **Grace Period**: Store can still use quota but warned
4. **Grace Expires**: Store is paused, must upgrade

## Plan Transition Flow

1. **Validation**: Validate transition is allowed
2. **Acquire Lock**: Prevent concurrent transitions
3. **Update Store**: Atomic update of plan and related fields
4. **Sync Limits**: Update quota limits
5. **Audit Log**: Record transition
6. **Release Lock**: Free the lock

## Error Handling

All operations include:
- Comprehensive error messages
- Rollback on failure
- Audit logging of errors
- Correlation IDs for tracing

## Monitoring & Maintenance

### Cleanup Job
Run periodically to clean expired locks:
```bash
POST /functions/v1/cleanup-plan-locks
```

### Audit Log Queries
```sql
-- Get all plan transitions for a store
SELECT * FROM plan_audit_log
WHERE store_id = '...'
AND event_type = 'plan_transitioned'
ORDER BY created_at DESC;

-- Get all trial initializations
SELECT * FROM plan_audit_log
WHERE event_type = 'trial_initialized'
ORDER BY created_at DESC;
```

## Best Practices

1. **Always use correlation IDs** for tracing
2. **Handle lock acquisition failures** gracefully
3. **Monitor audit logs** for suspicious activity
4. **Run cleanup job** regularly (daily recommended)
5. **Validate before transitioning** plans
6. **Use grace periods** for better UX

## Security Considerations

1. **RLS Policies**: All tables have proper RLS
2. **Service Role**: Lock operations use service role
3. **Validation**: All inputs are validated
4. **Audit Trail**: All operations are logged
5. **Lock Expiration**: Prevents permanent locks

## Performance

- **Lock Timeout**: 30 seconds (prevents deadlocks)
- **Indexed Queries**: All queries are optimized
- **Minimal Lock Duration**: Locks released immediately after operation
- **Async Operations**: Non-blocking where possible

## Migration Notes

1. Run migration: `20240101000010_create_plan_trial_enterprise_tables.sql`
2. Update all quota checks to use `PlanTrialManager`
3. Update plan transitions to use `transitionPlan()`
4. Set up cleanup job cron schedule
5. Monitor audit logs for issues

## Troubleshooting

### Lock Not Released
- Check cleanup job is running
- Verify lock expiration time
- Check for errors in operation

### Trial Not Initializing
- Check store has no active subscription
- Verify free_trial plan exists
- Check audit logs for errors

### Quota Bypass
- Verify locks are being acquired
- Check quota enforcement is called
- Review audit logs for suspicious activity

