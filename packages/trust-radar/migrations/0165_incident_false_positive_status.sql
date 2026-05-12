-- 0165_incident_false_positive_status.sql
-- Adds 'false_positive' to the incidents.status enum so operators can
-- close an incident as confirmed-not-real without it being treated like
-- a resolved incident on the public status page. Same treatment for
-- the incident_updates.status transition column.
--
-- Operator request 2026-05-12: a flapping signal or noisy notification
-- can fire an incident; once confirmed false, today the only escape is
-- to mark it 'resolved' — which puts it on the public status page's
-- "Recent Incidents" list as if a real outage occurred and was fixed.
--
-- The new status:
--   - Behaves like 'resolved' for lifecycle purposes (sets resolved_at)
--   - Is excluded from the public status page filter (lib/incidents.ts)
--   - Still visible internally for audit
--
-- SQLite forbids ALTER TABLE … MODIFY CHECK, so we recreate both tables
-- with the new constraint. Pattern matches migration 0061 (the
-- agent_outputs CHECK widening).

-- ─── incidents ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS incidents_v2 (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT,
  public_title      TEXT,
  public_details    TEXT,
  status            TEXT NOT NULL DEFAULT 'investigating'
                    CHECK (status IN ('investigating','identified','monitoring','resolved','postmortem','false_positive')),
  severity          TEXT NOT NULL DEFAULT 'high'
                    CHECK (severity IN ('critical','high','medium','low','info')),
  visibility        TEXT NOT NULL DEFAULT 'internal'
                    CHECK (visibility IN ('internal','public')),
  affected_components TEXT,
  detected_at       TEXT,
  acknowledged_at   TEXT,
  resolved_at       TEXT,
  created_by        TEXT REFERENCES users(id),
  lead_user_id      TEXT REFERENCES users(id),
  source            TEXT NOT NULL DEFAULT 'manual',
  source_notification_id TEXT,
  source_group_key  TEXT,
  root_cause        TEXT,
  mitigation        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO incidents_v2 SELECT * FROM incidents;

DROP TABLE incidents;

ALTER TABLE incidents_v2 RENAME TO incidents;

CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_visibility ON incidents(visibility, status)
  WHERE status != 'resolved';
CREATE INDEX IF NOT EXISTS idx_incidents_source_group ON incidents(source_group_key)
  WHERE source_group_key IS NOT NULL;

-- ─── incident_updates ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS incident_updates_v2 (
  id              TEXT PRIMARY KEY,
  incident_id     TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL
                  CHECK (kind IN ('operator','system')),
  status          TEXT
                  CHECK (status IS NULL OR status IN ('investigating','identified','monitoring','resolved','postmortem','false_positive')),
  message         TEXT NOT NULL,
  public_message  TEXT,
  visibility      TEXT NOT NULL DEFAULT 'internal'
                  CHECK (visibility IN ('internal','public')),
  event_ref       TEXT,
  event_type      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT REFERENCES users(id)
);

INSERT OR IGNORE INTO incident_updates_v2 SELECT * FROM incident_updates;

DROP TABLE incident_updates;

ALTER TABLE incident_updates_v2 RENAME TO incident_updates;

CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates(incident_id, created_at DESC);
