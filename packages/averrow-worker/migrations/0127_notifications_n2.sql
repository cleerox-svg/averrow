-- ─── Notifications N2 — schema + state machine migration ─────────────
--
-- Three changes from NOTIFICATIONS_AUDIT.md §10:
--
-- 1. Recreate `notifications` with new columns (brand_id, org_id,
--    audience, state machine, group_key, reason_text,
--    recommended_action) and a wider type CHECK that admits the
--    intel_*, platform_* and notification_digest families coming in
--    N6.
-- 2. New `notification_subscriptions` table — per-user × per-brand
--    watch level, auto-seeded from `monitored_brands`.
-- 3. New `notification_preferences_v2` — per-channel severity floors,
--    digest mode, quiet hours, super_admin opt-in. Auto-seeded for
--    every active user.
--
-- Migration is non-breaking. N1 code keeps working through the
-- rename — read_at + metadata columns preserved with original names
-- and types. New columns are nullable / default-bearing. The legacy
-- `notification_preferences` table stays in place (read-only) until
-- N5 rebuilds the settings UI; this avoids a UI/backend cutover race.
--
-- See §10.6 for migration timing across N3/N4/N5.

-- ─── 1. notifications (recreated) ────────────────────────────────────

CREATE TABLE notifications_new (
  -- Identity
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Tenant scoping (Q3 + §4)
  brand_id        TEXT,
  org_id          TEXT,
  audience        TEXT NOT NULL DEFAULT 'tenant'
                  CHECK (audience IN ('tenant','super_admin','team','all')),

  -- Type + severity (CHECK widened — see §11/§13)
  type            TEXT NOT NULL CHECK (type IN (
                    -- existing user-toggleable
                    'brand_threat','campaign_escalation','feed_health',
                    'intelligence_digest','agent_milestone',
                    -- existing system events
                    'email_security_change','circuit_breaker_tripped',
                    -- new in N6 — AI intel family
                    'intel_predictive','intel_cross_brand_pattern',
                    'intel_sector_trend','intel_recommended_action',
                    'intel_threat_actor_surface',
                    -- new in N6 — platform-health family
                    'platform_d1_budget_warn','platform_d1_budget_breach',
                    'platform_kv_budget_warn',
                    'platform_worker_cpu_burst',
                    'platform_feed_at_risk','platform_feed_auto_paused',
                    'platform_agent_stalled',
                    'platform_cron_orchestrator_missed',
                    'platform_cron_navigator_missed',
                    'platform_enrichment_stuck_pile',
                    'platform_ai_spend_burst',
                    'platform_resend_bounces',
                    -- digest envelope
                    'notification_digest'
                  )),
  severity        TEXT NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('critical','high','medium','low','info')),

  -- Content (Q5 — static templates)
  title              TEXT NOT NULL,
  message            TEXT NOT NULL,
  reason_text        TEXT,
  recommended_action TEXT,
  link               TEXT,

  -- State machine (Q1 — §7.1)
  state           TEXT NOT NULL DEFAULT 'unread'
                  CHECK (state IN ('unread','read','snoozed','done')),
  read_at         TEXT,
  snoozed_until   TEXT,
  done_at         TEXT,

  -- Grouping (§7.5)
  group_key       TEXT,

  -- Forensics
  metadata        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Backfill from existing notifications. The original column set is:
-- id, user_id, type, severity, title, message, link, read_at, created_at, metadata
-- (per migration 0107). All preserved verbatim; new columns derived.
INSERT INTO notifications_new (
  id, user_id, brand_id, org_id, audience, type, severity,
  title, message, reason_text, recommended_action, link,
  state, read_at, group_key, metadata, created_at, updated_at
)
SELECT
  n.id,
  n.user_id,
  json_extract(n.metadata, '$.brand_id') AS brand_id,
  ob.org_id,
  'tenant' AS audience,
  n.type,
  n.severity,
  n.title,
  n.message,
  NULL AS reason_text,
  NULL AS recommended_action,
  n.link,
  CASE WHEN n.read_at IS NULL THEN 'unread' ELSE 'read' END AS state,
  n.read_at,
  CASE
    WHEN json_extract(n.metadata, '$.brand_id') IS NOT NULL
      THEN n.type || ':' || json_extract(n.metadata, '$.brand_id')
    ELSE n.type
  END AS group_key,
  n.metadata,
  n.created_at,
  n.created_at AS updated_at
FROM notifications n
LEFT JOIN org_brands ob
  ON ob.brand_id = json_extract(n.metadata, '$.brand_id');

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

-- Indexes (§10.5 — partial indexes keep size small)
CREATE INDEX idx_notifications_inbox    ON notifications(user_id, state, created_at DESC);
CREATE INDEX idx_notifications_brand    ON notifications(brand_id, created_at DESC);
CREATE INDEX idx_notifications_audience ON notifications(audience, created_at DESC);
CREATE INDEX idx_notifications_group    ON notifications(user_id, group_key, created_at DESC);
CREATE INDEX idx_notifications_unread   ON notifications(user_id) WHERE state = 'unread';
CREATE INDEX idx_notifications_snoozed  ON notifications(user_id, snoozed_until) WHERE state = 'snoozed';

-- ─── 2. notification_subscriptions (new) ─────────────────────────────

CREATE TABLE IF NOT EXISTS notification_subscriptions (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id        TEXT NOT NULL,
  level           TEXT NOT NULL DEFAULT 'default'
                  CHECK (level IN ('watching','default','ignored')),
  snoozed_until   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (user_id, brand_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON notification_subscriptions(user_id);

-- Auto-seed from monitored_brands. `added_by` is the user who added
-- the watch; default level mirrors the tenant default in §6.2.
INSERT INTO notification_subscriptions (user_id, brand_id, level)
SELECT mb.added_by AS user_id, mb.brand_id, 'default'
FROM monitored_brands mb
WHERE mb.added_by IS NOT NULL
ON CONFLICT (user_id, brand_id) DO NOTHING;

-- ─── 3. notification_preferences_v2 (new) ────────────────────────────

CREATE TABLE IF NOT EXISTS notification_preferences_v2 (
  user_id                       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Severity floors per channel (Q8 + §7.3)
  inapp_severity_floor          TEXT NOT NULL DEFAULT 'info'
                                CHECK (inapp_severity_floor IN ('critical','high','medium','low','info')),
  push_severity_floor           TEXT NOT NULL DEFAULT 'high'
                                CHECK (push_severity_floor IN ('critical','high','medium','low','info','off')),
  email_severity_floor          TEXT NOT NULL DEFAULT 'high'
                                CHECK (email_severity_floor IN ('critical','high','medium','low','info','off')),

  -- Digest mode (Q8 + §7.8)
  digest_mode                   TEXT NOT NULL DEFAULT 'daily'
                                CHECK (digest_mode IN ('realtime','hourly','daily','weekly','off')),
  digest_severity_floor         TEXT NOT NULL DEFAULT 'medium'
                                CHECK (digest_severity_floor IN ('high','medium','low','info')),

  -- Quiet hours
  quiet_hours_start             TEXT,
  quiet_hours_end               TEXT,
  quiet_hours_timezone          TEXT NOT NULL DEFAULT 'UTC',
  critical_bypasses_quiet       INTEGER NOT NULL DEFAULT 1,

  -- Super_admin opt-in (Q3)
  show_tenant_notifications     INTEGER NOT NULL DEFAULT 0,

  updated_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Auto-seed for active users. Defaults map to §7 redesign principles.
INSERT INTO notification_preferences_v2 (user_id)
SELECT id FROM users WHERE status = 'active'
ON CONFLICT (user_id) DO NOTHING;
