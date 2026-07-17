-- Migration: 0023_seed_campaign_v1_and_phishing_signals.sql
--
-- Step 2: Manual seed validation campaign + initial seed addresses
-- Step 3: Phishing pattern signals table for AI-generated detection training data

-- ============================================
-- SEED CAMPAIGN: Manual Validation Batch v1
-- ============================================

INSERT OR IGNORE INTO seed_campaigns (
  id, name, channel, status, target_brands, config,
  addresses_seeded, created_by, strategist_notes, created_at, updated_at
) VALUES (
  1, 'Manual Seed Validation Batch', 'mixed', 'active', NULL,
  '{"description":"Initial hand-seeded addresses across multiple channels to validate inbound pipeline"}',
  8, 'manual', 'First batch: 8 addresses across contact_page, whois, forum, paste, directory, employee, honeypot, github channels.',
  datetime('now'), datetime('now')
);

-- ============================================
-- SEED ADDRESSES
-- ============================================

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, campaign_id, brand_target, seeded_location, status)
VALUES ('info-cp01@trustradar.ca', 'trustradar.ca', 'contact_page', 1, NULL, 'Embedded on /contact page', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, campaign_id, brand_target, seeded_location, status)
VALUES ('admin-wh01@trustradar.ca', 'trustradar.ca', 'whois', 1, NULL, 'Cheap .xyz domain WHOIS contact', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, campaign_id, brand_target, seeded_location, status)
VALUES ('support-fp01@trustradar.ca', 'trustradar.ca', 'forum', 1, NULL, 'Forum profile/signature', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, campaign_id, brand_target, seeded_location, status)
VALUES ('billing-ps01@trustradar.ca', 'trustradar.ca', 'paste', 1, NULL, 'Paste site fake contact list', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, campaign_id, brand_target, seeded_location, status)
VALUES ('sales-bd01@trustradar.ca', 'trustradar.ca', 'directory', 1, NULL, 'Business directory submission', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, campaign_id, brand_target, seeded_location, status)
VALUES ('ceo@lrxradar.com', 'lrxradar.com', 'employee', 1, NULL, 'Professional directory', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, campaign_id, brand_target, seeded_location, status)
VALUES ('hr-hp01@trustradar.ca', 'trustradar.ca', 'honeypot', 1, NULL, 'Future honeypot site page', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, campaign_id, brand_target, seeded_location, status)
VALUES ('dev-gp01@trustradar.ca', 'trustradar.ca', 'github', 1, NULL, 'GitHub repo README/issues', 'active');

-- ============================================
-- PHISHING PATTERN SIGNALS
-- ============================================
-- AI-generated phishing detection signals table.
-- Every catch will eventually feed this table for training data.

CREATE TABLE IF NOT EXISTS phishing_pattern_signals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  capture_id INTEGER NOT NULL,

  -- Content signals
  fluency_score REAL,
  template_detected INTEGER DEFAULT 0,
  template_hash TEXT,
  vocabulary_complexity REAL,
  sentence_structure_variance REAL,

  -- URL/payload signals
  url_obfuscation_type TEXT,
  redirect_chain_depth INTEGER,
  landing_page_hash TEXT,

  -- Infrastructure signals
  sender_ip TEXT,
  sender_asn TEXT,
  sender_asn_org TEXT,
  mail_server_fingerprint TEXT,
  ssl_cert_issuer TEXT,
  domain_age_days INTEGER,

  -- Brand impersonation signals
  brand_targeted TEXT,
  impersonation_technique TEXT,
  visual_similarity_score REAL,

  -- Classification
  ai_generated_probability REAL,
  classification TEXT,
  classified_at TEXT,

  created_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (capture_id) REFERENCES spam_trap_captures(id)
);

CREATE INDEX IF NOT EXISTS idx_pattern_capture ON phishing_pattern_signals(capture_id);
CREATE INDEX IF NOT EXISTS idx_pattern_brand ON phishing_pattern_signals(brand_targeted);
CREATE INDEX IF NOT EXISTS idx_pattern_classification ON phishing_pattern_signals(classification);
CREATE INDEX IF NOT EXISTS idx_pattern_ai_prob ON phishing_pattern_signals(ai_generated_probability);
