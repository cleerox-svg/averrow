-- 0192_alerts_extend_check_nx4_plus_campaigns.sql
--
-- NX4: extend alerts.alert_type CHECK + add brand_count_at_first_detection to campaigns.
--
-- Two new alert types ride the existing brand-signal pipeline:
--
--   campaign_impacts_brand
--     Fanout from the strategist when a campaign passes the
--     significance threshold (>=20 threats OR a 3x spike OR
--     >=10 brands at first detection). Per-brand row so the
--     tenant's Signals tab shows "your brand is in this campaign"
--     without forcing tenants to monitor the campaigns surface.
--
--   threat_actor_targeting_brand
--     Fanout when a known threat actor's target list includes a
--     monitored brand. Wired in NX6 (observer/nexus surface).
--     Reserved here so the CHECK constraint doesn't block early
--     producers from inserting once that surface lands.
--
-- Same temp-table-swap pattern as migration 0122 (SQLite can't
-- ALTER a CHECK constraint in place).
--
-- The campaigns table also gains brand_count_at_first_detection,
-- a snapshot of how many distinct brand_ids a campaign already
-- targets at creation time. Pure-additive ALTER — no rebuild
-- needed since campaigns has no CHECK constraint we're touching.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE alerts_new (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  alert_type TEXT NOT NULL CHECK (alert_type IN (
    'social_impersonation',
    'phishing_detected',
    'email_grade_change',
    'lookalike_domain_active',
    'ct_certificate_issued',
    'threat_feed_match',
    'dark_web_mention',
    'app_store_impersonation',
    'geopolitical_threat',
    'bimi_removed',
    'dmarc_downgraded',
    'vmc_expiring',
    'typosquat_bimi',
    'takedown_resurrected',
    'campaign_impacts_brand',
    'threat_actor_targeting_brand',
    'unknown'
  )),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN (
    'critical', 'high', 'medium', 'low'
  )),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT,
  source_type TEXT,
  source_id TEXT,
  ai_assessment TEXT,
  ai_recommendations TEXT,
  status TEXT DEFAULT 'new',
  acknowledged_at TEXT,
  resolved_at TEXT,
  resolution_notes TEXT,
  email_sent INTEGER DEFAULT 0,
  webhook_sent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO alerts_new
SELECT
  id, brand_id, user_id, alert_type,
  LOWER(severity) AS severity,
  title, summary, details, source_type, source_id,
  ai_assessment, ai_recommendations, status,
  acknowledged_at, resolved_at, resolution_notes,
  email_sent, webhook_sent, created_at, updated_at
FROM alerts;

DROP TABLE alerts;
ALTER TABLE alerts_new RENAME TO alerts;

CREATE INDEX IF NOT EXISTS idx_alerts_user_status ON alerts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_brand ON alerts(brand_id);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity) WHERE status = 'new';
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

PRAGMA defer_foreign_keys = OFF;

-- Campaigns: snapshot the brand-count-at-first-detection so the
-- significance rule can see the "wide net" branch without reading
-- threats again. threat_count_24h_ago stays computed-on-demand —
-- it's a moving target, not a snapshot.
ALTER TABLE campaigns ADD COLUMN brand_count_at_first_detection INTEGER NOT NULL DEFAULT 0;
