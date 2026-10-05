-- Backfill takedown_requests.module_key from target_type (additive, idempotent).
--
-- Every send path (Sparrow Phase G auto-submit, staff mark-submitted, staff
-- hand-submit) refuses a takedown whose module_key is NULL — the key is what
-- the takedown_authorizations scope check runs against. Rows created before
-- migration 0152 added the column, and rows created by the customer route
-- (POST /api/orgs/:orgId/takedowns) and the ops bulk-takedown route
-- (POST /api/alerts/bulk-takedown) until this fix, were left NULL and so
-- could never be sent.
--
-- Mapping mirrors src/lib/takedown-module-key.ts
-- (TAKEDOWN_TARGET_TYPE_MODULE_KEYS); test/takedown-module-key.test.ts pins
-- the two together:
--   domain | url    → 'domain'
--   social_profile  → 'social'
--   mobile_app      → 'app_store'
--   paste           → 'dark_web'
-- Any other target_type (e.g. 'email') has no module and stays NULL.
--
-- Only NULL module_key rows are touched; re-running is a no-op.
UPDATE takedown_requests
   SET module_key = CASE target_type
         WHEN 'domain'         THEN 'domain'
         WHEN 'url'            THEN 'domain'
         WHEN 'social_profile' THEN 'social'
         WHEN 'mobile_app'     THEN 'app_store'
         WHEN 'paste'          THEN 'dark_web'
       END
 WHERE module_key IS NULL
   AND target_type IN ('domain', 'url', 'social_profile', 'mobile_app', 'paste');
