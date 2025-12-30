-- Enterprise-grade Plan and Trial Management Tables
-- Provides distributed locking and comprehensive audit logging

-- Plan operation locks table for distributed locking
CREATE TABLE IF NOT EXISTS plan_operation_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(store_id, operation)
);

-- Index for efficient lock cleanup
CREATE INDEX IF NOT EXISTS idx_plan_operation_locks_expires_at 
  ON plan_operation_locks(expires_at);

CREATE INDEX IF NOT EXISTS idx_plan_operation_locks_store_operation 
  ON plan_operation_locks(store_id, operation);

-- Plan audit log table for comprehensive tracking
CREATE TABLE IF NOT EXISTS plan_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient audit log queries
CREATE INDEX IF NOT EXISTS idx_plan_audit_log_store_id 
  ON plan_audit_log(store_id);

CREATE INDEX IF NOT EXISTS idx_plan_audit_log_event_type 
  ON plan_audit_log(event_type);

CREATE INDEX IF NOT EXISTS idx_plan_audit_log_created_at 
  ON plan_audit_log(created_at DESC);

-- Add grace_period_ends_at column to stores table if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'stores' AND column_name = 'grace_period_ends_at'
  ) THEN
    ALTER TABLE stores ADD COLUMN grace_period_ends_at TIMESTAMPTZ;
  END IF;
END $$;

-- Function to clean up expired locks (should be called periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_locks()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM plan_operation_locks
  WHERE expires_at < NOW();
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Function to get store plan status with comprehensive information
CREATE OR REPLACE FUNCTION get_store_plan_status_comprehensive(p_store_id UUID)
RETURNS TABLE (
  store_id UUID,
  plan_id UUID,
  plan_name TEXT,
  subscription_id UUID,
  is_active BOOLEAN,
  is_paused BOOLEAN,
  trial_started_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  grace_period_ends_at TIMESTAMPTZ,
  articles_used INTEGER,
  articles_allowed INTEGER,
  articles_remaining INTEGER,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    s.id AS store_id,
    s.plan_id,
    pl.plan_name,
    s.subscription_id,
    s.is_active,
    s.is_paused,
    s.trial_started_at,
    s.trial_ends_at,
    s.grace_period_ends_at,
    COALESCE(qs.articles_used, 0)::INTEGER AS articles_used,
    COALESCE(qs.articles_allowed, 0)::INTEGER AS articles_allowed,
    COALESCE(qs.articles_remaining, 0)::INTEGER AS articles_remaining,
    COALESCE(qs.period_start, NOW())::TIMESTAMPTZ AS period_start,
    COALESCE(qs.period_end, NOW())::TIMESTAMPTZ AS period_end
  FROM stores s
  LEFT JOIN plan_limits pl ON s.plan_id = pl.id
  LEFT JOIN LATERAL (
    SELECT * FROM get_store_quota_status(s.id)
  ) qs ON true
  WHERE s.id = p_store_id;
END;
$$;

-- RLS policies for plan_operation_locks
ALTER TABLE plan_operation_locks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage locks"
  ON plan_operation_locks
  FOR ALL
  USING (auth.role() = 'service_role');

-- RLS policies for plan_audit_log
ALTER TABLE plan_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage audit logs"
  ON plan_audit_log
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Stores can read their own audit logs"
  ON plan_audit_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM stores
      WHERE stores.id = plan_audit_log.store_id
      AND stores.shop_domain = current_setting('app.shop_domain', true)
    )
  );

