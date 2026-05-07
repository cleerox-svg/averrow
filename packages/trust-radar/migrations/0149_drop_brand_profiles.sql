-- 0149_drop_brand_profiles.sql
-- R4 (final step) of the brand_profiles deprecation. First-attempt
-- failed in CI with FOREIGN KEY constraint failed because two
-- tables still declared `REFERENCES brand_profiles(id)`:
--   - social_monitor_results (28 rows, brand_id → dead bp.id)
--   - social_monitor_schedule (0 rows)
--
-- SQLite doesn't have ALTER TABLE DROP CONSTRAINT, so we use the
-- recreate-table pattern: create a sibling without the FK, copy
-- rows over, drop the original, rename the sibling, recreate the
-- indexes. D1 doesn't persist TEMP tables across statements, so
-- the sibling lives as a regular table and we DROP IF EXISTS for
-- idempotency.
--
-- Per `docs/v3/BRAND_PROFILES_DEPRECATION.md`:
--   R1, R2, R3, R5 → PR #1105
--   R6, R7, R8, R9 → PR #1108
--   R4             → this migration
--
-- Production state at write time (2026-05-07):
--   - brand_profiles: 1 row, "Trust Radar" test profile
--   - social_monitor_results: 28 rows, all referencing the dead
--     brand_profile.id (visible-to-tenants check via org_brands
--     was already dropping them silently — sentinel R3)
--   - social_monitor_schedule: 0 rows

-- ── 1) social_monitor_schedule (empty) — drop + recreate without FK ──
DROP TABLE IF EXISTS social_monitor_schedule;

CREATE TABLE social_monitor_schedule (
  id                    TEXT PRIMARY KEY,
  brand_id              TEXT NOT NULL,
  platform              TEXT NOT NULL,
  last_checked          TEXT,
  next_check            TEXT,
  check_interval_hours  INTEGER DEFAULT 24,
  enabled               INTEGER DEFAULT 1,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_social_schedule_brand_platform
  ON social_monitor_schedule(brand_id, platform);

CREATE INDEX idx_social_schedule_next
  ON social_monitor_schedule(next_check) WHERE enabled = 1;

-- ── 2) social_monitor_results (28 rows) — recreate-rename pattern ──
DROP TABLE IF EXISTS _smr_no_fk_2026_05;

CREATE TABLE _smr_no_fk_2026_05 (
  id                          TEXT PRIMARY KEY,
  brand_id                    TEXT NOT NULL,
  platform                    TEXT NOT NULL,
  check_type                  TEXT NOT NULL,
  handle_checked              TEXT,
  handle_available            INTEGER,
  handle_owner_matches_brand  INTEGER,
  suspicious_account_url      TEXT,
  suspicious_account_name     TEXT,
  impersonation_score         REAL,
  impersonation_signals       TEXT,
  ai_assessment               TEXT,
  severity                    TEXT DEFAULT 'LOW',
  status                      TEXT DEFAULT 'open',
  resolved_at                 TEXT,
  created_at                  TEXT DEFAULT (datetime('now')),
  ai_confidence               REAL,
  ai_action                   TEXT,
  ai_evidence_draft           TEXT
);

INSERT INTO _smr_no_fk_2026_05
  (id, brand_id, platform, check_type, handle_checked, handle_available,
   handle_owner_matches_brand, suspicious_account_url, suspicious_account_name,
   impersonation_score, impersonation_signals, ai_assessment, severity, status,
   resolved_at, created_at, ai_confidence, ai_action, ai_evidence_draft)
SELECT id, brand_id, platform, check_type, handle_checked, handle_available,
       handle_owner_matches_brand, suspicious_account_url, suspicious_account_name,
       impersonation_score, impersonation_signals, ai_assessment, severity, status,
       resolved_at, created_at, ai_confidence, ai_action, ai_evidence_draft
FROM social_monitor_results;

DROP TABLE social_monitor_results;
ALTER TABLE _smr_no_fk_2026_05 RENAME TO social_monitor_results;

CREATE INDEX idx_social_results_brand
  ON social_monitor_results(brand_id);

CREATE INDEX idx_social_results_severity
  ON social_monitor_results(severity) WHERE status = 'open';

CREATE INDEX idx_social_results_platform
  ON social_monitor_results(brand_id, platform);

-- ── 3) brand_profiles — archive + drop ──
DROP TABLE IF EXISTS _legacy_brand_profiles_2026_05;

CREATE TABLE _legacy_brand_profiles_2026_05 (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT,
  domain              TEXT,
  brand_name          TEXT,
  aliases             TEXT,
  official_handles    TEXT,
  brand_keywords      TEXT,
  executive_names     TEXT,
  logo_url            TEXT,
  logo_hash           TEXT,
  monitoring_tier     TEXT,
  status              TEXT,
  last_full_scan      TEXT,
  next_scheduled_scan TEXT,
  exposure_score      INTEGER,
  email_grade         TEXT,
  social_risk_score   INTEGER,
  domain_risk_score   INTEGER,
  threat_feed_score   INTEGER,
  created_at          TEXT,
  updated_at          TEXT,
  archived_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO _legacy_brand_profiles_2026_05
  (id, user_id, domain, brand_name, aliases, official_handles,
   brand_keywords, executive_names, logo_url, logo_hash, monitoring_tier,
   status, last_full_scan, next_scheduled_scan, exposure_score, email_grade,
   social_risk_score, domain_risk_score, threat_feed_score, created_at,
   updated_at)
SELECT id, user_id, domain, brand_name, aliases, official_handles,
       brand_keywords, executive_names, logo_url, logo_hash, monitoring_tier,
       status, last_full_scan, next_scheduled_scan, exposure_score, email_grade,
       social_risk_score, domain_risk_score, threat_feed_score, created_at,
       updated_at
FROM brand_profiles;

DROP TABLE brand_profiles;
