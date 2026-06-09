-- 0212_disable_dead_feeds_jun2026.sql
--
-- Diagnostics audit 2026-06-09 found three ingest feeds failing 100% of
-- pulls (28-29/28-29) while still enabled, burning a pull every cycle and
-- ingesting zero records. Root causes are all upstream-side and not fixable
-- with a code change from a Cloudflare Worker:
--
--   talos_ips     — Cisco Talos retired the direct
--                   https://www.talosintelligence.com/documents/ip-blacklist
--                   download behind a snort.org terms-acceptance token gate
--                   and now blocks datacenter/cloud egress IPs. Every free
--                   mirror (opendbl, talos S3, snort labs) also 403s or no
--                   longer resolves from a Worker. HTTP 403 on every pull.
--   phishstats    — The :2096 API port is retired (connection timeout) and
--                   the 443 endpoints now sit behind Cloudflare anti-bot,
--                   returning HTTP 403 to datacenter IPs. (Previously
--                   disabled in 0014, re-added as a Tier-A volume feed in
--                   0168, now dead again.)
--   cryptoscamdb  — The JSON dump (data/urls.json) was removed → HTTP 404.
--                   Data survives as data/urls.yaml, but the repo is
--                   abandoned (last commit April 2023), so the URLs are
--                   ~3 years stale and effectively dead. Not worth a
--                   JSON→YAML code change to ingest dead indicators.
--
-- The 4h auto-recovery sweep (lib/feedRunner.ts autoRecoverStalePausedFeeds)
-- only revives feeds paused with reason 'auto:consecutive_failures', so
-- pausing with a 'manual:' reason keeps them paused for good. Same pattern
-- as 0198_pause_dead_feeds.sql and 0208_disable_dead_feeds.sql.
--
-- NOT disabled here: urlscanio. It also 403s, but only because urlscan.io
-- made API auth mandatory on 2026-05-04. The feed code already reads
-- URLSCAN_API_KEY and sends it as the API-Key header — it just needs the
-- secret provisioned on the Worker. Left enabled so it recovers the moment
-- the key is set (`wrangler secret put URLSCAN_API_KEY`).
--
-- To re-enable any feed below: fix the source and set
-- feed_configs.enabled = 1, paused_reason = NULL.

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'manual:upstream_dead — diagnostics-2026-06-09',
       updated_at = datetime('now')
 WHERE feed_name IN ('talos_ips', 'phishstats', 'cryptoscamdb');

-- Clear the circuit-breaker / failure state so they stop tripping the
-- at-risk threshold and the per-feed retry backoff.
UPDATE feed_status
   SET health_status = 'disabled',
       consecutive_failures = 0,
       next_retry_at = NULL,
       last_error = NULL
 WHERE feed_name IN ('talos_ips', 'phishstats', 'cryptoscamdb');
