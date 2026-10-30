-- Retire the Have I Been Pwned (HIBP) stealer-log feed — owner decision 2026-10-30.
--
-- The HIBP Pro subscription the feed needed is too expensive and will
-- never be purchased. The feed was registered disabled in migration 0051,
-- has carried paused_reason 'manual' since 2026-03-29, never completed a
-- pull, and HIBP_API_KEY was never set. Its module (src/feeds/hibp.ts) and
-- every caller were removed in the same change as this migration, so a
-- re-enable would now be a no-op: runAllEnrichmentFeeds only iterates
-- registered modules.
--
-- Additive only: the feed_configs / feed_status rows and the
-- stealer_log_results table (0051, never populated) stay as history.
-- enabled stays 0; only paused_reason changes.

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'retired-2026-10-30: HIBP integration removed (paid subscription will not be purchased)'
 WHERE feed_name = 'hibp_stealer_logs';
