-- Migration: 0022_spam_trap_system.sql

-- ============================================
-- SPAM TRAP CAPTURES
-- ============================================

-- Every email caught by the spam trap
CREATE TABLE IF NOT EXISTS spam_trap_captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Trap identification
  trap_address TEXT NOT NULL,
  trap_domain TEXT NOT NULL,
  trap_channel TEXT,
  trap_campaign_id INTEGER,

  -- Sender info
  from_address TEXT,
  from_domain TEXT,
  reply_to TEXT,
  return_path TEXT,
  helo_hostname TEXT,
  subject TEXT,

  -- Authentication results
  spf_result TEXT,
  spf_domain TEXT,
  dkim_result TEXT,
  dkim_domain TEXT,
  dmarc_result TEXT,
  dmarc_disposition TEXT,

  -- Sending infrastructure
  sending_ip TEXT,
  x_mailer TEXT,

  -- Extracted IOCs
  urls_found TEXT,
  url_count INTEGER DEFAULT 0,
  attachment_hashes TEXT,
  attachment_count INTEGER DEFAULT 0,

  -- Brand matching
  spoofed_brand_id TEXT,
  spoofed_domain TEXT,
  brand_match_method TEXT,
  brand_confidence INTEGER DEFAULT 50,

  -- Classification
  category TEXT DEFAULT 'phishing',
  severity TEXT DEFAULT 'medium',

  -- Geo (enriched later)
  country_code TEXT,
  city TEXT,
  lat REAL,
  lng REAL,
  asn TEXT,
  org TEXT,

  -- Linked records
  threat_id TEXT,
  campaign_id TEXT,

  -- Metadata
  raw_headers TEXT,
  body_preview TEXT,
  captured_at TEXT DEFAULT (datetime('now')),
  processed INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_stc_trap ON spam_trap_captures(trap_address);
CREATE INDEX IF NOT EXISTS idx_stc_domain ON spam_trap_captures(from_domain);
CREATE INDEX IF NOT EXISTS idx_stc_brand ON spam_trap_captures(spoofed_brand_id);
CREATE INDEX IF NOT EXISTS idx_stc_ip ON spam_trap_captures(sending_ip);
CREATE INDEX IF NOT EXISTS idx_stc_captured ON spam_trap_captures(captured_at);
CREATE INDEX IF NOT EXISTS idx_stc_category ON spam_trap_captures(category);
CREATE INDEX IF NOT EXISTS idx_stc_channel ON spam_trap_captures(trap_channel);

-- ============================================
-- SEED CAMPAIGNS
-- ============================================

CREATE TABLE IF NOT EXISTS seed_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  target_brands TEXT,

  config TEXT,
  addresses_seeded INTEGER DEFAULT 0,

  total_catches INTEGER DEFAULT 0,
  unique_ips_caught INTEGER DEFAULT 0,
  brands_spoofed INTEGER DEFAULT 0,
  last_catch_at TEXT,

  created_by TEXT DEFAULT 'manual',
  strategist_notes TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sc_status ON seed_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_sc_channel ON seed_campaigns(channel);

-- ============================================
-- SEED ADDRESSES
-- ============================================

CREATE TABLE IF NOT EXISTS seed_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  channel TEXT NOT NULL,
  campaign_id INTEGER,
  brand_target TEXT,

  seeded_at TEXT DEFAULT (datetime('now')),
  seeded_location TEXT,
  total_catches INTEGER DEFAULT 0,
  last_catch_at TEXT,

  status TEXT DEFAULT 'active',

  FOREIGN KEY (campaign_id) REFERENCES seed_campaigns(id)
);

CREATE INDEX IF NOT EXISTS idx_sa_address ON seed_addresses(address);
CREATE INDEX IF NOT EXISTS idx_sa_channel ON seed_addresses(channel);
CREATE INDEX IF NOT EXISTS idx_sa_brand ON seed_addresses(brand_target);
CREATE INDEX IF NOT EXISTS idx_sa_status ON seed_addresses(status);

-- ============================================
-- SPAM TRAP DAILY STATS
-- ============================================

CREATE TABLE IF NOT EXISTS spam_trap_daily_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  total_captures INTEGER DEFAULT 0,
  phishing_count INTEGER DEFAULT 0,
  spam_count INTEGER DEFAULT 0,
  malware_count INTEGER DEFAULT 0,
  unique_ips INTEGER DEFAULT 0,
  unique_brands_spoofed INTEGER DEFAULT 0,
  auth_fail_rate REAL DEFAULT 0,
  top_spoofed_brands TEXT,
  top_source_countries TEXT,
  new_urls_discovered INTEGER DEFAULT 0,
  new_threats_created INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stds_date ON spam_trap_daily_stats(date);
