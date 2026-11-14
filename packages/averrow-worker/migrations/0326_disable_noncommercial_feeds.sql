-- Disable three feeds whose data the platform may not use commercially or
-- cannot currently read — licence / rot audit 2026-11-14 (report "Free threat feeds and signal
-- techniques", section "Seven live integrations carry licence or rot
-- problems"). Code for all three feeds is kept; only the feed_configs row
-- is turned off.
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
--   surbl        — SURBL multi.surbl.org over Cloudflare's public DoH
--                  resolver. Blind: the permanent test point
--                  (surbl-org-permanent-test-point.com), test.surbl.org and
--                  example.com all answered SERVFAIL "EDE(22): No Reachable
--                  Authority at delegation multi.surbl.org" (three
--                  independent live checks, 2026-11-13/14). The old decoder
--                  read SERVFAIL as clean and stamped surbl_checked = 1.
--                  The feed now self-tests and fails the pull instead
--                  (feeds/surbl.ts), but left enabled that would fail
--                  every pull -> auto-pause -> critical notification +
--                  incident -> 4h auto-recover -> repeat, so it is retired
--                  here. SURBL's commercial terms were also never verified.
--                  Re-enable ONLY with a working SURBL access route (a
--                  resolver/data feed SURBL answers; the self-test must
--                  pass) AND a check that SURBL's licence permits
--                  commercial use.
--
-- The `manual:` paused_reason prefix keeps all three feeds out of the
-- auto-pause / degraded / silent-feed alerts (those read enabled = 1, or
-- paused_reason = 'auto:consecutive_failures'), and Flight Control skips
-- the enrichment backlog warning + stall series for a feed disabled this
-- way (agents/flightControl.ts, loadManuallyDisabledFeeds — covers the
-- SURBL and DBL backlog counters).
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
       paused_reason = 'manual:blind_resolver — SURBL answers SERVFAIL (No Reachable Authority) via public DoH resolvers; commercial terms unverified; re-enable only with a working SURBL access route (self-test passes) and a licence check',
       updated_at = datetime('now')
 WHERE feed_name = 'surbl';

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
 WHERE feed_name IN ('spamhaus_dbl', 'dshield', 'surbl');
