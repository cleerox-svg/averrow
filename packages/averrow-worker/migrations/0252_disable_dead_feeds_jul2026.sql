-- Re-disable six dead/gated ingest feeds — diagnostics 2026-07-23.
--
-- These same feeds were disabled before (0208: c2_tracker/phishtank,
-- 0212: talos_ips/phishstats/cryptoscamdb, 0213: urlscanio) but the
-- live platform-diagnostics run on 2026-07-23 shows every one of them
-- back to `enabled = 1, paused_reason = NULL` and failing 100% of pulls
-- (28 dead pulls each in 24h, two already at the 5/5 auto-pause
-- threshold). Nothing in the codebase re-seeds feed_configs, so the
-- rows were re-enabled manually after the June disables — most likely
-- during the feed-expansion work (PR #1694). Whoever re-enables feeds
-- via the admin toggle should treat these six as intentionally retired:
-- the upstreams are dead or gated, not transiently down.
--
-- Ground-truth failure per feed (from feeds.recent_errors):
--   c2_tracker   — montysecurity/C2-Tracker GitHub repo ARCHIVED; data/
--                  removed. Module is already a clean-throw stub
--                  (feeds/c2tracker.ts). No maintained mirror.
--   phishtank    — anonymous online-valid.json returns non-JSON garbage
--                  (Exif/image bytes) / HTTP 4xx; PhishTank now requires
--                  a registered app + API key. Re-enable needs a key.
--   phishstats   — PhishStats :2096 API returns HTTP 404; the endpoint
--                  is retired (this is its 3rd disable — see 0014, 0212).
--   talos_ips    — HTTP 403. Cisco Talos blocks automated fetches of the
--                  ip-blacklist document (browser/Cloudflare gate).
--   urlscanio    — HTTP 403 "your current plan does not allow you to
--                  search field 'verdicts.overall.malicious'". urlscan
--                  moved verdict-field search behind a paid plan; the
--                  free tier can no longer run the malicious-URL query.
--                  Re-enable needs a Pro plan + URLSCAN_API_KEY.
--   cryptoscamdb — HTTP 404. CryptoScamDB moved data/urls.json ->
--                  data/urls.yaml (now YAML, ~2.16 MB). Re-enable needs
--                  a YAML parser + a switch of source_url to urls.yaml;
--                  deferred (worker has no YAML dep, keeps a 4-dep
--                  footprint).
--
-- To re-enable any of these: fix the underlying cause noted above, then
-- set feed_configs.enabled = 1, paused_reason = NULL for that feed_name.

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'manual:upstream_dead — diagnostics-2026-07-23 (archived/retired/gated)',
       updated_at = datetime('now')
 WHERE feed_name IN (
   'c2_tracker', 'phishtank', 'phishstats',
   'talos_ips', 'urlscanio', 'cryptoscamdb'
 );

-- Clear the circuit-breaker / failure state so the retired feeds stop
-- tripping the at-risk threshold and the per-feed retry backoff.
UPDATE feed_status
   SET health_status = 'disabled',
       consecutive_failures = 0,
       next_retry_at = NULL,
       last_error = NULL
 WHERE feed_name IN (
   'c2_tracker', 'phishtank', 'phishstats',
   'talos_ips', 'urlscanio', 'cryptoscamdb'
 );
