-- ARCHITECT meta-agent: Phase 2 — Haiku inventory analysis
-- Stores one row per (run_id, section) where section is one of
-- agents | feeds | data_layer. The analysis_json column holds the
-- parsed AgentsAnalysis / FeedsAnalysis / DataLayerAnalysis payload
-- produced by claude-haiku-4-5-20251001 against the ContextBundle
-- fetched from R2 for the corresponding architect_reports row.
CREATE TABLE IF NOT EXISTS architect_analyses (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  section         TEXT NOT NULL CHECK (section IN ('agents','feeds','data_layer')),
  status          TEXT NOT NULL CHECK (status IN ('pending','analyzing','complete','failed')),
  model           TEXT NOT NULL,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        REAL,
  duration_ms     INTEGER,
  analysis_json   TEXT,
  error_message   TEXT,
  FOREIGN KEY (run_id) REFERENCES architect_reports(run_id)
);

CREATE INDEX IF NOT EXISTS idx_architect_analyses_run
  ON architect_analyses(run_id);
CREATE INDEX IF NOT EXISTS idx_architect_analyses_section
  ON architect_analyses(section, created_at DESC);
