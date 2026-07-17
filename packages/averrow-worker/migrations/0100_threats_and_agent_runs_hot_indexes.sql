-- Phase-2 D1 read cost reduction — picks up what migration 0099 didn't.
--
-- After 0099 killed the top two malicious_domain scans (70% of reads),
-- D1 query insights showed the remaining hot queries:
--
--   A. SELECT DISTINCT malicious_domain FROM threats
--        WHERE (ip_address IS NULL OR ip_address = '')
--          AND malicious_domain IS NOT NULL AND malicious_domain != ''
--          AND malicious_domain NOT LIKE '*%' AND malicious_domain LIKE '%.%'
--          AND (attempted_resolve_at IS NULL OR …)
--        LIMIT ?
--      → source: src/lib/dns-backfill.ts:60-72 (Navigator cron, every 5 min)
--      → observed 1.26M rows / 7 executions = ~180K rows/exec (full scan)
--      → same predicate shape as the UPDATE that 0099 indexed — needs its
--        own partial index because the SELECT DISTINCT has additional
--        NULL-filter clauses
--
--   B. SELECT agent_id, AVG(duration_ms) as avg_duration_ms
--        FROM agent_runs WHERE status = 'success' GROUP BY agent_id
--      → source: src/handlers/agents.ts:110 (unscoped historical aggregate)
--      → observed ~107K rows/exec because it aggregates ALL success runs
--        ever recorded, not a recent window
--      → partial index makes the aggregation index-only; a follow-up code
--        change (this PR) scopes the query to the last 24h so it stays
--        bounded as agent_runs grows unboundedly

-- ─── DNS backfill SELECT DISTINCT hotspot ───────────────────────────
-- Mirror of idx_threats_dns_backfill but extended to cover the extra
-- NULL/format predicates on malicious_domain. Partial predicate is a
-- subset of the query's WHERE so the planner picks it for this and
-- related "unresolved domains" scans.
CREATE INDEX IF NOT EXISTS idx_threats_dns_backfill_select
  ON threats(malicious_domain, attempted_resolve_at)
  WHERE (ip_address IS NULL OR ip_address = '')
    AND malicious_domain IS NOT NULL
    AND malicious_domain != '';

-- ─── agent_runs success-duration aggregation ────────────────────────
-- Covers SELECT agent_id, AVG(duration_ms) … WHERE status='success' GROUP BY agent_id
-- The aggregation can be satisfied from the index alone without row
-- lookups. Partial predicate (status='success') keeps the index compact.
CREATE INDEX IF NOT EXISTS idx_agent_runs_success_duration
  ON agent_runs(agent_id, duration_ms)
  WHERE status = 'success';

-- Statistics refresh so the planner picks the new indexes.
ANALYZE threats;
ANALYZE agent_runs;
