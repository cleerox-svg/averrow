-- Disable two feeds whose data the platform may not use commercially —
-- licence / rot audit 2026-11-14 (report "Free threat feeds and signal
-- techniques", section "Seven live integrations carry licence or rot
-- problems"). Code for both feeds is kept; only the feed_configs row is
-- turned off.
--
--   spamhaus_dbl — Spamhaus DBL over Cloudflare's public DoH resolver.
--                  Two problems:
--                  1. Licence: the free DBL tiers (public mirrors and the
--                     free Data Query Service) are for NON-COMMERCIAL use
--                     only. Averrow is a paid product.
--                  2. Blind: Spamhaus answers queries from public/open
--                     resolvers with the error code 127.255.255.254 (live
--                     test 2026-11-14: dbltest.com.dbl.spamhaus.org ->
--                     127.255.255.254 via cloudflare-dns.com). The old
--                     decoder accepted only 127.0.1.x as a listing, so
--                     every lookup was read as clean and the threat row
--                     stamped dbl_checked = 1 / dbl_listed = 0. The
--                     decoder now treats 127.255.255.x as a lookup error
--                     and the run self-tests on dbltest.com
--                     (feeds/spamhausDbl.ts), but the licence still bars
--                     running it.
--                  Re-enable ONLY with a Spamhaus Technology commercial
--                  subscription (DQS key) and a lookup path that uses it
--                  (the code still queries the public zone through
--                  cloudflare-dns.com, which Spamhaus refuses).
--
--   dshield      — SANS Internet Storm Center top-IPs API. The ISC API
--                  data is licensed CC BY-NC-SA 4.0 (non-commercial,
--                  share-alike). Re-enable only with written permission
--                  from SANS ISC for commercial use.
--
-- The `manual:` paused_reason prefix keeps both feeds out of the
-- auto-pause / degraded / silent-feed alerts (those read enabled = 1, or
-- paused_reason = 'auto:consecutive_failures'), and Flight Control skips
-- the enrichment backlog warning + stall series for a feed disabled this
-- way (agents/flightControl.ts, manuallyDisabledFeeds).
--
-- To re-enable: meet the condition above, then set
-- feed_configs.enabled = 1, paused_reason = NULL for that feed_name.

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'manual:licence_noncommercial — Spamhaus DBL free tiers are non-commercial and public resolvers are refused (127.255.255.254); re-enable only with a Spamhaus Technology subscription / DQS key',
       updated_at = datetime('now')
 WHERE feed_name = 'spamhaus_dbl';

UPDATE feed_configs
   SET enabled = 0,
       paused_reason = 'manual:licence_noncommercial — SANS ISC API data is CC BY-NC-SA 4.0; re-enable only with written permission from SANS',
       updated_at = datetime('now')
 WHERE feed_name = 'dshield';

-- Clear circuit-breaker / failure state so the retired feeds stop
-- tripping the at-risk threshold and the per-feed retry backoff.
UPDATE feed_status
   SET health_status = 'disabled',
       consecutive_failures = 0,
       next_retry_at = NULL,
       last_error = NULL
 WHERE feed_name IN ('spamhaus_dbl', 'dshield');
