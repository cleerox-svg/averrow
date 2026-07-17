-- 0213_disable_urlscanio.sql
--
-- Disable the urlscanio ingest feed. It has failed 100% of pulls since
-- urlscan.io made API auth mandatory (2026-05-04) AND restricted the
-- maliciousness-signal search fields to paid plans. The feed's query
-- relied on `verdicts.overall.malicious` / `verdicts.urlscan.score`;
-- the live 403 body (captured after #1465) reads:
--
--   "Your current plan does not allow you to search field
--    'verdicts.overall.malicious'"
--
-- On urlscan's free tier the only searchable fields are infrastructure/
-- identity (domain, page.url, page.title, asn, country, ip, filename,
-- date) — none of which signal maliciousness — and the verdict/tag/
-- content fields that do are all Pro-gated (and urlscan keeps moving
-- more behind the paywall: verdicts in 2026-05, tags in 2024). There is
-- no sustainable free-tier query that finds malicious URLs, and a
-- recency-only query would flood `threats` with benign public scans.
--
-- The platform already gets phishing coverage from feeds that are free
-- AND carry a maliciousness signal: openphish, urlhaus, phishdestroy,
-- threatfox. urlscan is not needed as a free source.
--
-- This is NOT an upstream-dead case — the URLSCAN_API_KEY secret and the
-- feed code are correct and ready. To re-enable: move that key to an
-- urlscan Pro plan (the original verdict-field query then works with no
-- code change) and set feed_configs.enabled = 1, paused_reason = NULL.
--
-- Paused with a 'manual:' reason so the 4h auto-recovery sweep
-- (lib/feedRunner.ts autoRecoverStalePausedFeeds) won't revive it. Same
-- pattern as 0208 / 0212.

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'manual:requires_pro_plan — urlscan free tier cannot search malicious verdicts (diagnostics-2026-06-09)',
       updated_at = datetime('now')
 WHERE feed_name = 'urlscanio';

-- Clear the circuit-breaker / failure state so it stops tripping the
-- at-risk threshold and the per-feed retry backoff.
UPDATE feed_status
   SET health_status = 'disabled',
       consecutive_failures = 0,
       next_retry_at = NULL,
       last_error = NULL
 WHERE feed_name = 'urlscanio';
