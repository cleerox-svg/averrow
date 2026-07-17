-- ─── Per-agent monthly budget rollup ──────────────────────────────
--
-- Phase 5.1 of agent audit. The naive per-call enforcement —
--   SELECT SUM(input_tokens + output_tokens) FROM budget_ledger
--   WHERE agent_id = ? AND created_at >= datetime('now', 'start of month')
-- — would land another 30-day SUM on the budget_ledger table on every
-- AI call, doubling the existing 31.8M reads/24h that
-- BudgetManager.getMonthlySpend() already incurs. Bad design.
--
-- Instead this table holds one row per (agent_id, year_month).
-- BudgetManager.recordCost() UPSERTs the rollup inside the same
-- write that lands the budget_ledger row, keeping the two stores
-- consistent. Pre-flight enforcement reads a single row by
-- primary key — O(log n) — and the result is KV-cached for 60s
-- so high-volume sync agents pay no per-call D1 read at all.
--
-- Side benefits:
--   * Replaces BudgetManager.getMonthlySpend() with a
--     one-row-per-agent SELECT instead of a budget_ledger SUM.
--     Drops the platform-wide cost-guard hot-path read by ~32M
--     rows/day (the #5 D1 reader in 24h diagnostic).
--   * Replaces getSpendByAgent() — same shape, no GROUP BY needed.
--
-- The table is a derived/materialised cache of budget_ledger.
-- budget_ledger remains the source of truth for forensic / per-call
-- attribution — anyone wanting "list every call sentinel made
-- between 14:00 and 15:00" still queries budget_ledger directly.

CREATE TABLE IF NOT EXISTS agent_budget_rollups (
  agent_id            TEXT NOT NULL,
  -- ISO year-month bucket — 'YYYY-MM'. Aligned with strftime('%Y-%m').
  year_month          TEXT NOT NULL,
  total_input_tokens  INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd      REAL NOT NULL DEFAULT 0,
  call_count          INTEGER NOT NULL DEFAULT 0,
  -- When this rollup row was last touched. Lets the diagnostic flag
  -- agents whose rollup hasn't moved in N hours (e.g. cron stalled).
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, year_month)
);

-- Index for "all agents this month" reads (admin diagnostic).
-- Primary-key lookups by (agent_id, year_month) don't need a separate
-- index — they hit the implicit PK B-tree directly.
CREATE INDEX IF NOT EXISTS idx_agent_budget_rollups_month
  ON agent_budget_rollups(year_month, total_cost_usd DESC);

-- Backfill — rebuild rollups from the existing budget_ledger so the
-- enforcement gate has accurate state on day 1 of the rollout.
-- Idempotent because the PK ensures one row per (agent_id, year_month);
-- a re-run replaces values with the recomputed sums.
INSERT OR REPLACE INTO agent_budget_rollups (
  agent_id, year_month,
  total_input_tokens, total_output_tokens, total_cost_usd, call_count,
  updated_at
)
SELECT
  agent_id,
  strftime('%Y-%m', created_at)              AS year_month,
  COALESCE(SUM(input_tokens),  0)            AS total_input_tokens,
  COALESCE(SUM(output_tokens), 0)            AS total_output_tokens,
  COALESCE(SUM(cost_usd),      0)            AS total_cost_usd,
  COUNT(*)                                   AS call_count,
  datetime('now')                            AS updated_at
FROM budget_ledger
WHERE created_at >= datetime('now', '-90 days')
GROUP BY agent_id, year_month;

ANALYZE;
