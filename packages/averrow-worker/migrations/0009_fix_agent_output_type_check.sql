-- Fix agent_outputs CHECK constraint to allow 'diagnostic' type
-- D1/SQLite doesn't support ALTER TABLE to modify CHECK constraints,
-- so we recreate the table with the updated constraint.

CREATE TABLE IF NOT EXISTS agent_outputs_new (
  id                   TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('insight', 'classification', 'correlation', 'score', 'trend_report', 'diagnostic')),
  summary              TEXT NOT NULL,
  severity             TEXT CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  details              TEXT,
  related_brand_ids    TEXT,
  related_campaign_id  TEXT REFERENCES campaigns(id),
  related_provider_ids TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO agent_outputs_new SELECT * FROM agent_outputs;

DROP TABLE agent_outputs;

ALTER TABLE agent_outputs_new RENAME TO agent_outputs;

CREATE INDEX IF NOT EXISTS idx_agent_outputs_agent ON agent_outputs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_type ON agent_outputs(type);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_severity ON agent_outputs(severity);
