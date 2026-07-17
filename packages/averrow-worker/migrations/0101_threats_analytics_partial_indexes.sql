-- Phase 3 of D1 read cost reduction — partial indexes for the analytic
-- aggregations that surfaced once the malicious_domain scans (PRs #783 /
-- #784) were eliminated.
--
-- Top queries remaining after PR #784 (D1 insights, 30-min window):
--
--   A. SELECT COUNT(DISTINCT target_brand_id) … WHERE first_seen >= -24h
--        AND target_brand_id IS NOT NULL AND status = 'active'
--      45.68% of DB time, ~73K rows/exec
--      source: flightControl.ts:572 (backlog.analyst counter)
--      Cache exists (TTL 3900s from PR #782) but cache-miss recomputes
--      full-scan the table. Partial index makes the recompute path cheap
--      so misses don't punish us.
--
--   B. SELECT target_brand_id, COUNT(*) WHERE status='active' AND gsb_flagged=1
--        AND target_brand_id IS NOT NULL GROUP BY target_brand_id
--      4.54%, ~86K rows/exec
--      source: analyst.ts brand analytics
--
--   C. SELECT target_brand_id, SUM(CASE WHEN seclookup_risk_score >= 80 …)
--        WHERE status='active' AND seclookup_checked=1 AND target_brand_id IS NOT NULL
--      2.43%, ~86K rows/exec
--      source: analyst.ts brand analytics
--
-- All three share the same access pattern — aggregate by target_brand_id
-- over a subset of active threats matching a boolean flag. A partial
-- covering index per pattern makes the aggregation index-only: no table
-- lookups, scan only the rows matching the predicate.
--
-- Partial WHERE predicates must be deterministic, so we cannot include
-- `first_seen >= datetime('now', '-24h')` in the partial predicate for
-- index A. Instead we lead the index with `first_seen` so the planner
-- can range-scan the recent window efficiently.

-- ─── A. Flight Control analyst backlog ──────────────────────────────
-- Covers: COUNT(DISTINCT target_brand_id) FROM threats
--         WHERE first_seen >= ? AND status='active' AND target_brand_id IS NOT NULL
-- Leading column first_seen enables range scan; target_brand_id second so
-- the DISTINCT can deduplicate without a hash.
CREATE INDEX IF NOT EXISTS idx_threats_analyst_backlog
  ON threats(first_seen DESC, target_brand_id)
  WHERE status = 'active'
    AND target_brand_id IS NOT NULL;

-- ─── B. GSB-flagged threats grouped by brand ────────────────────────
CREATE INDEX IF NOT EXISTS idx_threats_gsb_flagged_brand
  ON threats(target_brand_id)
  WHERE status = 'active'
    AND gsb_flagged = 1
    AND target_brand_id IS NOT NULL;

-- ─── C. SecLookup-scored threats grouped by brand ───────────────────
CREATE INDEX IF NOT EXISTS idx_threats_seclookup_brand
  ON threats(target_brand_id, seclookup_risk_score)
  WHERE status = 'active'
    AND seclookup_checked = 1
    AND target_brand_id IS NOT NULL;

-- Refresh statistics so the planner picks the new indexes.
ANALYZE threats;
