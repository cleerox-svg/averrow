-- Migration 0272: Re-sync notifications.type CHECK — add platform_ai_calls_failing
--
-- One key in packages/shared/src/notification-events.ts is not in the
-- CHECK, so createNotification's INSERT is rejected every time it fires:
--
--   platform_ai_calls_failing           — Flight Control's new silent-AI-
--                                         failure guard. Emits when
--                                         budget_ledger has been silent
--                                         past 2h AND a recent agent run
--                                         recorded aiCallsAttempted > 0
--                                         with aiCallsSucceeded = 0.
--
-- Why this matters more than usual here: the alert being widened in exists
-- BECAUSE the platform ran ~3 months with zero working AI and nothing
-- alerted (last budget_ledger row 2026-07-10 11:10:20 UTC; an unpaid
-- Anthropic balance returned HTTP 400 on every call). Without this
-- migration the fix reproduces its own defect — the INSERT throws, Flight
-- Control's mandatory try/catch swallows it, and the alert for the silent
-- failure fails silently.
--
-- This is the FOURTH hand re-sync of this CHECK (0207, 0215, 0265, 0272).
-- The structural cause is that the DB allowlist duplicates
-- KNOWN_EVENT_KEYS (lib/notifications.ts:39), which is already derived
-- from the shared registry — so the registry and the CHECK can disagree.
-- Whether to drop the CHECK and let the registry be the single source of
-- truth is a schema decision carried separately; this migration only
-- widens. The test notification-check-drift.test.ts fails CI when the
-- drift recurs.
--
-- SQLite can't ALTER a CHECK, so this is 0265's recreate dance verbatim:
-- same column list (no migration between 0265 and here touches
-- notifications, so SELECT * is shape-identical and loses no column), same
-- notification_deliveries snapshot/restore around the swap, same six
-- indexes. The ONE functional delta is the added type literal; every key
-- 0265 allowed is carried over unchanged.
--
-- No triggers are recreated because notifications has never had one
-- (verified across all migrations). On indexes, this migration is NOT a
-- pure copy of 0265's set — one is restored and two stay dropped:
--
--   RESTORED: idx_notifications_dedup (type, group_key, created_at DESC).
--     Created once, in 0167, and never recreated by 0186 / 0207 / 0215 /
--     0265 — so it has been GONE since 0186 while the comment in 0167
--     still documents the ~12M reads/day it was added to save. Both hot
--     dedup paths need it and neither can use any of the six surviving
--     indexes, because all of them lead with user_id while a
--     platform-wide dedup lookup has group_key set and user_id NULL:
--       lib/notifications.ts  — SELECT 1 ... WHERE type=? AND group_key=?
--                               AND created_at > ? ORDER BY created_at DESC
--       lib/platform-templates.ts — SELECT id ... WHERE type=? AND
--                               group_key=? ORDER BY created_at DESC
--     Every createNotification call runs one of them, so the whole
--     notification surface has been paying a full table scan per emit.
--     That includes this migration's own new alert.
--
--   STILL DROPPED: idx_notifications_user (user_id, read_at) and
--     idx_notifications_created (created_at). Last defined in 0107 and
--     absent since the 0207/0215 swaps. Unlike the dedup index these have
--     no uncovered call site: the schema moved from read_at to a `state`
--     column, and idx_notifications_inbox (user_id, state, created_at DESC)
--     serves the inbox reads that idx_notifications_user was built for.
--     Reviving them would add write cost for no read.

PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS notifications_0272;
DROP TABLE IF EXISTS notification_deliveries_bak_0272;

CREATE TABLE notifications_0272 (
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
                    'platform_ai_calls_failing',            -- added by 0272
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

INSERT INTO notifications_0272
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
CREATE TABLE notification_deliveries_bak_0272 AS SELECT * FROM notification_deliveries;

DROP TABLE notifications;
ALTER TABLE notifications_0272 RENAME TO notifications;

INSERT OR IGNORE INTO notification_deliveries SELECT * FROM notification_deliveries_bak_0272;
DROP TABLE notification_deliveries_bak_0272;

CREATE INDEX IF NOT EXISTS idx_notifications_inbox    ON notifications(user_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_brand    ON notifications(brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_audience ON notifications(audience, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_group    ON notifications(user_id, group_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread   ON notifications(user_id) WHERE state = 'unread';
CREATE INDEX IF NOT EXISTS idx_notifications_snoozed  ON notifications(user_id, snoozed_until) WHERE state = 'snoozed';
-- Restored here after being dropped by 0186 — see the header. Without it
-- every createNotification call full-scans this table.
CREATE INDEX IF NOT EXISTS idx_notifications_dedup    ON notifications(type, group_key, created_at DESC);

PRAGMA defer_foreign_keys = OFF;
