-- Retire five ingest feeds whose upstreams are dead — owner decision 2026-10-30.
--
-- All five have been disabled since migration 0252 (2026-07-23) with
-- paused_reason 'manual:upstream_dead — diagnostics-2026-07-23
-- (archived/retired/gated)'. Their modules were removed from
-- src/feeds/ and from the feedModules registry in the same change as
-- this migration, so a re-enable would now be a no-op: runAllFeeds
-- skips any feed_configs row with no registered module, and the manual
-- trigger answers 501.
--
--   phishtank    — PhishTank closed to anonymous access / unreliable
--   phishstats   — phishstats.info offline
--   cryptoscamdb — GitHub list returns 404
--   talos_ips    — Cisco Talos removed the public IP blocklist
--   c2_tracker   — montysecurity/C2-Tracker archived
--
-- Additive only: the feed_configs / feed_status rows stay, and every
-- historical threats row keeps its source_feed label (scoring, labels
-- and classification of those rows are unchanged). enabled stays 0;
-- only paused_reason and updated_at change.

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'retired-2026-10-30: upstream dead, ingestion module removed (PhishTank closed/unreliable)',
       updated_at = datetime('now')
 WHERE feed_name = 'phishtank';

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'retired-2026-10-30: upstream dead, ingestion module removed (phishstats.info offline)',
       updated_at = datetime('now')
 WHERE feed_name = 'phishstats';

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'retired-2026-10-30: upstream dead, ingestion module removed (CryptoScamDB GitHub list 404)',
       updated_at = datetime('now')
 WHERE feed_name = 'cryptoscamdb';

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'retired-2026-10-30: upstream dead, ingestion module removed (Cisco Talos public IP blocklist removed)',
       updated_at = datetime('now')
 WHERE feed_name = 'talos_ips';

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'retired-2026-10-30: upstream dead, ingestion module removed (montysecurity/C2-Tracker archived)',
       updated_at = datetime('now')
 WHERE feed_name = 'c2_tracker';
