-- 0064_geopolitical_campaigns_enhance.sql
-- Enhance geopolitical_campaigns table with missing fields from spec
-- Update Iran campaign seed with full threat actor list and target brands
-- Link geopolitical campaign to campaigns table

-- ─── 0) Ensure the base table exists (fresh-bootstrap fix) ─────────
-- `geopolitical_campaigns` + `geopolitical_campaign_links` + the
-- 'geo-iran-irgc-2026' seed row exist in production OUT-OF-BAND: they were
-- created by the legacy src/migrations/0019 set, which was never ported into
-- this active migrations dir (wrangler's migrations_dir = "migrations"). So on
-- a fresh `d1 migrations apply` the ALTER/UPDATE below hit "no such table".
-- Reproduce the authoritative base schema (from src/migrations/0019) so fresh
-- DBs have the same table prod already has. CREATE TABLE IF NOT EXISTS +
-- INSERT OR IGNORE are no-ops in prod (table + row already present), and 0064
-- never re-runs there (D1 tracks migrations by filename). The three enhance
-- columns (adversary_ip_ranges/briefing_priority/notes) are intentionally NOT
-- in this base — section A adds them, so its ADD COLUMN succeeds on fresh DBs.
CREATE TABLE IF NOT EXISTS geopolitical_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  conflict TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'dormant', 'disrupted')),
  threat_actors TEXT DEFAULT '[]',
  adversary_countries TEXT DEFAULT '[]',
  adversary_asns TEXT DEFAULT '[]',
  target_countries TEXT DEFAULT '[]',
  target_sectors TEXT DEFAULT '[]',
  target_brands TEXT DEFAULT '[]',
  ttps TEXT DEFAULT '[]',
  escalation_rules TEXT DEFAULT '{}',
  ioc_sources TEXT DEFAULT '[]',
  known_iocs TEXT DEFAULT '[]',
  start_date TEXT NOT NULL,
  end_date TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_geopolitical_campaigns_slug ON geopolitical_campaigns(slug);
CREATE INDEX IF NOT EXISTS idx_geopolitical_campaigns_status ON geopolitical_campaigns(status);

CREATE TABLE IF NOT EXISTS geopolitical_campaign_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  geopolitical_campaign_id TEXT NOT NULL REFERENCES geopolitical_campaigns(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(geopolitical_campaign_id, campaign_id)
);

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

-- ─── A) Add missing columns ───────────────────────────────────────
ALTER TABLE geopolitical_campaigns ADD COLUMN adversary_ip_ranges TEXT DEFAULT '[]';
ALTER TABLE geopolitical_campaigns ADD COLUMN briefing_priority TEXT DEFAULT 'high';
ALTER TABLE geopolitical_campaigns ADD COLUMN notes TEXT;

-- ─── B) Update Iran campaign with full data ───────────────────────
UPDATE geopolitical_campaigns SET
  threat_actors = '["Handala", "Hydro Kitten", "CyberAv3ngers", "Charming Kitten", "MuddyWater", "Agrius", "Cotton Sandstorm"]',
  target_sectors = '["tech", "defense", "healthcare", "finance", "cloud"]',
  target_brands = '["amazon.com", "microsoft.com", "google.com", "apple.com", "oracle.com", "meta.com", "nvidia.com", "tesla.com", "palantir.com", "hp.com", "intel.com", "boeing.com", "dell.com", "cisco.com", "ibm.com", "snapchat.com"]',
  target_countries = '["US", "IL"]',
  adversary_countries = '["IR", "IQ", "SY", "LB", "YE"]',
  adversary_asns = '["AS43754", "AS208137", "AS205585", "AS25184", "AS61173", "AS214567", "AS211421"]',
  ttps = '["T1566.001", "T1566.004", "T1190", "T1485", "T1498", "T1491", "T1078"]',
  briefing_priority = 'critical',
  notes = 'IRGC Tasnim published 18 US tech targets on Mar 31. Handala attacked Stryker Mar 11. AWS data centers hit by drones. Internet blackout in Iran since Feb 28.',
  updated_at = datetime('now')
WHERE id = 'geo-iran-irgc-2026';

-- ─── C) Link geopolitical campaign to campaigns entry ─────────────
INSERT OR IGNORE INTO geopolitical_campaign_links (geopolitical_campaign_id, campaign_id)
SELECT 'geo-iran-irgc-2026', id FROM campaigns WHERE id = 'iran-irgc-retaliation-2026';
