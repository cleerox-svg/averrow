-- ARCHITECT meta-agent: Phase 3 — Sonnet synthesis report
--
-- One row per architect_reports.run_id. Phase 3 loads the three
-- architect_analyses rows for the run, computes the ground-truth
-- scorecard from the raw assessments arrays (dropping Haiku's
-- self-reported numbers), and asks Sonnet 4.5 to emit a single
-- markdown executive report reconciling cross-section findings.
--
-- report_md is the final markdown payload returned to admin UIs.
-- computed_scorecard_json stores the deterministic counts so the
-- UI can render the scorecard without re-parsing markdown and so
-- later audits can diff the server-computed numbers against the
-- narrative.
CREATE TABLE IF NOT EXISTS architect_syntheses (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','synthesizing','complete','failed')),
  model           TEXT NOT NULL,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        REAL,
  duration_ms     INTEGER,
  report_md       TEXT,
  computed_scorecard_json TEXT,
  error_message   TEXT,
  FOREIGN KEY (run_id) REFERENCES architect_reports(run_id)
);

CREATE INDEX IF NOT EXISTS idx_architect_syntheses_created
  ON architect_syntheses(created_at DESC);
