-- Migration 0274: Re-sync notifications.type CHECK — add platform_abuse_mailbox_inbound_stale
--
-- Flight Control's new abuse-mailbox inbound freshness guard emits
-- platform_abuse_mailbox_inbound_stale when abuse_inbox_messages has had
-- no arrival in >7 days. It exists because abuse@/phishing@averrow.ca
-- bounced every sender ("550 5.1.1 Address does not exist") from
-- 2026-07-17 — the Worker rename unbound the Email Routing rules — and
-- nothing alerted. Without this migration the INSERT is rejected by the
-- CHECK and Flight Control's try/catch swallows it: the alert for a silent
-- failure would itself fail silently (see 0265 / 0272 for the same trap).
--
-- Fifth hand re-sync of this CHECK (0207, 0215, 0265, 0272, 0274). This is
-- 0272's swap verbatim — same column list (nothing between 0272 and here
-- touches notifications, so SELECT * is shape-identical), same
-- notification_deliveries snapshot/restore around the DROP (the
-- ON DELETE CASCADE wipes it otherwise), same seven indexes including
-- idx_notifications_dedup. The ONE functional delta is the added literal.
-- test/notification-check-drift.test.ts pins all three invariants.

PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS notifications_0274;
DROP TABLE IF EXISTS notification_deliveries_bak_0274;

CREATE TABLE notifications_0274 (
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
                    'platform_ai_calls_failing',
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
                    'takedown_awaiting_approval',
                    'platform_spam_trap_seeding_stalled',
                    'platform_spam_trap_capture_stale',
                    'platform_abuse_mailbox_inbound_stale', -- added by 0274
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

INSERT INTO notifications_0274
SELECT * FROM notifications;

-- D1 enforces FKs, and DROP TABLE runs an implicit DELETE that fires
-- notification_deliveries' ON DELETE CASCADE — deferral does not stop it
-- (verified against SQLite 3.45). 0215 used this same swap without a
-- backup and silently wiped every delivery row predating it: it applied at
-- 2026-06-15 14:46:48 and the oldest surviving delivery row in prod is
-- 14:51:35 that day, although the table has existed since 0131
-- (2026-05-04). Snapshot it first and restore it after the rename;
-- notification ids are unchanged, so every restored row still satisfies
-- its FK. The restore is INSERT OR IGNORE so re-running this migration
-- against an already-swapped table is a no-op rather than a PK conflict.
CREATE TABLE notification_deliveries_bak_0274 AS SELECT * FROM notification_deliveries;

DROP TABLE notifications;
ALTER TABLE notifications_0274 RENAME TO notifications;

INSERT OR IGNORE INTO notification_deliveries SELECT * FROM notification_deliveries_bak_0274;
DROP TABLE notification_deliveries_bak_0274;

CREATE INDEX IF NOT EXISTS idx_notifications_inbox    ON notifications(user_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_brand    ON notifications(brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_audience ON notifications(audience, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_group    ON notifications(user_id, group_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread   ON notifications(user_id) WHERE state = 'unread';
CREATE INDEX IF NOT EXISTS idx_notifications_snoozed  ON notifications(user_id, snoozed_until) WHERE state = 'snoozed';
-- Must be recreated by every rebuild (0272 restored it after 0186 lost it);
-- without it every createNotification call full-scans this table.
CREATE INDEX IF NOT EXISTS idx_notifications_dedup    ON notifications(type, group_key, created_at DESC);

PRAGMA defer_foreign_keys = OFF;
