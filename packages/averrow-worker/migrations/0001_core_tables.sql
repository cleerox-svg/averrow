-- Trust Radar v2 — Core Data Tables
-- brands, threats, hosting_providers, campaigns, daily_snapshots, feed_status

-- ─── Brands ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brands (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  canonical_domain TEXT NOT NULL UNIQUE,
  sector          TEXT,  -- finance, tech, retail, healthcare, government, crypto, etc.
  first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  threat_count    INTEGER NOT NULL DEFAULT 0,
  last_threat_seen TEXT
);

CREATE INDEX idx_brands_domain ON brands(canonical_domain);
CREATE INDEX idx_brands_sector ON brands(sector);
CREATE INDEX idx_brands_threat_count ON brands(threat_count DESC);

-- ─── Hosting Providers ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hosting_providers (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  asn                 TEXT UNIQUE,
  country             TEXT,
  active_threat_count INTEGER NOT NULL DEFAULT 0,
  total_threat_count  INTEGER NOT NULL DEFAULT 0,
  trend_7d            INTEGER NOT NULL DEFAULT 0,
  trend_30d           INTEGER NOT NULL DEFAULT 0,
  trend_90d           INTEGER NOT NULL DEFAULT 0,
  avg_response_time   INTEGER,  -- hours
  reputation_score    INTEGER   -- 0-100, computed weekly
);

CREATE INDEX idx_providers_asn ON hosting_providers(asn);
CREATE INDEX idx_providers_active_threats ON hosting_providers(active_threat_count DESC);
CREATE INDEX idx_providers_reputation ON hosting_providers(reputation_score);

-- ─── Campaigns ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen       TEXT NOT NULL DEFAULT (datetime('now')),
  threat_count    INTEGER NOT NULL DEFAULT 0,
  brand_count     INTEGER NOT NULL DEFAULT 0,
  provider_count  INTEGER NOT NULL DEFAULT 0,
  attack_pattern  TEXT,   -- phishing kit fingerprint, template similarity, etc.
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dormant', 'disrupted'))
);

CREATE INDEX idx_campaigns_status ON campaigns(status);
CREATE INDEX idx_campaigns_last_seen ON campaigns(last_seen DESC);

-- ─── Threats ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS threats (
  id                  TEXT PRIMARY KEY,
  source_feed         TEXT NOT NULL,
  threat_type         TEXT NOT NULL CHECK (threat_type IN (
    'phishing', 'typosquatting', 'impersonation', 'malware_distribution', 'credential_harvesting'
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
  confidence_score    INTEGER,  -- 0-100, AI-assigned
  campaign_id         TEXT REFERENCES campaigns(id),
  ioc_value           TEXT,     -- normalized indicator of compromise
  severity            TEXT CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_threats_brand_status ON threats(target_brand_id, status);
CREATE INDEX idx_threats_provider ON threats(hosting_provider_id);
CREATE INDEX idx_threats_campaign ON threats(campaign_id);
CREATE INDEX idx_threats_type ON threats(threat_type);
CREATE INDEX idx_threats_severity ON threats(severity);
CREATE INDEX idx_threats_status ON threats(status);
CREATE INDEX idx_threats_first_seen ON threats(first_seen DESC);
CREATE INDEX idx_threats_last_seen ON threats(last_seen DESC);
CREATE INDEX idx_threats_created_at ON threats(created_at DESC);
CREATE INDEX idx_threats_domain ON threats(malicious_domain);
CREATE INDEX idx_threats_ip ON threats(ip_address);
CREATE INDEX idx_threats_ioc ON threats(ioc_value);
CREATE INDEX idx_threats_source ON threats(source_feed);
CREATE INDEX idx_threats_country ON threats(country_code);

-- ─── Daily Snapshots ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_snapshots (
  date                    TEXT NOT NULL,
  entity_type             TEXT NOT NULL CHECK (entity_type IN ('brand', 'provider')),
  entity_id               TEXT NOT NULL,
  new_threats             INTEGER NOT NULL DEFAULT 0,
  active_threats          INTEGER NOT NULL DEFAULT 0,
  remediated_threats      INTEGER NOT NULL DEFAULT 0,
  dominant_threat_type    TEXT,
  dominant_hosting_provider TEXT,
  PRIMARY KEY (date, entity_type, entity_id)
);

CREATE INDEX idx_snapshots_entity ON daily_snapshots(entity_type, entity_id);
CREATE INDEX idx_snapshots_date ON daily_snapshots(date DESC);

-- ─── Feed Status ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feed_status (
  feed_name             TEXT PRIMARY KEY,
  last_successful_pull  TEXT,
  last_failure          TEXT,
  records_ingested_today INTEGER NOT NULL DEFAULT 0,
  health_status         TEXT NOT NULL DEFAULT 'disabled' CHECK (health_status IN ('healthy', 'degraded', 'down', 'disabled'))
);
