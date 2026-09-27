-- Migration 0265: Re-sync notifications.type CHECK with the event registry
--
-- Three keys in packages/shared/src/notification-events.ts were never added
-- to the CHECK, so createNotification's INSERT was rejected (and swallowed)
-- every time they fired:
--
--   platform_spam_trap_capture_stale    — Flight Control's 14-day "no spam
--   platform_spam_trap_seeding_stalled    trap captures" / planter guards,
--                                         added after the June drought.
--                                         Captures then stopped on
--                                         2026-07-17 and the alert fired
--                                         into the void for ~10 weeks.
--   takedown_awaiting_approval          — Sparrow's approval-queue nudge.
--
-- Same drift class 0207 and 0215 each re-synced by hand; the test
-- notification-check-drift.test.ts now fails CI when it recurs.
--
-- SQLite can't ALTER a CHECK, so this is the 0215 recreate dance with one
-- addition: notification_deliveries is backed up and restored around the
-- swap (see comment at the DROP).

PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS notifications_0265;
DROP TABLE IF EXISTS notification_deliveries_bak_0265;

CREATE TABLE notifications_0265 (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  brand_id        TEXT,
  org_id          TEXT,
  audience        TEXT NOT NULL DEFAULT 'tenant'
                  CHECK (audience IN ('tenant','super_admin','team','all')),

  type            TEXT NOT NULL CHECK (type IN (
                    'brand_threat','campaign_escalation','feed_health',
                    'intelligence_digest','agent_milestone',
                    'email_security_change','circuit_breaker_tripped',
                    'intel_predictive','intel_cross_brand_pattern',
                    'intel_sector_trend','intel_recommended_action',
                    'intel_threat_actor_surface',
                    'platform_d1_budget_warn','platform_d1_budget_breach',
                    'platform_kv_budget_warn',
                    'platform_worker_cpu_burst',
                    'platform_feed_at_risk','platform_feed_auto_paused',
                    'platform_feed_silent','platform_provider_escalation',
                    'platform_agent_stalled',
                    'platform_geoip_refresh_stalled',
                    'platform_workflow_dispatch_silent',
                    'platform_cron_orchestrator_missed',
                    'platform_cron_navigator_missed',
                    'platform_enrichment_stuck_pile',
                    'platform_dns_queue_drift',
                    'platform_dns_queue_stalled',
                    'platform_dns_queue_reaper_stalled',
                    'platform_abuse_classifier_silent',
                    'platform_ai_spend_burst',
                    'platform_resend_bounces',
                    'platform_briefing_silent',
                    'platform_dmarc_ramp_reminder',
                    'platform_d1_writes_phase2_review',
                    'abuse_mailbox_verdict',
                    'abuse_mailbox_flood_detected',
                    'named_threat_identified',
                    'takedown_monthly_cap_reached',
                    'new_lead',
                    'takedown_awaiting_approval',          -- re-synced (never widened)
                    'platform_spam_trap_seeding_stalled',  -- re-synced (never widened)
                    'platform_spam_trap_capture_stale',    -- re-synced (never widened)
                    'notification_digest'
                  )),
  severity        TEXT NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('critical','high','medium','low','info')),

  title              TEXT NOT NULL,
  message            TEXT NOT NULL,
  reason_text        TEXT,
  recommended_action TEXT,
  link               TEXT,

  state           TEXT NOT NULL DEFAULT 'unread'
                  CHECK (state IN ('unread','read','snoozed','done')),
  read_at         TEXT,
  snoozed_until   TEXT,
  done_at         TEXT,

  group_key       TEXT,

  metadata        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO notifications_0265
SELECT * FROM notifications;

-- D1 enforces FKs, and DROP TABLE runs an implicit DELETE that fires
-- notification_deliveries' ON DELETE CASCADE — deferral does not stop it
-- (verified against SQLite 3.45). 0215 used this same swap without a
-- backup: it applied at 2026-06-15 14:46:48 and the oldest surviving
-- delivery row in prod is 14:51:35 that day, although the table has
-- existed since 0131 (2026-05-04). Snapshot it
-- first and restore it after the rename; notification ids are unchanged,
-- so every restored row still satisfies its FK.
CREATE TABLE notification_deliveries_bak_0265 AS SELECT * FROM notification_deliveries;

DROP TABLE notifications;
ALTER TABLE notifications_0265 RENAME TO notifications;

INSERT OR IGNORE INTO notification_deliveries SELECT * FROM notification_deliveries_bak_0265;
DROP TABLE notification_deliveries_bak_0265;

CREATE INDEX IF NOT EXISTS idx_notifications_inbox    ON notifications(user_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_brand    ON notifications(brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_audience ON notifications(audience, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_group    ON notifications(user_id, group_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread   ON notifications(user_id) WHERE state = 'unread';
CREATE INDEX IF NOT EXISTS idx_notifications_snoozed  ON notifications(user_id, snoozed_until) WHERE state = 'snoozed';

PRAGMA defer_foreign_keys = OFF;
