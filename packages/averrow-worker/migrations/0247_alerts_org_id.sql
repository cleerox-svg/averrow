-- 0247: Add an org-ownership column to alerts — closes the view-layer
--       cross-org executive-PII leak (EXEC_IMPERSONATION Stage 4, appsec FIX 3).
--
-- The tenant alert reads scope by `org_brands.org_id = ? AND brand_id`, with
-- NO user_id / org_id predicate. A brand is many-to-many with orgs, so any
-- co-monitoring org sees every alert on a shared brand — including
-- `executive_impersonation` alerts, whose title/summary embed a named
-- executive's full name (PII belonging to ONE org).
--
-- Fix (appsec Option a): tag org-private alerts with their owning org and
-- filter the brand-scoped tenant paths by it. This migration adds the
-- column; the read predicate (`a.org_id IS NULL OR a.org_id = ?`) is added
-- in the handlers.
--
-- ADDITIVE, LOW-RISK: a plain ADD COLUMN — NOT the temp-table CHECK-recreate
-- pattern migrations 0121/0192/0245 used (those had to rewrite the
-- alert_type CHECK; this only appends a nullable column). `alerts` has no
-- foreign keys and no triggers, so ADD COLUMN is safe in place.
--
--   * NULLABLE, NO default, NO FK, NO backfill. Every existing row — and
--     every future NON-exec alert (phishing / threat-feed / campaign / …) —
--     stays org_id = NULL BY DESIGN. The read predicate's `IS NULL` branch
--     keeps those brand-wide alerts visible to ALL co-monitoring orgs, so
--     their visibility is unchanged. Only alerts explicitly stamped with an
--     org_id (currently just executive_impersonation) become org-private.
ALTER TABLE alerts ADD COLUMN org_id INTEGER;

-- Partial index: the read predicate only ever needs to match non-NULL
-- org_id rows (the NULL branch is a table-wide OR), so index just those.
CREATE INDEX IF NOT EXISTS idx_alerts_org ON alerts(org_id) WHERE org_id IS NOT NULL;
