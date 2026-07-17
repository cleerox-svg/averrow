-- Migration 0043: Fix brand_id type mismatch
-- brands.id is TEXT (e.g. "brand_amazon_com") but four tables declare brand_id as INTEGER
-- SQLite doesn't support ALTER COLUMN, so recreate tables with correct types

-- ═══════════════════════════════════════
-- 1. email_security_scans (3,829 rows)
-- ═══════════════════════════════════════
CREATE TABLE email_security_scans_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  dmarc_exists INTEGER DEFAULT 0,
  dmarc_policy TEXT,
  dmarc_pct INTEGER,
  dmarc_rua TEXT,
  dmarc_ruf TEXT,
  dmarc_raw TEXT,
  spf_exists INTEGER DEFAULT 0,
  spf_policy TEXT,
  spf_includes INTEGER DEFAULT 0,
  spf_too_many_lookups INTEGER DEFAULT 0,
  spf_raw TEXT,
  dkim_exists INTEGER DEFAULT 0,
  dkim_selectors_found TEXT,
  dkim_raw TEXT,
  mx_exists INTEGER DEFAULT 0,
  mx_providers TEXT,
  email_security_score INTEGER DEFAULT 0,
  email_security_grade TEXT,
  scanned_at TEXT DEFAULT (datetime('now')),
  scan_duration_ms INTEGER,
  FOREIGN KEY (brand_id) REFERENCES brands(id)
);
INSERT INTO email_security_scans_new SELECT * FROM email_security_scans;
DROP TABLE email_security_scans;
ALTER TABLE email_security_scans_new RENAME TO email_security_scans;

-- ═══════════════════════════════════════
-- 2. org_brands (1 row)
-- ═══════════════════════════════════════
CREATE TABLE org_brands_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  brand_id TEXT NOT NULL,
  is_primary INTEGER DEFAULT 0,
  monitoring_config_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id),
  FOREIGN KEY (brand_id) REFERENCES brands(id),
  UNIQUE(org_id, brand_id)
);
INSERT INTO org_brands_new SELECT * FROM org_brands;
DROP TABLE org_brands;
ALTER TABLE org_brands_new RENAME TO org_brands;

-- ═══════════════════════════════════════
-- 3. dmarc_reports (0 rows)
-- ═══════════════════════════════════════
CREATE TABLE dmarc_reports_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT,
  domain TEXT NOT NULL,
  reporter_org TEXT,
  reporter_email TEXT,
  report_id TEXT,
  date_begin TEXT,
  date_end TEXT,
  total_records INTEGER DEFAULT 0,
  total_messages INTEGER DEFAULT 0,
  total_pass INTEGER DEFAULT 0,
  total_fail INTEGER DEFAULT 0,
  policy_published TEXT,
  raw_xml TEXT,
  received_at TEXT DEFAULT (datetime('now')),
  processed INTEGER DEFAULT 0,
  process_error TEXT,
  FOREIGN KEY (brand_id) REFERENCES brands(id)
);
DROP TABLE dmarc_reports;
ALTER TABLE dmarc_reports_new RENAME TO dmarc_reports;

-- ═══════════════════════════════════════
-- 4. dmarc_daily_stats (0 rows)
-- ═══════════════════════════════════════
CREATE TABLE dmarc_daily_stats_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  brand_id TEXT,
  date TEXT NOT NULL,
  total_messages INTEGER DEFAULT 0,
  passed INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  unique_sources INTEGER DEFAULT 0,
  top_fail_ips TEXT,
  reporters TEXT,
  FOREIGN KEY (brand_id) REFERENCES brands(id)
);
DROP TABLE dmarc_daily_stats;
ALTER TABLE dmarc_daily_stats_new RENAME TO dmarc_daily_stats;

-- ═══════════════════════════════════════
-- Recreate indexes
-- ═══════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_ess_brand ON email_security_scans(brand_id);
CREATE INDEX IF NOT EXISTS idx_ess_domain ON email_security_scans(domain);
CREATE INDEX IF NOT EXISTS idx_ob_org ON org_brands(org_id);
CREATE INDEX IF NOT EXISTS idx_ob_brand ON org_brands(brand_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dds_domain_date ON dmarc_daily_stats(domain, date);
