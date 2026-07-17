-- ARCHITECT consolidation — drop the three bespoke tables.
--
-- Phase 4 Step 1 folds ARCHITECT into the standard AgentModule
-- pattern. Run state lives in agent_runs (started_at, completed_at,
-- status, duration_ms, tokens_used, error_message) and the markdown
-- report + computed scorecard + per-section analyses + bundle R2 key
-- all live inside agent_outputs.details for the single output row
-- the architect agent emits per run.
--
-- The bundle JSON itself still goes to R2 via the ARCHITECT_BUNDLES
-- binding; that binding is unchanged. The three D1 tables that used
-- to track the multi-step flow are no longer needed because there is
-- no multi-step flow — collect → analyze → synthesize all run
-- inline inside the single execute() call.
--
-- Order matters: drop the FK children (analyses, syntheses) before
-- the parent (reports). We deliberately KEEP
-- architect_table_snapshots — it is the data-layer collector's
-- per-table growth-history table and computes growth_7d_pct, which
-- the agents analyzer cites as evidence. It is independent of run
-- state.
--
-- Dev data in these tables is being intentionally discarded — there
-- is no preservation path. New runs will populate agent_runs +
-- agent_outputs from scratch.
DROP TABLE IF EXISTS architect_syntheses;
DROP TABLE IF EXISTS architect_analyses;
DROP TABLE IF EXISTS architect_reports;
