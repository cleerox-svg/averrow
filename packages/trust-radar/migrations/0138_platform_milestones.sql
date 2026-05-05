-- Migration 0138 — platform_milestones table.
--
-- Tracks each threat-ingestion milestone the platform has crossed
-- (400K, 500K, 750K, 1M, etc.) so the Home celebration banner can
-- surface the most recent unacknowledged one and the milestone
-- detector knows which crossings have already been notified.
--
-- The table is intentionally tiny — one row per milestone value.
-- INSERT OR IGNORE on first crossing; a row's existence is the
-- "we've fired this one" flag.
--
-- The banner uses per-device localStorage for dismissal (no
-- per-user server state needed); this table is the system-wide
-- record of milestones reached, replayable for the agent_runs
-- audit log and the announcements surface (future).

CREATE TABLE IF NOT EXISTS platform_milestones (
  value      INTEGER PRIMARY KEY,            -- e.g. 400000, 500000, 1000000
  metric     TEXT NOT NULL DEFAULT 'threats_ingested',
  fired_at   TEXT NOT NULL DEFAULT (datetime('now')),
  agent_run_id TEXT,                          -- agent_runs.id that observed the crossing
  notes      TEXT
);

CREATE INDEX IF NOT EXISTS idx_milestones_metric_fired
  ON platform_milestones(metric, fired_at DESC);
