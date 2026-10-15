-- 0307 — partial (resolved_at) index over taken-down takedown requests.
--
-- Additive only. No column is dropped, altered or rewritten.
--
-- GET /api/observatory/events (handlers/observatoryEvents.ts, `takedown`
-- kind) lists the requests that reached status 'taken_down' in the last
-- 1h / 24h / 7d, newest first:
--
--   WHERE tr.status = 'taken_down' AND tr.resolved_at >= ?
--   ORDER BY tr.resolved_at DESC LIMIT ?
--
-- resolved_at had no index, so the only access path was idx_takedown_status
-- (status = 'taken_down') + a per-row resolved_at filter + a sort — every
-- taken-down row ever, on each cache miss, growing without bound. This index
-- holds only taken-down rows, keyed by when they were taken down, so the read
-- is a range seek over the window's rows in order (no sort). SQLite uses a
-- partial index only when the query's WHERE contains the index's WHERE term
-- (`status = 'taken_down'`), which the events read does verbatim.
-- Plan pinned in test/observatory-events.test.ts.
--
-- The ops PATCH stamps resolved_at = datetime('now') on the transition to
-- taken_down (handlers/takedowns.ts) and clears it on re-open.

CREATE INDEX IF NOT EXISTS idx_takedown_taken_down_resolved
  ON takedown_requests(resolved_at)
  WHERE status = 'taken_down';
