-- Phase 4 — parity_checks history table.
--
-- Stores the result of every cube==raw parity check run by the parity_checker
-- agent. One row per (check_type, window_label, cube_name) triple per agent run.
--
-- check_type:
--   'window' — broad window (24h, 7d, 14d, 30d)
--   'hourly' — single hour bucket (48 checks per run: last 24h × geo/provider)
--
-- drift_abs = abs(cube_total - raw_total). Zero is the healthy case.
-- is_tolerable: 1 for H-1 hourly checks where drift <= 5 (cartographer retroactive
--               updates between fast_tick runs can cause small transient drift).
--               All other checks are tolerable only when drift_abs = 0.
--
-- This table is append-only — parity_checker only INSERTs, never UPDATEs or
-- DELETEs. A future retention cron can prune rows older than 30 days if the
-- table grows large (56 rows/hour = ~40K rows/month).

CREATE TABLE IF NOT EXISTS parity_checks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  check_time      TEXT NOT NULL DEFAULT (datetime('now')),
  check_type      TEXT NOT NULL,             -- 'window' or 'hourly'
  window_label    TEXT NOT NULL,             -- e.g., '24 hours', '7 days', '2026-04-11 02:00:00'
  cube_name       TEXT NOT NULL,             -- 'geo' or 'provider'
  cube_total      INTEGER NOT NULL,
  raw_total       INTEGER NOT NULL,
  drift_abs       INTEGER NOT NULL,          -- abs(cube - raw)
  drift_pct       REAL,                      -- nullable for 0/0 cases
  is_tolerable    INTEGER NOT NULL DEFAULT 0 -- 1 if within tolerance for in-progress hours
);

CREATE INDEX IF NOT EXISTS idx_parity_checks_time
  ON parity_checks(check_time DESC);

CREATE INDEX IF NOT EXISTS idx_parity_checks_drift
  ON parity_checks(drift_abs DESC, check_time DESC)
  WHERE drift_abs > 0;
