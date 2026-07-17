-- Certificate Transparency monitoring
CREATE TABLE IF NOT EXISTS ct_certificates (
  id TEXT PRIMARY KEY,
  brand_id TEXT,
  domain TEXT NOT NULL,
  issuer TEXT,
  subject_cn TEXT,
  san_domains TEXT,  -- JSON array of Subject Alternative Names
  not_before TEXT,
  not_after TEXT,
  fingerprint TEXT,
  log_source TEXT,  -- 'crtsh' or 'certstream'
  suspicious INTEGER DEFAULT 0,
  ai_assessment TEXT,
  alert_id TEXT,
  status TEXT DEFAULT 'new',  -- new, reviewed, benign, malicious
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ct_domain ON ct_certificates(domain);
CREATE INDEX IF NOT EXISTS idx_ct_brand ON ct_certificates(brand_id);
CREATE INDEX IF NOT EXISTS idx_ct_suspicious ON ct_certificates(suspicious) WHERE suspicious = 1;
CREATE INDEX IF NOT EXISTS idx_ct_created ON ct_certificates(created_at);
