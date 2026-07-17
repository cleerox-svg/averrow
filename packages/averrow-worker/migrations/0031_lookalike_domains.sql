-- Lookalike domain continuous monitoring
CREATE TABLE IF NOT EXISTS lookalike_domains (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  permutation_type TEXT NOT NULL,
  -- typosquat, homoglyph, tld_swap, hyphenation, keyword
  registered INTEGER DEFAULT 0,  -- 0=not registered, 1=registered
  resolves_to TEXT,  -- IP address if registered
  has_mx INTEGER DEFAULT 0,  -- has mail exchange records
  has_web INTEGER DEFAULT 0,  -- responds on port 80/443
  first_seen TEXT,  -- when we first detected registration
  last_checked TEXT,
  threat_level TEXT DEFAULT 'LOW',  -- LOW, MEDIUM, HIGH, CRITICAL
  ai_assessment TEXT,
  alert_id TEXT,  -- link to alerts table if alert was created
  status TEXT DEFAULT 'monitoring',  -- monitoring, confirmed_threat, benign, taken_down
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lookalike_brand_domain
  ON lookalike_domains(brand_id, domain);
CREATE INDEX IF NOT EXISTS idx_lookalike_registered
  ON lookalike_domains(registered) WHERE registered = 1;
CREATE INDEX IF NOT EXISTS idx_lookalike_last_checked
  ON lookalike_domains(last_checked);
CREATE INDEX IF NOT EXISTS idx_lookalike_brand
  ON lookalike_domains(brand_id);
