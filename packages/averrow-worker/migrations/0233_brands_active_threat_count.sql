-- 0233_brands_active_threat_count.sql
-- Pre-computed active-threat counter on brands.
--
-- Two hot-path aggregates were scanning the threats table on every
-- request to derive per-brand active-threat counts:
--   * handlers/tenantData.ts (handleTenantDashboard) — a global unbounded
--     LEFT JOIN over a `GROUP BY target_brand_id` subquery on EVERY tenant
--     dashboard load.
--   * handlers/emailSecurity.ts (handleEmailSecurityStats) — a correlated
--     `(SELECT COUNT(*) ... status='active')` per worst-protected brand row.
--
-- brands.threat_count already exists but is a TOTAL (all statuses), so it
-- can't answer "active only". This adds an active-only sibling maintained
-- the same disciplined way as hosting_providers.active_threat_count:
-- change-guarded whole-table sync (lib/brand-active-counts.ts) + drift
-- reconciler (lib/brand-count-reconciler.ts, cube_healer 6-hourly).
--
-- Never DROP/ALTER existing columns — additive ADD COLUMN only.

ALTER TABLE brands ADD COLUMN active_threat_count INTEGER NOT NULL DEFAULT 0;

-- Backfill so existing rows aren't stuck at the DEFAULT 0. Only touch
-- brands that actually have linked active threats; every other brand is
-- already correct at DEFAULT 0, so we don't rewrite the whole 9.6K-row
-- catalog. Index-driven via idx_threats_brand_status.
UPDATE brands
   SET active_threat_count = (
     SELECT COUNT(*) FROM threats
      WHERE threats.target_brand_id = brands.id
        AND threats.status = 'active'
   )
 WHERE brands.id IN (
   SELECT DISTINCT target_brand_id FROM threats
    WHERE status = 'active' AND target_brand_id IS NOT NULL
 );
