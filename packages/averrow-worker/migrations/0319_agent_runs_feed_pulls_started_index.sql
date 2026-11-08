-- 0319 — started_at indexes on agent_runs and feed_pull_history.
--
-- ── Why ──────────────────────────────────────────────────────────────
-- GET /api/internal/platform-diagnostics failed 5/5 on prod 2026-11-08
-- (04:30–04:35 UTC) with `D1 DB is overloaded. Too many resources consumed
-- within a 10 second window`. Its agent_mesh rollup is a windowed
-- `GROUP BY agent_id` over agent_runs (~132K rows, never pruned) and its
-- feeds rollup a windowed `GROUP BY feed_name` over feed_pull_history
-- (never pruned). Neither table had an index that leads with started_at,
-- so both read the whole table (plus a table lookup per row) to keep the
-- last N hours. The handler now filters with a plain
-- `started_at >= datetime('now', '-N hours')` range (an exact superset of
-- the `datetime(started_at)` window, see handlers/diagnostics.ts) and these
-- indexes serve it: `SEARCH ... USING INDEX idx_agent_runs_started
-- (started_at>?)`, pinned by test/diagnostics-overload-safe.test.ts.
--
-- ── Cost ─────────────────────────────────────────────────────────────
-- One-time build: one pass over each table plus one index entry per row.
-- One extra index write per INSERT afterwards (started_at is never
-- updated). Additive; no existing column or index is touched.

CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_feed_pulls_started ON feed_pull_history(started_at);
