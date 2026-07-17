-- Post-launch fixes for the new no-auth feeds shipped in
-- #1270 / #1273 / #1274 / #1275. Diagnostics 6h after launch
-- revealed five distinct issues. We apply the minimum-viable
-- fix per feed; deeper rework lives in follow-up PRs.
--
-- ── taxii_otx — reduce batch_size 500 → 100 ────────────────
-- Pulls 10/12 reaped at 15min (worker CPU budget exhausted
-- before Promise.race timeout could fire). One TAXII page is
-- 500 STIX objects → 500 sequential D1 inserts → blows the
-- scheduled-handler CPU ceiling. Smaller pages drain the
-- backlog over more ticks instead of timing out every tick.
--
-- ── nvd_cve — disable + purge bad rows ──────────────────────
-- The module wrote 419 CVE rows to the `threats` table with
-- threat_type='malicious_ip' (a CVE is not an IP). The platform
-- convention for vulnerability data is to write to
-- agent_outputs as type='insight' (see feeds/cisa_kev.ts).
-- Disable until the module is re-architected; purge the bad
-- rows so they don't pollute aggregates.
--
-- ── phishstats / cryptoscamdb / talos_ips — HTTP 404 ───────
-- All three upstream URLs return 404. They were either always
-- broken on our end OR the upstreams moved/removed the
-- endpoints. Disable with explicit paused_reason so a future
-- session can revisit once the right URLs are confirmed.
--
-- ── urlscanio — HTTP 403 ───────────────────────────────────
-- urlscan.io tightened their public search in 2024 — the
-- previously-keyless endpoint now requires an API key. Disable
-- here; re-enable once we register and drop the key in a
-- Worker secret.

-- 1. taxii_otx: 500 → 100
UPDATE feed_configs
   SET batch_size = 100,
       updated_at = datetime('now')
 WHERE feed_name = 'taxii_otx';

-- 2. nvd_cve: disable + purge polluted threats
UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'wrong_threat_type_2026-05-12:cves_belong_in_agent_outputs',
       updated_at = datetime('now')
 WHERE feed_name = 'nvd_cve';

DELETE FROM threats WHERE source_feed = 'nvd_cve';

-- 3. Dead-URL feeds
UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'upstream_404_2026-05-12',
       updated_at = datetime('now')
 WHERE feed_name IN ('phishstats', 'cryptoscamdb', 'talos_ips');

-- 4. urlscan.io: needs API key now
UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'requires_api_key_2026-05-12:set_URLSCAN_API_KEY_secret_to_reenable',
       updated_at = datetime('now')
 WHERE feed_name = 'urlscanio';
