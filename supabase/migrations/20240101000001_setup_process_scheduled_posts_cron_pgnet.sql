-- Alternative approach using pg_net extension for HTTP requests
-- This is more suitable for Supabase Edge Functions

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant necessary permissions
GRANT USAGE ON SCHEMA net TO postgres;
GRANT USAGE ON SCHEMA cron TO postgres;

-- Function to call process-scheduled-posts Edge Function
CREATE OR REPLACE FUNCTION cron.process_scheduled_posts_via_http()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  response_id bigint;
  supabase_url text;
  service_role_key text;
  function_url text;
BEGIN
  -- Get configuration from environment variables or settings table
  -- In Supabase, these are typically available via secrets or env vars
  supabase_url := COALESCE(
    current_setting('app.settings.supabase_url', true),
    'http://127.0.0.1:54321'  -- Default for local development
  );
  
  service_role_key := current_setting('app.settings.service_role_key', true);
  
  -- Construct the Edge Function URL
  function_url := supabase_url || '/functions/v1/process-scheduled-posts';
  
  -- Make HTTP POST request to the Edge Function
  -- pg_net.http_post returns a request ID that can be used to check status
  SELECT net.http_post(
    url := function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || COALESCE(service_role_key, '')
    )::jsonb,
    body := '{}'::jsonb
  ) INTO response_id;
  
  -- Log the request (optional)
  RAISE NOTICE 'Submitted HTTP request to process-scheduled-posts, request_id: %', response_id;
  
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail - cron will retry on next run
    RAISE WARNING 'Error calling process-scheduled-posts Edge Function: %', SQLERRM;
END;
$$;

-- Schedule cron job to run every 5 minutes
-- Cron syntax: minute hour day-of-month month day-of-week
-- '*/5 * * * *' means: every 5 minutes
SELECT cron.schedule(
  'process-scheduled-posts-every-5min',
  '*/5 * * * *',
  $$SELECT cron.process_scheduled_posts_via_http()$$
);

-- Comments for maintenance:
-- 
-- To view scheduled cron jobs:
-- SELECT * FROM cron.job;
--
-- To view cron job run history:
-- SELECT * FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'process-scheduled-posts-every-5min');
--
-- To unschedule the job:
-- SELECT cron.unschedule('process-scheduled-posts-every-5min');
--
-- To change schedule (e.g., every 1 minute):
-- SELECT cron.unschedule('process-scheduled-posts-every-5min');
-- SELECT cron.schedule('process-scheduled-posts-every-1min', '* * * * *', $$SELECT cron.process_scheduled_posts_via_http()$$);

