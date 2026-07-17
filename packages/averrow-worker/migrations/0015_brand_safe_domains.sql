-- Brand Safe Domains — known/owned domain allowlist per brand
-- Domains in this table are excluded from threat detection and scoring.

CREATE TABLE IF NOT EXISTS brand_safe_domains (
  id         TEXT PRIMARY KEY,
  brand_id   TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  domain     TEXT NOT NULL,
  added_by   TEXT REFERENCES users(id),
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv_upload', 'auto_detected')),
  notes      TEXT,
  UNIQUE(brand_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_safe_domains_brand  ON brand_safe_domains(brand_id);
CREATE INDEX IF NOT EXISTS idx_safe_domains_domain ON brand_safe_domains(domain);
