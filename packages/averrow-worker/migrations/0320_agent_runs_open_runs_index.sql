-- 0320 — partial index over OPEN agent_runs rows (the orphan-reaper set).
--
-- ── Why ──────────────────────────────────────────────────────────────
-- Navigator's orphan reaper (lib/agent-runs-reaper.ts, every 5 min) looks
-- for runs that never finalized: `status IN ('partial','running') AND
-- completed_at IS NULL` past a 15-min pre-filter. Its only time term was
-- `datetime(started_at) <= …`, which no index can serve, so every tick read
-- the whole agent_runs table (~132.7K rows/call, ~38M rows/day, the largest
-- single Navigator read on 2026-11-08 while prod D1 was hitting
-- `D1 DB is overloaded` bursts).
--
-- The index holds only open rows (a handful at any moment — every finished
-- run has completed_at set), and the reaper now adds a plain
-- `started_at <= <ISO bound>` range next to the exact datetime() term, so
-- the plan is `SEARCH agent_runs USING INDEX idx_agent_runs_open
-- (started_at<?)` (pinned by test/agent-runs-open-index.test.ts).
-- The partial WHERE must stay textually identical to the reaper's
-- (OPEN_AGENT_RUN_SQL) or SQLite will not consider the index.
--
-- ── Cost ─────────────────────────────────────────────────────────────
-- One pass over agent_runs to build; entries are tiny (open rows only).
-- Each run adds one entry on INSERT and drops it on finalize. Additive.

CREATE INDEX IF NOT EXISTS idx_agent_runs_open ON agent_runs(started_at)
  WHERE completed_at IS NULL AND status IN ('partial', 'running');
