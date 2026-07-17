-- ─── Recreate `alerts` with CHECK constraints on alert_type + severity
--
-- Background: `alerts.alert_type` was a free TEXT column with no
-- enum or whitelist. Anything could be inserted, including typos
-- ("phising_detected") that silently rotted in the database — the
-- same bug pattern that made `circuit_breaker_tripped` and
-- `email_security_change` notifications silently drop in production
-- before migration 0107 fixed the notifications side.
--
-- This migration brings alerts to the same level of safety:
--
--   1. CHECK on alert_type — whitelist matches @averrow/shared
--      ALERT_TYPES registry. Any insert with an unknown type is
--      rejected at the DB level. The 'unknown' entry is kept as a
--      legacy bucket so historical pre-registry rows don't fail
--      the new constraint.
--
--   2. CHECK on severity — lowercase 4-level enum
--      ('critical' | 'high' | 'medium' | 'low'). Migration 0120
--      lowercased existing rows; this constraint enforces it
--      going forward. Notifications use 5 levels (with 'info');
--      alerts deliberately don't — incidents either need attention
--      or they don't, and "info" alerts route through notifications.
--
-- Pre-flight: any row whose alert_type isn't in the registry is
-- bucketed to 'unknown' so the new CHECK passes. We don't drop
-- legacy rows.
--
-- SQLite can't ALTER a CHECK in place; the only safe way is the
-- temp-table-swap pattern (same as 0107 used for notifications).
-- Foreign-key checks are disabled for the swap so cascades from
-- users / brands don't trigger mid-recreation.

PRAGMA defer_foreign_keys = ON;

-- 1. Pre-bucket any unknown alert_type values to 'unknown' so the
--    new CHECK passes. Limited to types NOT in the registry.
UPDATE alerts SET alert_type = 'unknown'
  WHERE alert_type NOT IN (
    'social_impersonation',
    'phishing_detected',
    'email_grade_change',
    'lookalike_domain_active',
    'ct_certificate_issued',
    'threat_feed_match',
    'dark_web_mention',
    'app_store_impersonation',
    'geopolitical_threat',
    'unknown'
  );

-- 2. Build the replacement table with the new constraints.
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

-- 3. Copy all rows. Severity was already lowercased in 0120; if any
--    upper-case stragglers slipped in between 0120 and now, fold
--    them down here too as belt-and-braces.
INSERT INTO alerts_new
SELECT
  id, brand_id, user_id, alert_type,
  LOWER(severity) AS severity,
  title, summary, details, source_type, source_id,
  ai_assessment, ai_recommendations, status,
  acknowledged_at, resolved_at, resolution_notes,
  email_sent, webhook_sent, created_at, updated_at
FROM alerts;

-- 4. Swap.
DROP TABLE alerts;
ALTER TABLE alerts_new RENAME TO alerts;

-- 5. Recreate indexes from 0029_alerts.sql.
CREATE INDEX IF NOT EXISTS idx_alerts_user_status ON alerts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_brand ON alerts(brand_id);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity) WHERE status = 'new';
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

PRAGMA defer_foreign_keys = OFF;
