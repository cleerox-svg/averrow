-- Sparrow Phase 1: Takedown pipeline schema
-- Takedown evidence artifacts (screenshots, PDFs, WHOIS dumps)

CREATE TABLE IF NOT EXISTS takedown_evidence (
  id TEXT PRIMARY KEY,
  takedown_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL, -- 'screenshot', 'whois', 'dns', 'brand_comparison', 'email_headers', 'url_scan', 'ai_report'
  title TEXT NOT NULL,
  content_text TEXT, -- for text-based evidence
  storage_key TEXT, -- R2 key for binary evidence (screenshots, PDFs)
  storage_url TEXT, -- public URL if applicable
  metadata_json TEXT, -- additional structured data
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (takedown_id) REFERENCES takedown_requests(id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_takedown ON takedown_evidence(takedown_id);
CREATE INDEX IF NOT EXISTS idx_evidence_type ON takedown_evidence(evidence_type);

-- URL scan results from spam trap and threat signals

CREATE TABLE IF NOT EXISTS url_scan_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  source_type TEXT NOT NULL, -- 'spam_trap', 'threat_signal', 'manual'
  source_id TEXT, -- spam_trap_captures.id or threat_signals.id
  brand_id TEXT, -- matched brand being targeted

  -- Internal checks
  known_threat INTEGER DEFAULT 0, -- found in our threats table
  known_threat_id TEXT, -- matching threat ID

  -- External checks (populated as integrations are added)
  google_safe_browsing TEXT, -- 'safe', 'malicious', 'unknown', null
  phishtank_status TEXT,
  urlhaus_status TEXT,
  virustotal_status TEXT,

  -- Domain intelligence
  domain_age_days INTEGER,
  registrar TEXT,
  hosting_provider TEXT,
  hosting_ip TEXT,
  hosting_country TEXT,
  ssl_issuer TEXT,
  ssl_valid INTEGER,

  -- Classification
  is_malicious INTEGER DEFAULT 0,
  malicious_reasons TEXT, -- JSON array of reasons
  confidence_score REAL, -- 0-1

  -- Takedown linkage
  takedown_id TEXT, -- linked takedown request if created

  scanned_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (brand_id) REFERENCES brands(id),
  FOREIGN KEY (takedown_id) REFERENCES takedown_requests(id)
);

CREATE INDEX IF NOT EXISTS idx_url_scan_url ON url_scan_results(url);
CREATE INDEX IF NOT EXISTS idx_url_scan_domain ON url_scan_results(domain);
CREATE INDEX IF NOT EXISTS idx_url_scan_source ON url_scan_results(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_url_scan_brand ON url_scan_results(brand_id);
CREATE INDEX IF NOT EXISTS idx_url_scan_malicious ON url_scan_results(is_malicious) WHERE is_malicious = 1;
CREATE INDEX IF NOT EXISTS idx_url_scan_takedown ON url_scan_results(takedown_id) WHERE takedown_id IS NOT NULL;

-- Takedown provider directory (known abuse contacts)

CREATE TABLE IF NOT EXISTS takedown_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_name TEXT NOT NULL,
  provider_type TEXT NOT NULL, -- 'registrar', 'hosting', 'social_platform', 'cdn', 'email_provider'
  abuse_email TEXT,
  abuse_url TEXT,
  abuse_api_url TEXT, -- for providers with API submission
  abuse_api_type TEXT, -- 'rest', 'form', 'email'
  avg_response_hours INTEGER,
  success_rate REAL, -- 0-1, updated over time
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_name ON takedown_providers(provider_name);

-- Seed with known provider abuse contacts

INSERT OR IGNORE INTO takedown_providers (provider_name, provider_type, abuse_email, abuse_url, abuse_api_type) VALUES
  ('GoDaddy', 'registrar', 'abuse@godaddy.com', 'https://supportcenter.godaddy.com/AbuseReport', 'form'),
  ('Namecheap', 'registrar', 'abuse@namecheap.com', 'https://www.namecheap.com/support/abuse/', 'form'),
  ('Cloudflare', 'hosting', 'abuse@cloudflare.com', 'https://abuse.cloudflare.com/', 'form'),
  ('Google Cloud', 'hosting', NULL, 'https://support.google.com/code/contact/cloud_platform_report', 'form'),
  ('Amazon AWS', 'hosting', 'abuse@amazonaws.com', 'https://support.aws.amazon.com/#/contacts/report-abuse', 'form'),
  ('Microsoft Azure', 'hosting', 'cert@microsoft.com', 'https://msrc.microsoft.com/report/abuse', 'form'),
  ('DigitalOcean', 'hosting', 'abuse@digitalocean.com', 'https://www.digitalocean.com/company/contact/abuse', 'form'),
  ('OVH', 'hosting', 'abuse@ovh.net', 'https://www.ovh.com/abuse/', 'form'),
  ('Hetzner', 'hosting', 'abuse@hetzner.com', 'https://abuse.hetzner.com/', 'form'),
  ('Vercel', 'hosting', NULL, 'https://vercel.com/report-abuse', 'form'),
  ('Netlify', 'hosting', 'fraud@netlify.com', 'https://www.netlify.com/abuse/', 'email'),
  ('GitHub Pages', 'hosting', 'support@github.com', 'https://support.github.com/contact/dmca-takedown', 'form'),
  ('Twitter/X', 'social_platform', NULL, 'https://help.x.com/forms/impersonation', 'form'),
  ('Instagram', 'social_platform', NULL, 'https://help.instagram.com/contact/636276399721841', 'form'),
  ('LinkedIn', 'social_platform', NULL, 'https://www.linkedin.com/help/linkedin/ask/TS-NFPI', 'form'),
  ('TikTok', 'social_platform', NULL, 'https://www.tiktok.com/legal/report/feedback', 'form'),
  ('YouTube', 'social_platform', NULL, 'https://www.youtube.com/reportabuse', 'form'),
  ('Facebook', 'social_platform', NULL, 'https://www.facebook.com/help/contact/295309487309948', 'form'),
  ('Google Safe Browsing', 'reporting', NULL, 'https://safebrowsing.google.com/safebrowsing/report_phish/', 'rest'),
  ('Netcraft', 'reporting', NULL, 'https://report.netcraft.com/report', 'rest'),
  ('APWG', 'reporting', NULL, 'https://apwg.org/report-phishing/', 'rest');
