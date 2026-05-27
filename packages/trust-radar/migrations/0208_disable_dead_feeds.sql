-- 0208_disable_dead_feeds.sql
--
-- Two feeds have permanently-dead upstreams and were stuck in a
-- pause → 4h-auto-recover → fail → re-pause loop, generating a steady
-- stream of platform_feed_at_risk / platform_feed_auto_paused /
-- platform_feed_silent notifications (platform audit 2026-05-27):
--
--   c2_tracker  — montysecurity/C2-Tracker GitHub repo archived; the
--                 data/ directory no longer exists, every source URL
--                 404s (see src/feeds/c2tracker.ts which now throws a
--                 permanent error before fetching).
--   phishtank   — http://data.phishtank.com/data/online-valid.json is
--                 dead for anonymous access: HTTP 429 rate-limit on
--                 every pull, and HTTP 404 returning binary/JPEG bytes.
--                 Effectively requires a registered API key we don't
--                 have (see src/feeds/phishtank.ts).
--
-- The 4h auto-recovery sweep (lib/feedRunner.ts autoRecoverStalePausedFeeds)
-- only revives feeds paused with reason 'auto:consecutive_failures', so
-- pausing them with a 'manual:' reason keeps them paused for good. Same
-- pattern as 0198_pause_dead_feeds.sql.
--
-- To re-enable: fix the source (replace c2tracker.ts source list / add a
-- PhishTank API key) and set feed_configs.enabled = 1, paused_reason = NULL.

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'manual:upstream_dead — platform-audit-2026-05-27',
       updated_at = datetime('now')
 WHERE feed_name IN ('c2_tracker', 'phishtank');

-- Clear the circuit-breaker / failure state so they stop tripping the
-- at-risk threshold and the per-feed retry backoff.
UPDATE feed_status
   SET health_status = 'disabled',
       consecutive_failures = 0,
       next_retry_at = NULL,
       last_error = NULL
 WHERE feed_name IN ('c2_tracker', 'phishtank');
