-- Dead intel surfaces: breach_checks + ato_events
--
-- handlers/intel.ts has shipped /api/breaches and /api/ato endpoints
-- for some time, but no migration ever created the tables and no
-- feed writes to them. Each page-load was returning a 500 (caught
-- by the handler's try/catch and surfaced as "An internal error
-- occurred").
--
-- This migration creates the tables with the exact column shape the
-- handlers SELECT — turning the endpoints from "error" into "clean
-- empty result." Populating these is a separate workstream (HIBP for
-- breaches, ATO detection module for ato_events); the tables can sit
-- empty without breaking the read path.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS breach_checks (
  id            TEXT PRIMARY KEY,
  check_type    TEXT,
  target        TEXT,
  breach_name   TEXT,
  breach_date   TEXT,
  data_types    TEXT,
  source        TEXT,
  severity      TEXT,
  resolved      INTEGER DEFAULT 0,
  checked_at    TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_breach_checks_target
  ON breach_checks(target);
CREATE INDEX IF NOT EXISTS idx_breach_checks_created
  ON breach_checks(created_at DESC);

CREATE TABLE IF NOT EXISTS ato_events (
  id             TEXT PRIMARY KEY,
  email          TEXT,
  event_type     TEXT,
  ip_address     TEXT,
  country_code   TEXT,
  user_agent     TEXT,
  risk_score     INTEGER,
  status         TEXT DEFAULT 'new',
  source         TEXT,
  detected_at    TEXT,
  resolved_at    TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ato_events_status
  ON ato_events(status);
CREATE INDEX IF NOT EXISTS idx_ato_events_detected
  ON ato_events(detected_at DESC);
