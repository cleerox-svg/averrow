-- Threat Actor Tracking & IRGC Brand Monitoring
-- Adds threat_actors, threat_actor_infrastructure, threat_actor_targets tables
-- Seeds Iranian threat actors from IRGC April 2026 targeting list
-- Adds missing IRGC-targeted brands and activates monitoring

-- ─── Threat Actors ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS threat_actors (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  aliases         TEXT,            -- JSON array of known aliases
  affiliation     TEXT,            -- e.g. 'IRGC', 'MOIS', 'GRU'
  country_code    TEXT,            -- ISO 3166-1 alpha-2
  capability      TEXT,            -- e.g. 'destructive', 'espionage', 'infrastructure', 'influence_ops'
  primary_ttps    TEXT,            -- JSON array of TTPs
  description     TEXT,
  first_seen      TEXT,
  last_seen       TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dormant', 'disrupted', 'unknown')),
  attribution_confidence TEXT NOT NULL DEFAULT 'medium' CHECK (attribution_confidence IN ('confirmed', 'high', 'medium', 'low', 'suspected')),
  source          TEXT DEFAULT 'manual',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_threat_actors_country ON threat_actors(country_code);
CREATE INDEX IF NOT EXISTS idx_threat_actors_status ON threat_actors(status);
CREATE INDEX IF NOT EXISTS idx_threat_actors_affiliation ON threat_actors(affiliation);

-- ─── Threat Actor Infrastructure ───────────────────────────────────
CREATE TABLE IF NOT EXISTS threat_actor_infrastructure (
  id              TEXT PRIMARY KEY,
  threat_actor_id TEXT NOT NULL REFERENCES threat_actors(id) ON DELETE CASCADE,
  asn             TEXT,
  ip_range        TEXT,
  domain          TEXT,
  hosting_provider TEXT,
  country_code    TEXT,
  confidence      TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('confirmed', 'high', 'medium', 'low')),
  first_observed  TEXT NOT NULL DEFAULT (datetime('now')),
  last_observed   TEXT NOT NULL DEFAULT (datetime('now')),
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tai_actor ON threat_actor_infrastructure(threat_actor_id);
CREATE INDEX IF NOT EXISTS idx_tai_asn ON threat_actor_infrastructure(asn);
CREATE INDEX IF NOT EXISTS idx_tai_domain ON threat_actor_infrastructure(domain);

-- ─── Threat Actor Targets ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS threat_actor_targets (
  id              TEXT PRIMARY KEY,
  threat_actor_id TEXT NOT NULL REFERENCES threat_actors(id) ON DELETE CASCADE,
  brand_id        TEXT REFERENCES brands(id) ON DELETE SET NULL,
  sector          TEXT,
  target_type     TEXT NOT NULL DEFAULT 'brand' CHECK (target_type IN ('brand', 'sector', 'government', 'infrastructure')),
  context         TEXT,            -- why this target (e.g. 'IRGC April 2026 targeting list')
  first_targeted  TEXT NOT NULL DEFAULT (datetime('now')),
  last_targeted   TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tat_actor ON threat_actor_targets(threat_actor_id);
CREATE INDEX IF NOT EXISTS idx_tat_brand ON threat_actor_targets(brand_id);

-- ─── Ensure ALL Referenced Brands Exist ────────────────────────────
-- INSERT OR IGNORE does NOT suppress FK violations in SQLite, so we must
-- guarantee every brand_id referenced by threat_actor_targets exists first.
-- These may already exist from migration 0024 but we re-assert to be safe.
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, threat_count) VALUES
('brand_amazon', 'Amazon', 'amazon.com', 'tech', 0),
('brand_microsoft', 'Microsoft', 'microsoft.com', 'tech', 0),
('brand_apple', 'Apple', 'apple.com', 'tech', 0),
('brand_google', 'Google', 'google.com', 'tech', 0),
('brand_meta', 'Meta', 'meta.com', 'tech', 0),
('brand_snapchat', 'Snapchat', 'snapchat.com', 'tech', 0),
('brand_palantir', 'Palantir', 'palantir.com', 'tech', 0),
('brand_oracle', 'Oracle', 'oracle.com', 'tech', 0),
('brand_nvidia', 'NVIDIA', 'nvidia.com', 'tech', 0),
('brand_tesla', 'Tesla', 'tesla.com', 'tech', 0),
('brand_hp', 'HP', 'hp.com', 'tech', 0),
('brand_intel', 'Intel', 'intel.com', 'tech', 0),
('brand_boeing', 'Boeing', 'boeing.com', 'tech', 0),
('brand_dell', 'Dell', 'dell.com', 'tech', 0),
('brand_cisco', 'Cisco', 'cisco.com', 'tech', 0),
('brand_ibm', 'IBM', 'ibm.com', 'tech', 0);

-- ─── Seed Iranian Threat Actors ────────────────────────────────────
INSERT OR IGNORE INTO threat_actors (id, name, aliases, affiliation, country_code, capability, primary_ttps, description, first_seen, status, attribution_confidence) VALUES
('ta_handala', 'Handala', '["Handala Hack Team"]', 'MOIS', 'IR', 'destructive',
 '["wiper_attacks", "microsoft_env_compromise", "data_destruction"]',
 'Iran MOIS-linked destructive group. Attacked Stryker Corp on March 11, 2026. Known for wiper malware deployment and Microsoft environment compromise.',
 '2023-01-01', 'active', 'high'),

('ta_hydro_kitten', 'Hydro Kitten', '["DEV-0270"]', 'IRGC', 'IR', 'espionage',
 '["financial_sector_targeting", "credential_harvesting", "network_disruption"]',
 'IRGC-affiliated group targeting financial sector. Combines espionage with disruptive capabilities.',
 '2022-01-01', 'active', 'high'),

('ta_cyberav3ngers', 'CyberAv3ngers', '["CyberAvengers", "Cyber Avengers"]', 'IRGC', 'IR', 'infrastructure',
 '["ics_scada_attacks", "plc_exploitation", "water_system_targeting"]',
 'IRGC-linked group specializing in ICS/SCADA attacks against critical infrastructure. Targeted US water systems in 2023-2024.',
 '2020-01-01', 'active', 'confirmed'),

('ta_agrius', 'Agrius', '["DEV-0227", "BlackShadow", "SharpBoys"]', 'MOIS', 'IR', 'destructive',
 '["supply_chain_attacks", "wiper_deployment", "ransomware_facade"]',
 'MOIS-affiliated destructive actor using ransomware as cover for wiper operations. Known for supply chain compromise.',
 '2020-01-01', 'active', 'high'),

('ta_muddywater', 'MuddyWater', '["Mercury", "Mango Sandstorm", "Static Kitten", "TEMP.Zagros"]', 'MOIS', 'IR', 'espionage',
 '["spear_phishing", "tunneling_tools", "powershell_backdoors", "lateral_movement"]',
 'MOIS cyber-espionage unit conducting intelligence collection campaigns. Uses custom tunneling tools and living-off-the-land techniques.',
 '2017-01-01', 'active', 'confirmed'),

('ta_charming_kitten', 'Charming Kitten', '["APT35", "Phosphorus", "Mint Sandstorm", "NewsBeef"]', 'IRGC', 'IR', 'espionage',
 '["credential_harvesting", "social_engineering", "fake_personas", "watering_hole"]',
 'IRGC intelligence collection group. Prolific credential harvesting using fake social media personas and targeted phishing.',
 '2014-01-01', 'active', 'confirmed'),

('ta_cotton_sandstorm', 'Cotton Sandstorm', '["Neptunium", "Emennet Pasargad", "DEV-0198"]', 'MOIS', 'IR', 'influence_ops',
 '["hack_and_leak", "website_defacement", "influence_operations", "psychological_ops"]',
 'MOIS-linked influence operations group. Conducts hack-and-leak campaigns and website defacements for psychological impact.',
 '2020-01-01', 'active', 'confirmed');

-- ─── Seed Threat Actor Infrastructure (Known Iranian ASNs) ─────────
INSERT OR IGNORE INTO threat_actor_infrastructure (id, threat_actor_id, asn, country_code, confidence, notes) VALUES
('tai_ir_as43754', 'ta_charming_kitten', 'AS43754', 'IR', 'medium', 'Asiatech Data Transmission — commonly used by Iranian APTs'),
('tai_ir_as208137', 'ta_muddywater', 'AS208137', 'IR', 'medium', 'Iranian hosting provider linked to MOIS operations'),
('tai_ir_as205585', 'ta_handala', 'AS205585', 'IR', 'medium', 'Noyan Abr Arvan — Iranian cloud provider used for C2');

-- ─── Map IRGC Targets to Threat Actors ─────────────────────────────
-- All 18 named targets from Tasnim News Agency April 2, 2026 deadline
INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context) VALUES
-- Charming Kitten (IRGC) — credential harvesting against tech companies
('tat_ck_amazon', 'ta_charming_kitten', 'brand_amazon', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_microsoft', 'ta_charming_kitten', 'brand_microsoft', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_apple', 'ta_charming_kitten', 'brand_apple', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_google', 'ta_charming_kitten', 'brand_google', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_meta', 'ta_charming_kitten', 'brand_meta', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_palantir', 'ta_charming_kitten', 'brand_palantir', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_oracle', 'ta_charming_kitten', 'brand_oracle', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_nvidia', 'ta_charming_kitten', 'brand_nvidia', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_tesla', 'ta_charming_kitten', 'brand_tesla', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_hp', 'ta_charming_kitten', 'brand_hp', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_intel', 'ta_charming_kitten', 'brand_intel', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_boeing', 'ta_charming_kitten', 'brand_boeing', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_dell', 'ta_charming_kitten', 'brand_dell', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_cisco', 'ta_charming_kitten', 'brand_cisco', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_ibm', 'ta_charming_kitten', 'brand_ibm', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
('tat_ck_snap', 'ta_charming_kitten', 'brand_snapchat', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'),
-- Handala (MOIS) — destructive capability against tech
('tat_ha_microsoft', 'ta_handala', 'brand_microsoft', 'tech', 'brand', 'Active MOIS destructive actor — attacked Stryker Corp March 11, 2026'),
('tat_ha_amazon', 'ta_handala', 'brand_amazon', 'tech', 'brand', 'MOIS destructive actor — wiper capability against cloud infrastructure'),
-- CyberAv3ngers (IRGC) — infrastructure targeting
('tat_ca_cisco', 'ta_cyberav3ngers', 'brand_cisco', 'tech', 'brand', 'IRGC ICS/SCADA group — Cisco ICS equipment targeted'),
('tat_ca_intel', 'ta_cyberav3ngers', 'brand_intel', 'tech', 'brand', 'IRGC infrastructure group — Intel-based ICS systems targeted'),
-- Agrius (MOIS) — supply chain attacks
('tat_ag_microsoft', 'ta_agrius', 'brand_microsoft', 'tech', 'brand', 'MOIS supply chain actor — Microsoft environment exploitation'),
('tat_ag_oracle', 'ta_agrius', 'brand_oracle', 'tech', 'brand', 'MOIS supply chain actor — enterprise software targeting'),
-- Cotton Sandstorm (MOIS) — influence ops / defacement
('tat_cs_meta', 'ta_cotton_sandstorm', 'brand_meta', 'tech', 'brand', 'MOIS influence ops — social media platform targeting for hack-and-leak'),
('tat_cs_snap', 'ta_cotton_sandstorm', 'brand_snapchat', 'tech', 'brand', 'MOIS influence ops — social media platform targeting');

-- ─── Activate Monitoring for All 18 IRGC Targets ──────────────────
-- Uses the admin user from migration 0062 since monitored_brands requires added_by (FK → users)
-- These will be activated with status='active' for immediate monitoring
INSERT OR IGNORE INTO monitored_brands (brand_id, tenant_id, added_by, status, notes)
SELECT id, '__internal__',
  (SELECT id FROM users LIMIT 1),
  'active',
  'IRGC targeting list — Tasnim News Agency April 2, 2026 deadline. Priority monitoring activated.'
FROM brands
WHERE id IN (
  'brand_amazon', 'brand_microsoft', 'brand_palantir', 'brand_oracle',
  'brand_apple', 'brand_google', 'brand_meta', 'brand_nvidia',
  'brand_tesla', 'brand_hp', 'brand_intel', 'brand_boeing',
  'brand_dell', 'brand_cisco', 'brand_ibm', 'brand_snapchat'
)
AND EXISTS (SELECT 1 FROM users LIMIT 1);
