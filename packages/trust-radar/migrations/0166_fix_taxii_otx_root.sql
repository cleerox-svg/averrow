-- Trust Radar — Fix the OTX TAXII root URL seeded in migration 0165.
--
-- 0165 seeded taxii_root_url = 'https://otx.alienvault.com/taxii/2.1/'
-- because the spec dirs in some TAXII server docs do route per-
-- version. OTX does NOT route that way — its TAXII 2.1 root is
-- located at /taxii/root/ and content negotiates via the
-- `Accept: application/taxii+json;version=2.1` header (which our
-- client at lib/taxii-client.ts already sends). Without this fix
-- the first OTX pull returns HTTP 404 because the URL we build
-- is collections/<id>/objects/ relative to a non-existent root.
--
-- Confirmed live (2026-05-12 03:11 UTC): the bad URL was
-- https://otx.alienvault.com/taxii/2.1/collections/user_AlienVault/objects/
-- and the correct URL is
-- https://otx.alienvault.com/taxii/root/collections/user_AlienVault/objects/.
--
-- Both the source_url (display) and taxii_root_url (runtime)
-- columns are updated. The collection_id stays `user_AlienVault` —
-- that part was right; only the root path needed correcting.

UPDATE feed_configs
   SET taxii_root_url = 'https://otx.alienvault.com/taxii/root/',
       source_url      = 'https://otx.alienvault.com/taxii/root/',
       updated_at      = datetime('now')
 WHERE feed_name = 'taxii_otx';
