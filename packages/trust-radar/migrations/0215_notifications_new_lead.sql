-- Migration 0215: Widen notifications.type CHECK for 'new_lead'
--
-- Adds the staff-facing sales/CRM notification fired when a visitor
-- submits the public domain-scan lead form (handleLeadCapture →
-- scan_leads). Registered in packages/shared/src/notification-events.ts.
--
-- SQLite can't ALTER a CHECK constraint, so we use the same recreate
-- dance as 0107 / 0128 / 0186 / 0207. As in 0207, this also re-syncs the
-- CHECK list with the shared NotificationEventKey union: since 0207,
-- 'takedown_monthly_cap_reached' was added to the union without a
-- matching CHECK widen, so its INSERTs were silently rejected (and
-- swallowed by the caller's try/catch). The list below is the complete
-- current union plus 'new_lead'. The swap is safe — read paths consult
-- column names, not constraint identity.

CREATE TABLE notifications_with_new_lead (
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
                    'takedown_monthly_cap_reached',    -- re-synced (gap since S1)
                    'new_lead',                        -- NEW
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

INSERT INTO notifications_with_new_lead
SELECT * FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_with_new_lead RENAME TO notifications;

CREATE INDEX idx_notifications_inbox    ON notifications(user_id, state, created_at DESC);
CREATE INDEX idx_notifications_brand    ON notifications(brand_id, created_at DESC);
CREATE INDEX idx_notifications_audience ON notifications(audience, created_at DESC);
CREATE INDEX idx_notifications_group    ON notifications(user_id, group_key, created_at DESC);
CREATE INDEX idx_notifications_unread   ON notifications(user_id) WHERE state = 'unread';
CREATE INDEX idx_notifications_snoozed  ON notifications(user_id, snoozed_until) WHERE state = 'snoozed';
