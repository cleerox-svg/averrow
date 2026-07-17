-- ─── Extend `alerts.alert_type` CHECK to cover all production types
--
-- Migration 0121 added a CHECK constraint on alert_type using a
-- 9-key whitelist. After it shipped we discovered `lib/alerts.ts`
-- declares 5 additional alert types that are actively written by
-- the email-security and lookalike scanners + sparrow:
--
--   bimi_removed
--   dmarc_downgraded
--   vmc_expiring
--   typosquat_bimi
--   takedown_resurrected
--
-- Inserts of those types between 0121 deploy and now have been
-- silently rejected by the CHECK constraint (callers wrap in
-- try/catch). This migration extends the CHECK to include them.
--
-- SQLite still can't ALTER a CHECK in place — same temp-table-swap
-- pattern as 0121.

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

-- Belt-and-braces lowercase severity in case any uppercase rows
-- snuck back in between 0120 and now (the createAlert helper now
-- lowercases defensively but legacy direct INSERTs in some paths
-- might still slip through).
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
