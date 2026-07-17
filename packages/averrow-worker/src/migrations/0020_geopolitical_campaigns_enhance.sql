-- 0020_geopolitical_campaigns_enhance.sql
-- Enhance geopolitical_campaigns table with missing fields from spec
-- Update Iran campaign seed with full threat actor list and target brands
-- Link geopolitical campaign to campaigns table

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
