-- Trust Radar — backstop the OTX TAXII cold-start cursor.
--
-- After PR #1267 fixed the OTX TAXII root URL, pulls reached the
-- server cleanly but every pull hung for >15 min and got reaped
-- by the navigator feed-pull reaper (24 h diagnostic 12:08 UTC:
-- 11 pulls, 0 success, 10 reaped). The REST `otx_alienvault`
-- feed at the same time was healthy (6/6 success, 35 records).
--
-- Root cause: with `taxii_next_added_after = NULL` the consumer
-- sends NO `added_after` query param. Per TAXII 2.1 spec, the
-- server returns ALL objects from the start of time. OTX's
-- `user_AlienVault` collection has years of pulse history, so
-- the response is potentially gigabytes — the body parse + per-
-- row D1 inserts can't complete inside the 15-min feed-pull
-- reaper window.
--
-- The REST OTX path handles this by sending `modified_since =
-- now - 24h` on every request. This migration applies the same
-- backstop to the TAXII path: set the cursor to 24h ago so the
-- first pull asks for one day's worth of data (~thousands of
-- IOCs, not millions). Subsequent pulls advance the cursor from
-- the X-TAXII-Date-Added-Last response header as designed.
--
-- Operators that want to re-pull more history can manually UPDATE
-- the cursor to an earlier timestamp; the upper bound is enforced
-- only by the per-pull batch_size + the wall-clock guard added in
-- the companion code change to feeds/taxii.ts.

UPDATE feed_configs
   SET taxii_next_added_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours'),
       updated_at             = datetime('now')
 WHERE feed_name = 'taxii_otx'
   AND taxii_next_added_after IS NULL;
