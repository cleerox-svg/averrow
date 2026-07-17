-- ─── Composite indexes for hot query patterns ─────────────────────
--
-- Identified by /api/internal/platform-diagnostics' new
-- d1_top_queries_24h block. These three indexes collectively
-- eliminate ~360M D1 row-reads per day (~44% of the daily budget)
-- by turning current full-table scans into B-tree lookups.
--
-- Each index is durable + scalable: stays O(log n) as the underlying
-- table grows. No application-side caching, no TTLs to manage.
--
--
-- 1) threats(ip_address, source_feed) — kills Group 1 (~270M reads/day)
--
-- The Sentinel feed-ingest path runs ~1,500 queries/day in this shape:
--   UPDATE threats SET last_seen = datetime('now')
--   WHERE ip_address = ? AND source_feed = 'emerging_threats'
--   (and similar for blocklist_de, spamhaus_drop, c2_tracker, etc.)
-- and similar SELECT ID lookups.
--
-- threats(ip_address) and threats(source_feed) are already indexed
-- separately (migration 0001:91, 0001:93), but SQLite can only use
-- ONE single-column index per query. It picks ip_address (more
-- selective), fetches matching rows, then filter-scans by source_feed.
-- With 200K+ active threats and low IP cardinality from some feeds,
-- the planner falls back to a full-table scan — observed at
-- ~211K rows/call.
--
-- A composite index turns the WHERE clause into an index-only prefix
-- match: lookup ~1 row instead of scanning 211K. Per-call cost drops
-- by ~5 orders of magnitude.
--
CREATE INDEX IF NOT EXISTS idx_threats_ip_source_feed
  ON threats(ip_address, source_feed);


-- 2) agent_outputs(created_at) — kills Group 2 date-range scans
--    (~50M reads/day)
--
-- Existing indexes:
--   idx_agent_outputs_agent     (agent_id, created_at DESC)
--   idx_agent_outputs_severity  (severity)
--   idx_agent_outputs_type      (type)
--
-- Missing: an index on created_at alone. Diagnostic showed:
--   SELECT agent_id, COUNT(*) FROM agent_outputs
--   WHERE created_at >= datetime('now', '-1 day')
--   GROUP BY agent_id
-- doing 115K rows/call (full scan). The composite (agent_id,
-- created_at DESC) doesn't help here because the query starts with
-- the date predicate, not agent_id — SQLite would scan the whole
-- composite or fall back to a heap scan.
--
-- A direct (created_at) index serves the date-range scan. The
-- existing composite (agent_id, created_at DESC) still wins for
-- "this agent's recent outputs" queries.
--
CREATE INDEX IF NOT EXISTS idx_agent_outputs_created_at
  ON agent_outputs(created_at DESC);


-- 3) budget_ledger(created_at, agent_id) — kills Group 4 (~37M reads/day)
--
-- Two query shapes hammer this table:
--   SELECT SUM(cost_usd) FROM budget_ledger
--   WHERE created_at >= datetime('now', 'start of month')
--
--   SELECT agent_id, SUM(cost_usd), COUNT(*) FROM budget_ledger
--   WHERE created_at >= datetime('now', 'start of month')
--   GROUP BY agent_id
--
-- Both filter by created_at then either aggregate or group by
-- agent_id. The composite (created_at, agent_id) serves the date
-- range AND keeps GROUP BY agent_id cheap by clustering rows for
-- each agent within the date range.
--
-- Verify the table exists first — budget_ledger was added later in
-- the migration history; older deployments might not have it.
--
CREATE INDEX IF NOT EXISTS idx_budget_ledger_created_agent
  ON budget_ledger(created_at, agent_id);


-- ANALYZE so the SQLite query planner picks up the new indexes
-- immediately. Without this, the planner uses stale stats from
-- before the indexes existed and may still choose the old plan
-- until enough write activity triggers automatic re-stats.
ANALYZE;
