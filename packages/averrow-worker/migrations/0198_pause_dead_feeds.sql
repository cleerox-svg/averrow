-- 0198_pause_dead_feeds.sql
--
-- Tier 1 of the 2026-05-16 platform audit. Pause four feeds that
-- pull successfully but produce zero usable data:
--
--   * urlscanio          — 100% failure rate, 0 rows ingested in 7d
--   * cloudflare_scanner — 188 pulls/7d; the four columns it writes
--                          (cf_scan_id, cf_verdict, cf_categories,
--                          cf_rank) are 99.94-100% NULL across the
--                          355K-row threats table AND have zero
--                          read consumers anywhere in src/
--   * digitalside_osint  — 0 rows ingested in 30d; no threats with
--                          source_feed='digitalside_osint' exist
--   * c2_intel_feeds     — 0 rows ingested in 7d; no readers
--
-- The other zero-ingest feeds flagged in the audit
-- (surbl/spamhaus_dbl/seclookup/dshield/emerging_threats) are NOT
-- paused here because they're enrichment-pattern feeds that update
-- existing threat columns rather than insert new rows; pausing them
-- could mask the first true positive. Those need manual review.
--
-- Reversible: clear paused_reason + set enabled=1 in feed_configs.

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'platform-audit-2026-05-16: 100% failure / zero useful data'
 WHERE feed_name IN (
   'urlscanio',
   'cloudflare_scanner',
   'digitalside_osint',
   'c2_intel_feeds'
 );
