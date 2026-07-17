-- Migration 0144 — clean up hosting_providers rows with non-canonical
-- asn values (legacy ip-api parsing bug).
--
-- Audit 2026-05-06 (audit C2) caught Cloudflare AS13335 listed twice
-- on /v2/observatory + /v2/providers. Migration 0141 ran but didn't
-- merge them because hosting_providers.asn is UNIQUE and the two rows
-- have DIFFERENT asn values:
--
--   id=hp_AS13335                       asn='AS13335'                    name='Cloudflare, Inc.'
--   id=hp_AS13335 Cloudflare, Inc.      asn='AS13335 Cloudflare, Inc.'   name='Cloudflare'
--
-- The dirty asn comes from a legacy ip-api response handler that
-- captured the full `geo.as` field ("AS13335 Cloudflare, Inc.")
-- instead of just the leading ASN. Cartographer.ts:273 does the
-- correct `.split(' ')[0]` extraction now, so new data is clean —
-- only legacy rows carry the dirty values.
--
-- Probe of the production providers list found 16 dirty rows. This
-- migration handles each via the same per-pair pattern as 0142:
-- repoint threats, delete cube rows, delete the dirty provider row.
-- The clean canonical row (asn='AS<N>') is guaranteed to exist for
-- each pair below; if for some reason it doesn't at apply time,
-- EXISTS guards make the block a no-op.
--
-- D1 CONSTRAINTS observed during 0142's deploy chain: tight
-- per-statement CPU budget, FK enforcement on DELETE. This migration
-- complies by:
--   1. One alias-id per UPDATE (indexed lookup, small CPU)
--   2. EXISTS(canonical) guard prevents writing to NULL FK target
--   3. threats.hosting_provider_id is the only FK to
--      hosting_providers (verified via grep) — repoint then delete
--
-- Future tail of dirty rows beyond the 16 here can be cleaned up in
-- a follow-up; the analyst.ts / cartographer.ts code already
-- prevents new dirty rows from appearing.

-- ─── AS13335 Cloudflare ────────────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS13335' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS13335 Cloudflare, Inc.' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS13335');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS13335 Cloudflare, Inc.' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS13335 Cloudflare, Inc.'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS13335');

-- ─── AS16509 Amazon ────────────────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS16509' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS16509 Amazon.com, Inc.' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS16509');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS16509 Amazon.com, Inc.' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS16509 Amazon.com, Inc.'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS16509');

-- ─── AS45102 Alibaba ───────────────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS45102' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS45102 Alibaba (US) Technology Co., Ltd.' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS45102');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS45102 Alibaba (US) Technology Co., Ltd.' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS45102 Alibaba (US) Technology Co., Ltd.'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS45102');

-- ─── AS54113 Fastly ────────────────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS54113' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS54113 Fastly, Inc.' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS54113');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS54113 Fastly, Inc.' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS54113 Fastly, Inc.'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS54113');

-- ─── AS8075 Microsoft ──────────────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS8075' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS8075 Microsoft Corporation' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS8075');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS8075 Microsoft Corporation' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS8075 Microsoft Corporation'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS8075');

-- ─── AS396982 Google Cloud ─────────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS396982' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS396982 Google LLC' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS396982');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS396982 Google LLC' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS396982 Google LLC'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS396982');

-- ─── AS27647 Weebly ────────────────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS27647' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS27647 Weebly, Inc.' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS27647');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS27647 Weebly, Inc.' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS27647 Weebly, Inc.'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS27647');

-- ─── AS24940 Hetzner ───────────────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS24940' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS24940 Hetzner Online GmbH' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS24940');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS24940 Hetzner Online GmbH' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS24940 Hetzner Online GmbH'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS24940');

-- ─── AS40680 Protocol Labs ─────────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS40680' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS40680 Protocol Labs' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS40680');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS40680 Protocol Labs' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS40680 Protocol Labs'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS40680');

-- ─── AS19871 Network Solutions ─────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS19871' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS19871 Network Solutions, LLC' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS19871');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS19871 Network Solutions, LLC' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS19871 Network Solutions, LLC'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS19871');

-- ─── AS205775 Neon Core Network ────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS205775' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS205775 NEON CORE NETWORK LLC' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS205775');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS205775 NEON CORE NETWORK LLC' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS205775 NEON CORE NETWORK LLC'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS205775');

-- ─── AS135392 MillenialHost / HostPapa ─────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS135392' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS135392 MillenialHost Limited' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS135392');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS135392 MillenialHost Limited' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS135392 MillenialHost Limited'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS135392');

-- ─── AS51852 Private Layer ─────────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS51852' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS51852 Private Layer INC' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS51852');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS51852 Private Layer INC' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS51852 Private Layer INC'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS51852');

-- ─── AS40401 Backblaze ─────────────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS40401' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS40401 Backblaze Inc' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS40401');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS40401 Backblaze Inc' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS40401 Backblaze Inc'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS40401');

-- ─── AS210558 1337 Services ────────────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS210558' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS210558 1337 Services GmbH' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS210558');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS210558 1337 Services GmbH' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS210558 1337 Services GmbH'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS210558');

-- ─── AS215540 Global Connectivity ──────────────────────────────
UPDATE threats SET hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS215540' LIMIT 1)
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS215540 GLOBAL CONNECTIVITY SOLUTIONS LLP' LIMIT 1)
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS215540');
DELETE FROM threat_cube_provider
  WHERE hosting_provider_id = (SELECT id FROM hosting_providers WHERE asn = 'AS215540 GLOBAL CONNECTIVITY SOLUTIONS LLP' LIMIT 1);
DELETE FROM hosting_providers
  WHERE asn = 'AS215540 GLOBAL CONNECTIVITY SOLUTIONS LLP'
    AND EXISTS (SELECT 1 FROM hosting_providers WHERE asn = 'AS215540');
