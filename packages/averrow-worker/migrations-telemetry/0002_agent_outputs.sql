-- 0002_agent_outputs.sql: telemetry store, wave 2 (Track B1) — agent_outputs
--
-- agent_outputs joins the AGENTS family (route flag `db_route:telemetry`,
-- the same flag and 'used' marker as agent_runs / agent_events /
-- agent_activity_log; lib/db-route.ts FAMILY_TABLES). Writes go forward to
-- the routed store; history reads are a telemetry ∪ core union
-- (lib/telemetry-read.ts) until the backfill has copied core's rows
-- (POST /api/internal/telemetry/backfill?table=agent_outputs).
--
-- This is the CURRENT core shape of agent_outputs, rebuilt from every core
-- migration that touches it: 0003 (create), 0009 + 0061 (table rebuilds that
-- widened the type CHECK; 0061 did not recreate idx_agent_outputs_severity,
-- so core has no severity index), 0123 (idx_agent_outputs_created_at).
-- test/telemetry-schema-parity.test.ts pins columns, CHECKs and indexes.
--
-- One deliberate difference: related_campaign_id has no REFERENCES
-- campaigns(id). D1 enforces foreign keys and campaigns stays on core, so
-- that FK would reject every write carrying a campaign id here (same rule
-- as feed_configs.updated_by -> users in 0001_init.sql).
--
-- Schema only. Applied by the deploy workflow before the Worker deploys, so
-- the table exists before any code writes or reads it.

CREATE TABLE IF NOT EXISTS agent_outputs (
  id                   TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('insight', 'classification', 'correlation', 'score', 'trend_report', 'diagnostic', 'weekly_intel', 'hygiene_report')),
  summary              TEXT NOT NULL,
  severity             TEXT CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  details              TEXT,
  related_brand_ids    TEXT,
  related_campaign_id  TEXT,
  related_provider_ids TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_outputs_agent ON agent_outputs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_type ON agent_outputs(type);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_created_at ON agent_outputs(created_at DESC);
