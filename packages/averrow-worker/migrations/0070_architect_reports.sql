-- ARCHITECT meta-agent: report and bundle storage
CREATE TABLE IF NOT EXISTS architect_reports (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL,
  run_type        TEXT NOT NULL CHECK (run_type IN ('weekly','ondemand','deep')),
  status          TEXT NOT NULL CHECK (status IN ('collecting','analyzing','complete','failed')),
  context_bundle_r2_key TEXT,
  report_md       TEXT,
  cost_usd        REAL DEFAULT 0,
  model_mix_json  TEXT,
  error_message   TEXT,
  duration_ms     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_architect_reports_created_at
  ON architect_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_architect_reports_status
  ON architect_reports(status);

-- Lightweight per-table growth tracking so collectors can compute deltas
CREATE TABLE IF NOT EXISTS architect_table_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at   INTEGER NOT NULL,
  table_name    TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  est_bytes     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_architect_snapshots_table_time
  ON architect_table_snapshots(table_name, captured_at DESC);
