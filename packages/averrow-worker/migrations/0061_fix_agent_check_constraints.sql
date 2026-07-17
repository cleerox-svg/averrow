-- Fix CHECK constraints that are too restrictive for current agent types.
--
-- agent_outputs.type: add 'weekly_intel' and 'hygiene_report' to allowed values
-- agent_runs.status: add 'running' to allowed values
--
-- D1 / SQLite does not support ALTER TABLE ... ALTER CONSTRAINT, so we
-- recreate the tables with the updated CHECK constraints.

-- ─── agent_outputs ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_outputs_v3 (
  id                   TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('insight', 'classification', 'correlation', 'score', 'trend_report', 'diagnostic', 'weekly_intel', 'hygiene_report')),
  summary              TEXT NOT NULL,
  severity             TEXT CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  details              TEXT,
  related_brand_ids    TEXT,
  related_campaign_id  TEXT REFERENCES campaigns(id),
  related_provider_ids TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO agent_outputs_v3 SELECT * FROM agent_outputs;

DROP TABLE agent_outputs;

ALTER TABLE agent_outputs_v3 RENAME TO agent_outputs;

CREATE INDEX IF NOT EXISTS idx_agent_outputs_agent ON agent_outputs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_type ON agent_outputs(type);

-- ─── agent_runs ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_runs_v3 (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL,
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at      TEXT,
  duration_ms       INTEGER,
  status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('success', 'partial', 'failed', 'running')),
  error_message     TEXT,
  records_processed INTEGER NOT NULL DEFAULT 0,
  outputs_generated INTEGER NOT NULL DEFAULT 0,
  tokens_used       INTEGER DEFAULT 0,
  input_tokens      INTEGER DEFAULT 0,
  output_tokens     INTEGER DEFAULT 0
);

INSERT OR IGNORE INTO agent_runs_v3
  SELECT id, agent_id, started_at, completed_at, duration_ms, status,
         error_message, records_processed, outputs_generated,
         COALESCE(tokens_used, 0), COALESCE(input_tokens, 0), COALESCE(output_tokens, 0)
  FROM agent_runs;

DROP TABLE agent_runs;

ALTER TABLE agent_runs_v3 RENAME TO agent_runs;

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
