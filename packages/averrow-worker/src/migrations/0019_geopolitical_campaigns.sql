-- 0019_geopolitical_campaigns.sql
-- Geopolitical campaign tracking for nation-state threat intelligence
-- Links to existing campaigns table, adds geopolitical context

CREATE TABLE IF NOT EXISTS geopolitical_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  conflict TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'dormant', 'disrupted')),

  -- Adversary context
  threat_actors TEXT DEFAULT '[]',          -- JSON array of actor names
  adversary_countries TEXT DEFAULT '[]',    -- JSON array of country codes (e.g. ["IR","RU"])
  adversary_asns TEXT DEFAULT '[]',         -- JSON array of known hostile ASNs
  target_countries TEXT DEFAULT '[]',       -- JSON array of target country codes
  target_sectors TEXT DEFAULT '[]',         -- JSON array of sector strings
  target_brands TEXT DEFAULT '[]',          -- JSON array of brand IDs

  -- MITRE ATT&CK TTPs
  ttps TEXT DEFAULT '[]',                   -- JSON array of technique IDs

  -- Escalation rules (JSON object)
  escalation_rules TEXT DEFAULT '{}',

  -- IOC correlation
  ioc_sources TEXT DEFAULT '[]',           -- JSON array of IOC source names (CISA, Unit 42, etc.)
  known_iocs TEXT DEFAULT '[]',            -- JSON array of known IOC values

  -- Timeline
  start_date TEXT NOT NULL,
  end_date TEXT,                            -- NULL if ongoing

  -- Metadata
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for slug-based lookups (used in URL routing)
CREATE INDEX IF NOT EXISTS idx_geopolitical_campaigns_slug ON geopolitical_campaigns(slug);
CREATE INDEX IF NOT EXISTS idx_geopolitical_campaigns_status ON geopolitical_campaigns(status);

-- Link table: geopolitical campaign → existing campaigns
CREATE TABLE IF NOT EXISTS geopolitical_campaign_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  geopolitical_campaign_id TEXT NOT NULL REFERENCES geopolitical_campaigns(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(geopolitical_campaign_id, campaign_id)
);

-- Seed the Iran/IRGC campaign profile
INSERT OR IGNORE INTO geopolitical_campaigns (
  id, name, slug, conflict, status,
  threat_actors, adversary_countries, adversary_asns,
  target_countries, target_sectors, target_brands,
  ttps, ioc_sources,
  escalation_rules, start_date, description
) VALUES (
  'geo-iran-irgc-2026',
  'IRGC Retaliation Campaign',
  'iran-irgc-retaliation-2026',
  'iran-israel-2026',
  'active',
  '["Handala", "Hydro Kitten", "CyberAv3ngers", "Charming Kitten"]',
  '["IR", "IQ", "SY", "LB", "YE"]',
  '["AS43754", "AS208137", "AS205585", "AS25184"]',
  '["US", "IL"]',
  '["tech", "finance", "defense"]',
  '[]',
  '["T1566", "T1190", "T1485"]',
  '["Palo Alto Unit 42", "CISA", "CrowdStrike", "Proofpoint"]',
  '{"adversary_country_threat": "critical", "adversary_asn_threat": "critical", "named_brand_threat": "high", "cisa_ioc_match": "critical", "social_actor_mention": "alert", "numbered_domain_pattern": "high", "subdomain_spoofing": "critical", "new_adversary_asn_cluster": "alert"}',
  '2026-02-28',
  'Iranian IRGC-linked retaliation campaign following US/Israel Operation Epic Fury strikes. Key actors include Handala, Hydro Kitten, CyberAv3ngers, and Charming Kitten. Primary TTPs: credential harvesting via brand impersonation, vishing, wiper attacks, website defacement, and DDoS.'
);
