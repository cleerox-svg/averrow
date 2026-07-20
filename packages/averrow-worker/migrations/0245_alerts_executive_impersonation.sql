-- 0245_alerts_executive_impersonation.sql
--
-- Stage 2 of the executive social-impersonation feature: register the
-- `executive_impersonation` alert type at the DB level.
--
-- Extends the `alerts.alert_type` CHECK constraint to permit one new
-- key — `executive_impersonation` — so the executive-impersonation
-- scanner (stages 3-5) can insert rows. No other change: every
-- previously-allowed alert_type stays allowed, and the column set,
-- defaults, NOT NULLs and severity CHECK are preserved byte-for-byte.
--
-- SQLite can't ALTER a CHECK constraint in place, so this uses the
-- same temp-table-swap pattern as migrations 0121 / 0122 / 0192.
--
-- Schema baseline for the recreate:
--   * columns + CHECKs + defaults: migration 0192 (the last recreate)
--   * PLUS assigned_to / assigned_at: migration 0221 (additive columns
--     added after 0192; they MUST be carried into the new table)
--   * indexes: the same four from 0029 / 0121 / 0122 / 0192 — alerts
--     has no other indexes, no triggers, and no foreign keys (brand_id
--     and user_id are plain TEXT, no REFERENCES). Verified by grepping
--     every migration touching `alerts`.
--
-- Foreign-key checks are deferred for the swap so cascades from other
-- tables don't fire mid-recreation (matches 0121 / 0122 / 0192).

PRAGMA defer_foreign_keys = ON;

-- 1. Build the replacement table: identical to the current live schema
--    (0192 columns + 0221 assignee columns), with `executive_impersonation`
--    appended to the alert_type CHECK whitelist.
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
    'executive_impersonation',
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
  updated_at TEXT DEFAULT (datetime('now')),
  assigned_to TEXT,
  assigned_at TEXT
);

-- 2. Copy every row, every column. Severity is already lowercase
--    (0120); LOWER() folds any stragglers as belt-and-braces, matching
--    the prior recreates.
INSERT INTO alerts_new
SELECT
  id, brand_id, user_id, alert_type,
  LOWER(severity) AS severity,
  title, summary, details, source_type, source_id,
  ai_assessment, ai_recommendations, status,
  acknowledged_at, resolved_at, resolution_notes,
  email_sent, webhook_sent, created_at, updated_at,
  assigned_to, assigned_at
FROM alerts;

-- 3. Swap.
DROP TABLE alerts;
ALTER TABLE alerts_new RENAME TO alerts;

-- 4. Recreate all four indexes (0029 baseline, carried through every
--    recreate). alerts has no triggers and no FKs to recreate.
CREATE INDEX IF NOT EXISTS idx_alerts_user_status ON alerts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_brand ON alerts(brand_id);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity) WHERE status = 'new';
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

PRAGMA defer_foreign_keys = OFF;
