-- Backfill organizations.plan_id from the legacy `plan` column.
--
-- PR #1255 wired the staff Plan dropdown to write both columns; orgs
-- created before that have `plan` set but `plan_id` NULL. The Stripe
-- webhook also keeps these in sync going forward, but offline /
-- enterprise customers without a subscription stay null.
--
-- pricing_plans.id values match the plan strings ('professional',
-- 'business', 'enterprise'). 'free' has no row by design and stays
-- NULL — that's the correct entitlement state for a free org and
-- syncOrgModulesToPlan suspends everything when plan_id is null.
UPDATE organizations
SET plan_id = plan
WHERE plan_id IS NULL
  AND plan IN ('professional', 'business', 'enterprise');

-- org_modules sync isn't expressible in pure SQL — it depends on
-- pricing_plans.included_modules JSON parsing. After this migration
-- ships, run POST /api/admin/orgs/sync-all-plan-modules (added in
-- this PR) once to align org_modules rows with the newly populated
-- plan_id values. Idempotent.
