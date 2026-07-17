-- Add tranco_rank column to brands table (idempotent)
-- SQLite lacks ALTER TABLE ADD COLUMN IF NOT EXISTS, so we rebuild the table.
-- This safely handles both fresh databases and databases where the column
-- already exists from a partial migration. The prospector agent will
-- re-populate tranco_rank values on its next run.

CREATE TABLE _brands_rebuild (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  canonical_domain          TEXT NOT NULL,
  sector                    TEXT,
  first_seen                TEXT NOT NULL DEFAULT (datetime('now')),
  threat_count              INTEGER NOT NULL DEFAULT 0,
  last_threat_seen          TEXT,
  threat_analysis           TEXT,
  analysis_updated_at       TEXT,
  email_security_score      INTEGER DEFAULT NULL,
  email_security_grade      TEXT DEFAULT NULL,
  email_security_scanned_at TEXT DEFAULT NULL,
  official_handles          TEXT,
  aliases                   TEXT,
  brand_keywords            TEXT,
  executive_names           TEXT,
  logo_url                  TEXT,
  logo_hash                 TEXT,
  website_url               TEXT,
  monitoring_tier           TEXT DEFAULT 'scan',
  monitoring_status         TEXT DEFAULT 'inactive',
  social_risk_score         INTEGER,
  domain_risk_score         INTEGER,
  email_grade               TEXT,
  exposure_score            INTEGER,
  last_social_scan          TEXT,
  next_social_scan          TEXT,
  tranco_rank               INTEGER
);

INSERT INTO _brands_rebuild (
  id, name, canonical_domain, sector, first_seen, threat_count, last_threat_seen,
  threat_analysis, analysis_updated_at,
  email_security_score, email_security_grade, email_security_scanned_at,
  official_handles, aliases, brand_keywords, executive_names,
  logo_url, logo_hash, website_url,
  monitoring_tier, monitoring_status,
  social_risk_score, domain_risk_score, email_grade, exposure_score,
  last_social_scan, next_social_scan
)
SELECT
  id, name, canonical_domain, sector, first_seen, threat_count, last_threat_seen,
  threat_analysis, analysis_updated_at,
  email_security_score, email_security_grade, email_security_scanned_at,
  official_handles, aliases, brand_keywords, executive_names,
  logo_url, logo_hash, website_url,
  monitoring_tier, monitoring_status,
  social_risk_score, domain_risk_score, email_grade, exposure_score,
  last_social_scan, next_social_scan
FROM brands;

DROP TABLE brands;
ALTER TABLE _brands_rebuild RENAME TO brands;

CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_domain ON brands(canonical_domain);
CREATE INDEX IF NOT EXISTS idx_brands_sector ON brands(sector);
CREATE INDEX IF NOT EXISTS idx_brands_threat_count ON brands(threat_count DESC);
CREATE INDEX IF NOT EXISTS idx_brands_tranco ON brands(tranco_rank);
