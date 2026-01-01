-- Create plan management tables for trial initialization locking and audit
-- These tables are required by the PlanTrialManager class

-- Create plan_operation_locks table for distributed locking
CREATE TABLE IF NOT EXISTS plan_operation_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  operation VARCHAR(100) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  correlation_id VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(store_id, operation)
);

-- Create index for efficient lock queries
CREATE INDEX IF NOT EXISTS idx_plan_operation_locks_store_op ON plan_operation_locks(store_id, operation);
CREATE INDEX IF NOT EXISTS idx_plan_operation_locks_expires ON plan_operation_locks(expires_at);

-- Create plan_audit_log table for audit trail
CREATE TABLE IF NOT EXISTS plan_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL,
  details JSONB DEFAULT '{}',
  correlation_id VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create index for audit log queries
CREATE INDEX IF NOT EXISTS idx_plan_audit_log_store ON plan_audit_log(store_id);
CREATE INDEX IF NOT EXISTS idx_plan_audit_log_action ON plan_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_plan_audit_log_created ON plan_audit_log(created_at DESC);

-- Enable RLS
ALTER TABLE plan_operation_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_audit_log ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for service role access
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'plan_operation_locks' 
    AND policyname = 'Service role access locks'
  ) THEN
    CREATE POLICY "Service role access locks" ON plan_operation_locks 
      FOR ALL 
      TO service_role 
      USING (true) 
      WITH CHECK (true);
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'plan_audit_log' 
    AND policyname = 'Service role access audit'
  ) THEN
    CREATE POLICY "Service role access audit" ON plan_audit_log 
      FOR ALL 
      TO service_role 
      USING (true) 
      WITH CHECK (true);
  END IF;
END $$;

-- Comment on tables
COMMENT ON TABLE plan_operation_locks IS 'Distributed locking for plan and trial operations to prevent race conditions';
COMMENT ON TABLE plan_audit_log IS 'Audit trail for plan and trial changes for compliance and debugging';

