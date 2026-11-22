-- 0001_init.sql: telemetry store (averrow-telemetry), wave 1 (Track B1a)
--
-- The operational bookkeeping tables, which JOIN only each other, are
-- moving off the core DB (trust-radar-v2) so that run and pull finalizes
-- never wait on core's overload window. This file is the CURRENT core
-- shape of each wave-1 table, rebuilt from every core migration that
-- touches it: columns in core's order, types, NOT NULL, defaults, CHECKs,
-- primary keys and every index (including partial ones).
--
-- MIRROR RULE: until the cut-over, a core migration that changes one of
-- these tables (ADD COLUMN, CREATE/DROP INDEX, ...) MUST be mirrored by a
-- new migrations-telemetry/NNNN_*.sql. test/telemetry-schema-parity.test.ts
-- builds both DBs from their migration dirs and fails on any difference.
--
-- One deliberate difference: feed_configs.updated_by has no
-- REFERENCES users(id). D1 enforces foreign keys and users stays on core,
-- so that FK would reject every non-NULL updated_by write here. The FKs
-- inside the cluster (feed_pull_history.feed_name -> feed_configs) stay.
--
-- Schema only. Seed rows (feed_configs, budget_config id=1,
-- agent_approvals) arrive with the cut-over data copy, not here. Nothing
-- reads or writes this DB yet (lib/db-route.ts defaults to core).
--
-- Wave-1 tables: agent_runs, agent_configs, agent_events,
-- agent_activity_log, agent_approvals, feed_configs, feed_status,
-- feed_pull_history, budget_ledger, budget_config, agent_budget_rollups
-- (written in the same batch as budget_ledger by budgetManager.recordCost,
-- so it has to live on the same DB). agent_outputs is wave 2.

-- ─── agent_runs ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_runs (
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

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_completed ON agent_runs(completed_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_open ON agent_runs(started_at)
  WHERE completed_at IS NULL AND status IN ('partial', 'running');
CREATE INDEX IF NOT EXISTS idx_agent_runs_success_duration
  ON agent_runs(agent_id, duration_ms)
  WHERE status = 'success';

-- ─── agent_configs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_configs (
  agent_id                       TEXT PRIMARY KEY,
  enabled                        INTEGER NOT NULL DEFAULT 1,
  paused_reason                  TEXT,
  consecutive_failures           INTEGER NOT NULL DEFAULT 0,
  consecutive_failure_threshold  INTEGER,
  circuit_trip_rule              TEXT NOT NULL DEFAULT 'consecutive_failures',
  paused_at                      TEXT,
  paused_after_n_failures        INTEGER,
  created_at                     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── agent_events ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  source_agent TEXT NOT NULL,
  target_agent TEXT,
  payload_json TEXT,
  priority INTEGER DEFAULT 5,
  created_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','failed'))
);

CREATE INDEX IF NOT EXISTS idx_agent_events_pending
  ON agent_events(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_type_created
  ON agent_events(event_type, created_at);

-- ─── agent_activity_log ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_activity_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  event_type TEXT NOT NULL,
  message TEXT,
  metadata_json TEXT,
  severity TEXT DEFAULT 'info'
    CHECK (severity IN ('info','warning','critical')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_agent
  ON agent_activity_log(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_recent
  ON agent_activity_log(created_at DESC);

-- ─── agent_approvals ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_approvals (
  agent_id        TEXT PRIMARY KEY,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'changes_requested')),
  requested_at    TEXT NOT NULL,
  reviewed_at     TEXT,
  reviewed_by     TEXT,
  reviewer_notes  TEXT,
  source_pr       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_approvals_pending
  ON agent_approvals(state, requested_at DESC);

-- ─── feed_configs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feed_configs (
  feed_name                 TEXT PRIMARY KEY,
  display_name              TEXT NOT NULL,
  description               TEXT,
  source_url                TEXT,
  api_key_encrypted         TEXT,
  schedule_cron             TEXT NOT NULL,
  rate_limit                INTEGER NOT NULL DEFAULT 60,
  batch_size                INTEGER NOT NULL DEFAULT 100,
  retry_count               INTEGER NOT NULL DEFAULT 3,
  retry_delay_seconds       INTEGER NOT NULL DEFAULT 30,
  enabled                   INTEGER NOT NULL DEFAULT 1,
  filters                   TEXT,
  normalization_rules       TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by                TEXT,
  feed_type                 TEXT NOT NULL DEFAULT 'ingest',
  paused_reason             TEXT,
  consecutive_failure_threshold INTEGER,
  taxii_root_url            TEXT,
  taxii_collection_id       TEXT,
  taxii_auth_type           TEXT,
  taxii_username            TEXT,
  taxii_api_key_env         TEXT,
  taxii_next_added_after    TEXT
);

-- ─── feed_status ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feed_status (
  feed_name              TEXT PRIMARY KEY,
  last_successful_pull   TEXT,
  last_failure           TEXT,
  records_ingested_today INTEGER NOT NULL DEFAULT 0,
  health_status          TEXT NOT NULL DEFAULT 'disabled' CHECK (health_status IN ('healthy', 'degraded', 'down', 'disabled')),
  last_error             TEXT,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  next_retry_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_feed_status_next_retry
  ON feed_status(next_retry_at)
  WHERE next_retry_at IS NOT NULL;

-- ─── feed_pull_history ─────────────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS idx_feed_pulls_feed ON feed_pull_history(feed_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_pulls_started ON feed_pull_history(started_at);
CREATE INDEX IF NOT EXISTS idx_feed_pulls_status ON feed_pull_history(status);

-- ─── budget_ledger ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS budget_ledger (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  run_id        TEXT,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_budget_ledger_created_agent
  ON budget_ledger(created_at, agent_id);
CREATE INDEX IF NOT EXISTS idx_ledger_agent
  ON budget_ledger(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_month
  ON budget_ledger(created_at);

-- ─── budget_config ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS budget_config (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  monthly_limit_usd  REAL NOT NULL DEFAULT 21.33,
  soft_pct           REAL NOT NULL DEFAULT 80,
  hard_pct           REAL NOT NULL DEFAULT 95,
  emergency_pct      REAL NOT NULL DEFAULT 99,
  updated_at         TEXT DEFAULT (datetime('now'))
);

-- ─── agent_budget_rollups ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_budget_rollups (
  agent_id            TEXT NOT NULL,
  year_month          TEXT NOT NULL,
  total_input_tokens  INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd      REAL NOT NULL DEFAULT 0,
  call_count          INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, year_month)
);

CREATE INDEX IF NOT EXISTS idx_agent_budget_rollups_month
  ON agent_budget_rollups(year_month, total_cost_usd DESC);
