-- Fix get_store_quota_status function to use correct column names
-- The plan_limits table uses article_limit_monthly and article_limit_weekly
-- not monthly_article_limit and daily_article_limit

DROP FUNCTION IF EXISTS get_store_quota_status(UUID);

CREATE FUNCTION get_store_quota_status(store_uuid UUID)
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
  -- Get store and plan information (single query with join)
  SELECT 
    s.id,
    COALESCE(pl.plan_name, 'free_trial')::TEXT,
    COALESCE(pl.article_limit_weekly, 3)::INTEGER,  -- Use weekly limit as daily limit (approximation)
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
  WHERE s.id = store_uuid;
  
  IF v_store_id IS NULL THEN
    RETURN;
  END IF;
  
  -- Get usage counts in a single query (much faster than separate queries)
  RETURN QUERY
  SELECT 
    v_store_id,
    v_plan_name,
    COALESCE(SUM(CASE WHEN usage_date = v_today AND usage_type = 'generated' THEN 1 ELSE 0 END), 0)::INTEGER as articles_generated_today,
    COALESCE(SUM(CASE WHEN usage_date = v_today AND usage_type = 'published' THEN 1 ELSE 0 END), 0)::INTEGER as articles_published_today,
    v_weekly_limit as daily_limit,  -- Use weekly limit as daily approximation
    v_monthly_limit,
    COALESCE(SUM(CASE WHEN usage_date >= v_month_start AND usage_type = 'generated' THEN 1 ELSE 0 END), 0)::INTEGER as articles_generated_this_month,
    COALESCE(SUM(CASE WHEN usage_date >= v_month_start AND usage_type = 'published' THEN 1 ELSE 0 END), 0)::INTEGER as articles_published_this_month,
    GREATEST(0, v_weekly_limit - COALESCE(SUM(CASE WHEN usage_date = v_today AND usage_type = 'generated' THEN 1 ELSE 0 END), 0))::INTEGER as remaining_daily,
    GREATEST(0, v_monthly_limit - COALESCE(SUM(CASE WHEN usage_date >= v_month_start AND usage_type = 'generated' THEN 1 ELSE 0 END), 0))::INTEGER as remaining_monthly,
    v_trial_ends_at,
    (v_trial_ends_at IS NULL OR v_trial_ends_at > NOW())::BOOLEAN as is_trial_active
  FROM article_usage
  WHERE store_id = v_store_id
    AND (usage_date = v_today OR usage_date >= v_month_start)
  GROUP BY store_id;
  
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
  'Get store quota status with correct column names from plan_limits table. Uses article_limit_weekly and article_limit_monthly.';

