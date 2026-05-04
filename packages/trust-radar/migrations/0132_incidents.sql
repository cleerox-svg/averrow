-- ─── Incidents (v1) ────────────────────────────────────────────────
--
-- Durable record of platform disruptions. Auto-created when a
-- critical platform_* notification fires (lib/notifications.ts hook
-- in this same migration's accompanying code). Operator-promotable
-- to public visibility, where they appear on the /status page banner
-- and recent-incidents list.
--
-- Visibility model (per planning thread):
--   internal — auto-created default. Only super_admins see it.
--   public   — operator promoted; appears on /status with the
--              public_title + public_details fields (NOT the raw
--              notification title, which may leak internals).
--
-- Schema is intentionally light for v1 — no postmortem template,
-- no SLA fields, no escalation policies. Add when needed.

CREATE TABLE incidents (
  id              TEXT PRIMARY KEY,

  -- Internal title (= source notification title for auto-created).
  title           TEXT NOT NULL,
  description     TEXT,

  -- Public-safe copy. NULL means "internal only — never show on
  -- /status even if visibility flips to public". Operator must
  -- write these to promote. Length-limited at the app layer
  -- (200/2000 chars) so we don't accidentally publish a stack
  -- trace. CHECK enforces a soft ceiling here too.
  public_title    TEXT CHECK (public_title IS NULL OR length(public_title) <= 200),
  public_details  TEXT CHECK (public_details IS NULL OR length(public_details) <= 2000),

  -- Lifecycle. 'postmortem' is reserved for a future phase; we
  -- accept it now so a future migration doesn't have to widen the
  -- CHECK constraint via the dance migration 0127/0128 used.
  status          TEXT NOT NULL DEFAULT 'investigating'
                  CHECK (status IN ('investigating','identified','monitoring','resolved','postmortem')),

  -- Aligned with notification severity.
  severity        TEXT NOT NULL DEFAULT 'high'
                  CHECK (severity IN ('critical','high','medium','low','info')),

  visibility      TEXT NOT NULL DEFAULT 'internal'
                  CHECK (visibility IN ('internal','public')),

  -- JSON array of component slugs:
  --   "feed:urlhaus" | "agent:cartographer" | "category:feeds" |
  --   "category:agents" | "category:processing" | "system:d1"
  -- Free-form so we don't have to migrate when new surfaces emerge.
  -- Validated at the app layer.
  affected_components TEXT,

  -- Lifecycle timestamps. detected_at = when the symptom first
  -- appeared in telemetry (may predate created_at when an operator
  -- back-dates an incident). resolved_at lets us compute MTTR
  -- without scanning incident_updates.
  detected_at      TEXT,
  acknowledged_at  TEXT,
  resolved_at      TEXT,

  created_by       TEXT REFERENCES users(id),
  lead_user_id     TEXT REFERENCES users(id),

  -- Provenance. 'manual' = operator-created. 'auto:<type>' = the
  -- auto-creation hook fired this incident from a notification.
  source           TEXT NOT NULL DEFAULT 'manual',
  source_notification_id TEXT,
  -- group_key of the triggering notification (notifications.group_key
  -- is shared across all recipients of the same event). This is the
  -- dedup key — re-firing notifications with the same group_key
  -- attach as system updates instead of creating new incidents.
  source_group_key TEXT,

  root_cause       TEXT,
  mitigation       TEXT,

  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Inbox query: list open incidents, severity-sorted.
CREATE INDEX idx_incidents_status_created
  ON incidents (status, created_at DESC);

-- Public status page: only resolved-or-active rows with visibility=public.
CREATE INDEX idx_incidents_public
  ON incidents (visibility, status, created_at DESC)
  WHERE visibility = 'public';

-- Auto-creation dedup: look up existing OPEN incidents by their
-- source notification group_key. Partial index keeps it tight.
CREATE INDEX idx_incidents_source_group_open
  ON incidents (source_group_key)
  WHERE status != 'resolved';

CREATE INDEX idx_incidents_source_notification
  ON incidents (source_notification_id);


-- ─── Incident updates (timeline) ─────────────────────────────────
--
-- Two row sources land here:
--   - Operator messages (created_by = userId, kind='operator')
--   - System events synthesized from platform_* notifications,
--     agent_runs failures, feed_pull_history rows (kind='system')
--
-- Status transitions are recorded as a row with status set to the
-- new state (so the timeline shows when each transition happened).
-- A pure comment leaves status NULL.

CREATE TABLE incident_updates (
  id              TEXT PRIMARY KEY,
  incident_id     TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,

  -- 'operator' = human-written. 'system' = auto-pulled telemetry.
  -- This lets the timeline UI render the two streams differently
  -- without parsing the message.
  kind            TEXT NOT NULL DEFAULT 'operator'
                  CHECK (kind IN ('operator','system')),

  -- If non-NULL, this update transitioned the incident's status.
  status          TEXT
                  CHECK (status IS NULL OR status IN ('investigating','identified','monitoring','resolved','postmortem')),

  message         TEXT NOT NULL,

  -- visibility=public messages render on /status; internal-only
  -- stays in the admin UI. Operators can flip visibility per-update
  -- so internal debugging notes don't leak to customers.
  visibility      TEXT NOT NULL DEFAULT 'internal'
                  CHECK (visibility IN ('internal','public')),

  -- For system updates: the underlying event id (notification_id,
  -- agent_run id, feed_pull_history id, etc.) so the UI can deep-link.
  event_ref       TEXT,
  event_type      TEXT,  -- 'platform_notification' | 'agent_run' | 'feed_pull' | 'status_transition'

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT REFERENCES users(id)
);

CREATE INDEX idx_incident_updates_incident
  ON incident_updates (incident_id, created_at ASC);
