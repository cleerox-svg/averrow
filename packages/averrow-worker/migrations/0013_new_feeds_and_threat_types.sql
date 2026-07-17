-- Add new feed configurations: NRD Hagezi, DShield, CINS Army, SSLBL
-- Fix URLhaus source_url to include /urls/recent/ path
-- Expand threat_type CHECK constraint to support new feed types

-- ─── Fix URLhaus URL ──────────────────────────────────────────────
UPDATE feed_configs SET source_url = 'https://urlhaus-api.abuse.ch/v1/urls/recent/'
WHERE feed_name = 'urlhaus';

-- ─── New Feed Configs ─────────────────────────────────────────────
INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, schedule_cron, rate_limit, batch_size, enabled) VALUES
  ('nrd_hagezi', 'Newly Registered Domains', 'Hagezi NRD list filtered against monitored brands for typosquatting detection', 'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/nrd-14.txt', '0 0 * * *', 10, 500, 1),
  ('dshield',    'SANS DShield',             'Top attacking IPs from SANS Internet Storm Center honeypots',                   'https://isc.sans.edu/api/topips/records/100?json',                             '0 */6 * * *', 10, 100, 1),
  ('cins_army',  'CINS Army',                'Verified malicious IPs from CINS honeypot network',                             'https://cinsscore.com/list/ci-badguys.txt',                                    '0 0 * * *', 10, 200, 1),
  ('sslbl',      'SSL Blacklist',            'SSL certificates associated with malware and botnets from abuse.ch',            'https://sslbl.abuse.ch/blacklist/sslblacklist.csv',                            '0 0 * * *', 10, 500, 1);

-- ─── New Feed Status Entries ──────────────────────────────────────
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES
  ('nrd_hagezi', 'healthy'),
  ('dshield',    'healthy'),
  ('cins_army',  'healthy'),
  ('sslbl',      'healthy');

-- ─── Expand threat_type CHECK constraint ──────────────────────────
-- SQLite cannot ALTER CHECK constraints, so we recreate the table.
-- Preserve all existing data.

CREATE TABLE threats_new (
  id                  TEXT PRIMARY KEY,
  source_feed         TEXT NOT NULL,
  threat_type         TEXT NOT NULL CHECK (threat_type IN (
    'phishing', 'typosquatting', 'impersonation', 'malware_distribution', 'credential_harvesting',
    'c2', 'scanning', 'malicious_ip', 'botnet', 'malicious_ssl'
  )),
  malicious_url       TEXT,
  malicious_domain    TEXT,
  target_brand_id     TEXT REFERENCES brands(id),
  hosting_provider_id TEXT REFERENCES hosting_providers(id),
  ip_address          TEXT,
  asn                 TEXT,
  country_code        TEXT,
  lat                 REAL,
  lng                 REAL,
  registrar           TEXT,
  first_seen          TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen           TEXT NOT NULL DEFAULT (datetime('now')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'down', 'remediated')),
  confidence_score    INTEGER,
  campaign_id         TEXT REFERENCES campaigns(id),
  ioc_value           TEXT,
  severity            TEXT CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO threats_new SELECT * FROM threats;

DROP TABLE threats;

ALTER TABLE threats_new RENAME TO threats;

CREATE INDEX idx_threats_brand_status ON threats(target_brand_id, status);
CREATE INDEX idx_threats_provider ON threats(hosting_provider_id);
CREATE INDEX idx_threats_campaign ON threats(campaign_id);
CREATE INDEX idx_threats_type ON threats(threat_type);
