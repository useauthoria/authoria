-- Remove Authority plan from plan_limits table
-- This migration removes the authority plan as it's no longer offered

-- Delete authority plan from plan_limits
DELETE FROM plan_limits WHERE plan_name = 'authority';

-- Update any stores that have authority plan to publisher plan
-- (You may want to handle this differently based on your business logic)
UPDATE stores 
SET plan_id = (SELECT id FROM plan_limits WHERE plan_name = 'publisher' LIMIT 1)
WHERE plan_id IN (SELECT id FROM plan_limits WHERE plan_name = 'authority');

-- Note: If you have active subscriptions, you may need to handle those separately
-- through Shopify billing API or manual intervention

