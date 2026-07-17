-- Sweep up any hosting_providers rows still carrying non-canonical ids
-- after migration 0112 + PR #831's source-path fixes.
--
-- Migration 0112 canonicalized everything that existed at 02:23 UTC. But
-- two non-cartographer insert paths were still creating legacy ids:
--   - lib/geoip.ts:upsertHostingProvider (used by lib/enrichment.ts which
--     runs every hourly orchestrator tick)
--   - workflows/cartographerBackfill.ts (Cloudflare Workflow path)
-- Both get fixed in PR #831 to use canonical hp_${asn}, but rows created
-- between 0112's apply and the new code's deploy stayed legacy.
--
-- This migration is identical in shape to 0112; different file name so
-- D1's migration tracker re-runs the body. The expected steady-state
-- count is 0 after this. PR #831's source-path fix means no new legacy
-- rows should appear after deploy.
--
-- defer_foreign_keys is the same pattern that made 0112 succeed —
-- threats and threat_cube_provider are updated alongside hosting_providers
-- in one transaction; FK checks fire at commit when state is consistent.

PRAGMA defer_foreign_keys = ON;

-- Step 1: Update threats.hosting_provider_id
UPDATE threats
SET hosting_provider_id = 'hp_' || (
  SELECT asn FROM hosting_providers hp
  WHERE hp.id = threats.hosting_provider_id
    AND hp.asn IS NOT NULL
    AND hp.asn != ''
)
WHERE hosting_provider_id IN (
  SELECT id FROM hosting_providers
  WHERE asn IS NOT NULL AND asn != '' AND id != 'hp_' || asn
);

-- Step 2: Update threat_cube_provider.hosting_provider_id
UPDATE threat_cube_provider
SET hosting_provider_id = 'hp_' || (
  SELECT asn FROM hosting_providers hp
  WHERE hp.id = threat_cube_provider.hosting_provider_id
    AND hp.asn IS NOT NULL
    AND hp.asn != ''
)
WHERE hosting_provider_id IN (
  SELECT id FROM hosting_providers
  WHERE asn IS NOT NULL AND asn != '' AND id != 'hp_' || asn
);

-- Step 3: Rename hosting_providers.id to canonical form
UPDATE hosting_providers
SET id = 'hp_' || asn
WHERE asn IS NOT NULL AND asn != '' AND id != 'hp_' || asn;
