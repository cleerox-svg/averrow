-- Partial indexes for the two queries dominating D1 read cost.
--
-- Observed from Cloudflare D1 query insights (2026-04-22):
--
--   #1  UPDATE threats SET ip_address = ?, enriched_at = NULL
--       WHERE malicious_domain = ? AND (ip_address IS NULL OR ip_address = '')
--         AND status = 'active'
--       → 59.16% of DB time, 1,068 executions, 190.79M rows read
--       → ~179K rows/execution = full-table scan despite idx_threats_domain
--
--   #2  SELECT id FROM threats WHERE malicious_domain = ? LIMIT ?
--       → 11.67% of DB time, 410 executions, 75.11M rows read
--       → ~183K rows/execution = also full-scan
--
-- The existing non-partial idx_threats_domain (migration 0001) is not being
-- selected by SQLite's planner for query #1 — most likely because the
-- (ip_address IS NULL OR ip_address = '') disjunction defeats straight
-- index-driven row retrieval when combined with the other predicates, and
-- without current ANALYZE statistics the planner falls back to a scan.
--
-- Partial indexes fix this cleanly: the predicate is encoded in the index
-- itself, so the planner trivially picks it whenever the query's WHERE
-- implies the partial predicate.
--
-- Also relevant: observatory/infrastructure-cluster queries #3/#5 read 47M
-- rows combined because the `threat_history_json` subquery does
-- `SELECT COUNT(*) FROM threats WHERE cluster_id = ? GROUP BY date(...)`
-- for each cluster without an index on cluster_id. Adding idx_threats_cluster
-- cuts these from ~13M to well under 1M rows per run.

-- ─── DNS backfill UPDATE hotspot ────────────────────────────────────
-- Predicate matches the exact WHERE clause of the UPDATE in
-- packages/trust-radar/src/lib/dns-backfill.ts:119-125
CREATE INDEX IF NOT EXISTS idx_threats_dns_backfill
  ON threats(malicious_domain)
  WHERE (ip_address IS NULL OR ip_address = '')
    AND status = 'active';

-- ─── Infrastructure cluster scoping ─────────────────────────────────
-- Covers subqueries that scope by cluster_id for threat history / counts.
-- Includes created_at as the second column so the per-date GROUP BY used
-- by the threat_history_json subquery can be satisfied from the index
-- without additional table lookups per cluster.
CREATE INDEX IF NOT EXISTS idx_threats_cluster_recent
  ON threats(cluster_id, created_at)
  WHERE cluster_id IS NOT NULL;

-- ─── Ensure the base malicious_domain index exists ──────────────────
-- Migration 0001 created this but belt-and-suspenders for any database that
-- fell out of sync.
CREATE INDEX IF NOT EXISTS idx_threats_domain ON threats(malicious_domain);

-- ─── Refresh statistics so the planner actually picks the new indexes ─
ANALYZE threats;
