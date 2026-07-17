-- Migration 0062: Add missing brands, Iran IRGC campaign, and tag existing threats
-- Priority 1 items: brands (Meta, Palantir), campaign creation, threat tagging
-- NOTE: source column on brands and description column on campaigns already exist in production

-- ─── A) Add Meta to monitored_brands ────────────────────────────────
INSERT OR IGNORE INTO monitored_brands (brand_id, tenant_id, added_by, status)
SELECT id, '__internal__', 'aae5bfa2-e702-4d48-99f9-4adef43a8330', 'active'
FROM brands WHERE canonical_domain = 'meta.com';

-- ─── B) Add Palantir to brands + monitored_brands ──────────────────
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, threat_count)
VALUES ('brand_palantir', 'Palantir', 'palantir.com', 'tech', 'manual', 0);

INSERT OR IGNORE INTO monitored_brands (brand_id, tenant_id, added_by, status)
VALUES ('brand_palantir', '__internal__', 'aae5bfa2-e702-4d48-99f9-4adef43a8330', 'active');

-- Clean up stale palantir-com ID if it was inserted by a failed prior run
DELETE FROM monitored_brands WHERE brand_id = 'palantir-com';
DELETE FROM brands WHERE id = 'palantir-com';

-- ─── C) Create Iran IRGC Retaliation Campaign ──────────────────────
INSERT OR IGNORE INTO campaigns (id, name, description, attack_pattern, status)
VALUES (
  'iran-irgc-retaliation-2026',
  'IRGC Retaliation Campaign — Operation Epic Fury Response',
  'Iranian state-sponsored and hacktivist cyber operations targeting US tech companies in retaliation for Operation Epic Fury strikes. Named targets include Amazon, Microsoft, Google, Apple, Oracle, and 13 others. Threat actors: Handala (MOIS), Hydro Kitten (IRGC), CyberAv3ngers. TTPs: credential harvesting, wiper attacks, DDoS, website defacement, subdomain brand spoofing, vishing.',
  'credential_harvesting,wiper,ddos,defacement,vishing',
  'active'
);

-- ─── D) Tag existing Iranian threats to campaign ────────────────────
UPDATE threats SET campaign_id = 'iran-irgc-retaliation-2026'
WHERE country_code = 'IR'
AND first_seen >= '2026-02-28'
AND campaign_id IS NULL;
