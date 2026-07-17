-- Migration: 0020_email_security_posture.sql
-- Email Security Posture Engine — adds DMARC/SPF/DKIM/MX scanning

-- Email security scan results (one per brand per scan)
CREATE TABLE IF NOT EXISTS email_security_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL,
  domain TEXT NOT NULL,

  -- DMARC
  dmarc_exists INTEGER DEFAULT 0,
  dmarc_policy TEXT,
  dmarc_pct INTEGER,
  dmarc_rua TEXT,
  dmarc_ruf TEXT,
  dmarc_raw TEXT,

  -- SPF
  spf_exists INTEGER DEFAULT 0,
  spf_policy TEXT,
  spf_includes INTEGER DEFAULT 0,
  spf_too_many_lookups INTEGER DEFAULT 0,
  spf_raw TEXT,

  -- DKIM
  dkim_exists INTEGER DEFAULT 0,
  dkim_selectors_found TEXT,
  dkim_raw TEXT,

  -- MX
  mx_exists INTEGER DEFAULT 0,
  mx_providers TEXT,

  -- Scores
  email_security_score INTEGER DEFAULT 0,
  email_security_grade TEXT,

  -- Metadata
  scanned_at TEXT DEFAULT (datetime('now')),
  scan_duration_ms INTEGER,

  FOREIGN KEY (brand_id) REFERENCES brands(id)
);

CREATE INDEX IF NOT EXISTS idx_ess_brand ON email_security_scans(brand_id);
CREATE INDEX IF NOT EXISTS idx_ess_domain ON email_security_scans(domain);
CREATE INDEX IF NOT EXISTS idx_ess_scanned ON email_security_scans(scanned_at);

-- Add email security score columns to brands table
ALTER TABLE brands ADD COLUMN email_security_score INTEGER DEFAULT NULL;
ALTER TABLE brands ADD COLUMN email_security_grade TEXT DEFAULT NULL;
ALTER TABLE brands ADD COLUMN email_security_scanned_at TEXT DEFAULT NULL;
