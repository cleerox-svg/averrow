-- 0195_threats_dns_strict_partial_index.sql
--
-- D1 spend reduction: tighter partial index for the cartographer DNS
-- backfill UPDATE path. The current `idx_threats_dns_backfill` covers
-- ~120K rows (all null-IP threats); each pre-stamp UPDATE reads ~110K
-- rows for a 50-domain IN() clause because the planner has to scan
-- across the partial-index region.
--
-- This stricter index narrows to ~60K rows by adding the two filters
-- the cartographer cares about:
--   - status = 'active'          → skip retired threats
--   - enrichment_attempts < 8    → skip exhausted ones
--
-- The companion code change in lib/dns-backfill.ts adds the matching
-- WHERE clauses to the pre-stamp UPDATEs so SQLite recognizes the
-- query as a subset of the index's predicate. Without that the index
-- can't be used (query becomes a superset → could match rows the
-- index doesn't cover → planner falls back to the wider partial index
-- or full scan).
--
-- Production audit 2026-05-16:
--   Query #1 (attempted_resolve_at UPDATE) = 173M rows/24h (29% of plan)
--   Query #3 (enrichment_attempts++ UPDATE) = 66M rows/24h (11%)
-- Estimated post-deploy savings: ~150M rows/24h (~18% of plan budget).

CREATE INDEX IF NOT EXISTS idx_threats_dns_pending_strict
  ON threats(malicious_domain)
  WHERE ip_address IS NULL
    AND status = 'active'
    AND COALESCE(enrichment_attempts, 0) < 8;
