-- ─── Notifications N6c — widen type CHECK with platform_briefing_silent ─
--
-- Adds the self-monitoring "briefing didn't send" type per
-- NOTIFICATIONS_AUDIT.md §13 + N6c phase plan. Fires from Flight
-- Control at hour 14 if no successful threat_briefings row exists
-- for the last 36h.
--
-- SQLite doesn't support ALTER TABLE ... DROP CONSTRAINT, so
-- widening a CHECK requires the same recreate dance as 0127. The
-- table swap is safe — read paths only consult column names, not
-- constraint identity.

CREATE TABLE notifications_with_briefing_silent (
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
                    'platform_agent_stalled',
                    'platform_cron_orchestrator_missed',
                    'platform_cron_navigator_missed',
                    'platform_enrichment_stuck_pile',
                    'platform_ai_spend_burst',
                    'platform_resend_bounces',
                    'platform_briefing_silent',     -- NEW in N6c
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

INSERT INTO notifications_with_briefing_silent
SELECT * FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_with_briefing_silent RENAME TO notifications;

-- Recreate the indexes (identical to 0127).
CREATE INDEX idx_notifications_inbox    ON notifications(user_id, state, created_at DESC);
CREATE INDEX idx_notifications_brand    ON notifications(brand_id, created_at DESC);
CREATE INDEX idx_notifications_audience ON notifications(audience, created_at DESC);
CREATE INDEX idx_notifications_group    ON notifications(user_id, group_key, created_at DESC);
CREATE INDEX idx_notifications_unread   ON notifications(user_id) WHERE state = 'unread';
CREATE INDEX idx_notifications_snoozed  ON notifications(user_id, snoozed_until) WHERE state = 'snoozed';
