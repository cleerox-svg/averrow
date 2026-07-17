-- Trust Radar v2 — Admin Management Tables
-- feed_configs, feed_pull_history, agent_runs, agent_outputs, system_notifications

-- ─── Feed Configs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feed_configs (
  feed_name           TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  description         TEXT,
  source_url          TEXT,
  api_key_encrypted   TEXT,           -- encrypted, masked in UI
  schedule_cron       TEXT NOT NULL,   -- cron expression
  rate_limit          INTEGER NOT NULL DEFAULT 60,  -- requests per minute
  batch_size          INTEGER NOT NULL DEFAULT 100, -- max records per pull
  retry_count         INTEGER NOT NULL DEFAULT 3,
  retry_delay_seconds INTEGER NOT NULL DEFAULT 30,
  enabled             INTEGER NOT NULL DEFAULT 1,   -- boolean
  filters             TEXT,            -- JSON, feed-specific filtering
  normalization_rules TEXT,            -- JSON, field mapping
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by          TEXT REFERENCES users(id)
);

-- ─── Feed Pull History ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feed_pull_history (
  id               TEXT PRIMARY KEY,
  feed_name        TEXT NOT NULL REFERENCES feed_configs(feed_name),
  started_at       TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at     TEXT,
  duration_ms      INTEGER,
  records_ingested INTEGER NOT NULL DEFAULT 0,
  records_rejected INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'partial', 'failed')),
  error_message    TEXT
);

CREATE INDEX idx_feed_pulls_feed ON feed_pull_history(feed_name, started_at DESC);
CREATE INDEX idx_feed_pulls_status ON feed_pull_history(status);

-- ─── Agent Runs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_runs (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL,    -- sentinel, analyst, cartographer, strategist, observer
  started_at        TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at      TEXT,
  duration_ms       INTEGER,
  status            TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'partial', 'failed')),
  error_message     TEXT,
  records_processed INTEGER NOT NULL DEFAULT 0,
  outputs_generated INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_agent_runs_agent ON agent_runs(agent_id, started_at DESC);
CREATE INDEX idx_agent_runs_status ON agent_runs(status);

-- ─── Agent Outputs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_outputs (
  id                   TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL,
  type                 TEXT NOT NULL CHECK (type IN ('insight', 'classification', 'correlation', 'score', 'trend_report')),
  summary              TEXT NOT NULL,   -- the actual intelligence/analysis
  severity             TEXT CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  details              TEXT,            -- JSON, full output payload
  related_brand_ids    TEXT,            -- JSON array of UUIDs
  related_campaign_id  TEXT REFERENCES campaigns(id),
  related_provider_ids TEXT,            -- JSON array of UUIDs
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_agent_outputs_agent ON agent_outputs(agent_id, created_at DESC);
CREATE INDEX idx_agent_outputs_type ON agent_outputs(type);
CREATE INDEX idx_agent_outputs_severity ON agent_outputs(severity);

-- ─── System Notifications ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_notifications (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('new_lead', 'feed_down', 'feed_recovered', 'security_alert')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_by    TEXT         -- JSON array of user IDs
);

CREATE INDEX idx_notifications_type ON system_notifications(type);
CREATE INDEX idx_notifications_created ON system_notifications(created_at DESC);
