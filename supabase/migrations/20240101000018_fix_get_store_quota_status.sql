-- Fix get_store_quota_status function
-- 1. Use correct column names from plan_limits table (article_limit_weekly, article_limit_monthly)
-- 2. Rename parameter to p_store_uuid to avoid ambiguity with return table column
-- 3. Fully qualify all column references to avoid ambiguity

DROP FUNCTION IF EXISTS get_store_quota_status(UUID);

CREATE FUNCTION get_store_quota_status(p_store_uuid UUID)
RETURNS TABLE (
  store_id UUID,
  plan_name TEXT,
  articles_generated_today INTEGER,
  articles_published_today INTEGER,
  daily_limit INTEGER,
  monthly_limit INTEGER,
  articles_generated_this_month INTEGER,
  articles_published_this_month INTEGER,
  remaining_daily INTEGER,
  remaining_monthly INTEGER,
  trial_ends_at TIMESTAMPTZ,
  is_trial_active BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_store_id UUID;
  v_plan_name TEXT;
  v_weekly_limit INTEGER;
  v_monthly_limit INTEGER;
  v_trial_ends_at TIMESTAMPTZ;
  v_today DATE := CURRENT_DATE;
  v_month_start DATE := DATE_TRUNC('month', CURRENT_DATE)::DATE;
BEGIN
  -- Get store and plan information
  SELECT 
    s.id,
    COALESCE(pl.plan_name, 'free_trial')::TEXT,
    COALESCE(pl.article_limit_weekly, 3)::INTEGER,
    COALESCE(pl.article_limit_monthly, 0)::INTEGER,
    s.trial_ends_at
  INTO 
    v_store_id,
    v_plan_name,
    v_weekly_limit,
    v_monthly_limit,
    v_trial_ends_at
  FROM stores s
  LEFT JOIN plan_limits pl ON s.plan_id = pl.id
  WHERE s.id = p_store_uuid;
  
  IF v_store_id IS NULL THEN
    RETURN;
  END IF;
  
  -- Return quota data with fully qualified column names (au. prefix avoids ambiguity)
  RETURN QUERY
  SELECT 
    v_store_id AS store_id,
    v_plan_name AS plan_name,
    COALESCE(SUM(CASE WHEN au.usage_date = v_today AND au.usage_type = 'generated' THEN 1 ELSE 0 END), 0)::INTEGER,
    COALESCE(SUM(CASE WHEN au.usage_date = v_today AND au.usage_type = 'published' THEN 1 ELSE 0 END), 0)::INTEGER,
    v_weekly_limit,
    v_monthly_limit,
    COALESCE(SUM(CASE WHEN au.usage_date >= v_month_start AND au.usage_type = 'generated' THEN 1 ELSE 0 END), 0)::INTEGER,
    COALESCE(SUM(CASE WHEN au.usage_date >= v_month_start AND au.usage_type = 'published' THEN 1 ELSE 0 END), 0)::INTEGER,
    GREATEST(0, v_weekly_limit - COALESCE(SUM(CASE WHEN au.usage_date = v_today AND au.usage_type = 'generated' THEN 1 ELSE 0 END), 0))::INTEGER,
    GREATEST(0, v_monthly_limit - COALESCE(SUM(CASE WHEN au.usage_date >= v_month_start AND au.usage_type = 'generated' THEN 1 ELSE 0 END), 0))::INTEGER,
    v_trial_ends_at,
    (v_trial_ends_at IS NULL OR v_trial_ends_at > NOW())::BOOLEAN
  FROM article_usage au
  WHERE au.store_id = v_store_id
    AND (au.usage_date = v_today OR au.usage_date >= v_month_start)
  GROUP BY au.store_id;
  
  -- If no usage records exist, return zeros
  IF NOT FOUND THEN
    RETURN QUERY SELECT 
      v_store_id,
      v_plan_name,
      0::INTEGER,
      0::INTEGER,
      v_weekly_limit::INTEGER,
      v_monthly_limit::INTEGER,
      0::INTEGER,
      0::INTEGER,
      v_weekly_limit::INTEGER,
      v_monthly_limit::INTEGER,
      v_trial_ends_at,
      (v_trial_ends_at IS NULL OR v_trial_ends_at > NOW())::BOOLEAN;
  END IF;
END;
$$;

COMMENT ON FUNCTION get_store_quota_status(UUID) IS 
  'Get store quota status. Uses p_store_uuid parameter and au. table alias to avoid column ambiguity.';

