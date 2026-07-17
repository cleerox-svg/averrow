-- Migration 0139 — recreate platform_milestones with composite PK.
--
-- 0138 set the PK to `value` alone, which means 400000 can only ever
-- fire under one metric. We track two metrics in parallel:
--
--   * threats_ingested  — COUNT(*) FROM threats. Active rows in the
--                         threats table; can dip if rows are resolved.
--   * total_ingested    — SUM(records_ingested) FROM feed_pull_history.
--                         Lifetime feed pull volume; only goes up.
--
-- Both should be able to fire the same threshold (e.g. 1,000,000)
-- independently. Composite PK (metric, value) makes that possible
-- while still preventing duplicate fires of the same milestone within
-- a metric.
--
-- SQLite can't ALTER the PK in place, so the migration:
--   1. Creates platform_milestones_new with the composite PK.
--   2. Copies any existing rows (one row from 0138 — the 100K
--      threats_ingested fire — gets carried over).
--   3. Drops the old table; renames the new one into place.
--   4. Recreates the supporting index.

CREATE TABLE platform_milestones_new (
  metric       TEXT NOT NULL DEFAULT 'threats_ingested',
  value        INTEGER NOT NULL,
  fired_at     TEXT NOT NULL DEFAULT (datetime('now')),
  agent_run_id TEXT,
  notes        TEXT,
  PRIMARY KEY (metric, value)
);

INSERT INTO platform_milestones_new (metric, value, fired_at, agent_run_id, notes)
SELECT metric, value, fired_at, agent_run_id, notes
  FROM platform_milestones;

DROP TABLE platform_milestones;
ALTER TABLE platform_milestones_new RENAME TO platform_milestones;

CREATE INDEX IF NOT EXISTS idx_milestones_metric_fired
  ON platform_milestones(metric, fired_at DESC);
