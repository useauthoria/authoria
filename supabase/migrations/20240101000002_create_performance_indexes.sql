-- Performance optimization indexes
-- This migration creates indexes on commonly queried fields to improve query performance

-- Indexes for stores table
-- shop_domain is frequently used for lookups during OAuth and API calls
CREATE INDEX IF NOT EXISTS idx_stores_shop_domain ON stores(shop_domain);

-- Index for filtering active stores
CREATE INDEX IF NOT EXISTS idx_stores_is_active ON stores(is_active) WHERE is_active = true;

-- Composite index for store lookups with plan_id
CREATE INDEX IF NOT EXISTS idx_stores_plan_id ON stores(plan_id) WHERE plan_id IS NOT NULL;

-- Indexes for blog_posts table
-- store_id is used in almost every query to filter posts by store
CREATE INDEX IF NOT EXISTS idx_blog_posts_store_id ON blog_posts(store_id);

-- created_at is used for ordering posts by creation date (most common sort)
CREATE INDEX IF NOT EXISTS idx_blog_posts_created_at ON blog_posts(created_at DESC);

-- Composite index for common query pattern: filter by store and status, order by created_at
CREATE INDEX IF NOT EXISTS idx_blog_posts_store_status_created ON blog_posts(store_id, status, created_at DESC);

-- Index for filtering by status (often used with store_id)
CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status);

-- Index for scheduled posts lookup (if auto_publish_at column exists)
CREATE INDEX IF NOT EXISTS idx_blog_posts_auto_publish_at ON blog_posts(auto_publish_at) WHERE auto_publish_at IS NOT NULL;

-- Indexes for oauth_sessions table
-- state is used for OAuth callback validation
CREATE INDEX IF NOT EXISTS idx_oauth_sessions_state ON oauth_sessions(state);

-- shop_domain is used for session cleanup and lookups
CREATE INDEX IF NOT EXISTS idx_oauth_sessions_shop_domain ON oauth_sessions(shop_domain);

-- Composite index for common OAuth lookup pattern
CREATE INDEX IF NOT EXISTS idx_oauth_sessions_state_shop ON oauth_sessions(state, shop_domain);

-- Index for plan_limits table
-- plan_name is frequently queried to get plan details
CREATE INDEX IF NOT EXISTS idx_plan_limits_plan_name ON plan_limits(plan_name);

-- Indexes for performance_metrics table
-- store_id is used to filter metrics by store
CREATE INDEX IF NOT EXISTS idx_performance_metrics_store_id ON performance_metrics(store_id);

-- post_id is used for joining with blog_posts
CREATE INDEX IF NOT EXISTS idx_performance_metrics_post_id ON performance_metrics(post_id);

-- metric_date is used for date range filtering
CREATE INDEX IF NOT EXISTS idx_performance_metrics_metric_date ON performance_metrics(metric_date DESC);

-- Composite index for common analytics query pattern: filter by store and date range, order by clicks
CREATE INDEX IF NOT EXISTS idx_performance_metrics_store_date_clicks ON performance_metrics(store_id, metric_date DESC, clicks DESC);

-- Composite index for store_id and post_id lookups
CREATE INDEX IF NOT EXISTS idx_performance_metrics_store_post ON performance_metrics(store_id, post_id);

-- Indexes for posts_schedule table (if exists)
-- scheduled_at is used to find posts ready to publish
CREATE INDEX IF NOT EXISTS idx_posts_schedule_scheduled_at ON posts_schedule(scheduled_at) WHERE scheduled_at IS NOT NULL;

-- store_id for filtering scheduled posts by store
CREATE INDEX IF NOT EXISTS idx_posts_schedule_store_id ON posts_schedule(store_id);

-- Composite index for scheduled posts lookup
CREATE INDEX IF NOT EXISTS idx_posts_schedule_store_scheduled ON posts_schedule(store_id, scheduled_at) WHERE scheduled_at IS NOT NULL;

