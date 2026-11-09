-- 0321 — completed_at index on agent_runs.
--
-- ── Why ──────────────────────────────────────────────────────────────
-- GET /api/admin/pipeline-status (handlers/admin/pipeline.ts) reads the
-- last finished run per agent with
-- `WHERE completed_at > datetime('now', '-24 hours') GROUP BY agent_id`.
-- The predicate is already a plain range on the bare column, but no index
-- leads with completed_at, so the planner walked idx_agent_runs_agent over
-- the whole table (~132.7K rows/call, ~101 calls/day on 2026-11-08). With
-- this index and `GROUP BY +agent_id` the plan is
-- `SEARCH agent_runs USING INDEX idx_agent_runs_completed (completed_at>?)`
-- (pinned by test/agent-runs-open-index.test.ts) and reads one day of runs.
-- The predicate text is unchanged, so results are identical.
--
-- ── Cost ─────────────────────────────────────────────────────────────
-- One pass over agent_runs to build. One index write when a run is
-- finalized (completed_at goes NULL → set); NULLs while open. Additive.

CREATE INDEX IF NOT EXISTS idx_agent_runs_completed ON agent_runs(completed_at);
