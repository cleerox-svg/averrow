-- Trust Radar — reset the wedged taxii_otx cursor.
--
-- Live diagnostic 2026-05-20 01:37 UTC observed:
--   • taxii_otx.records_ingested = 0 over 6h across 6 "successful"
--     pulls and 8 timeouts at the 12-min wall-clock guard.
--   • feed_configs.taxii_next_added_after = 'None' (literal string).
--
-- Two compounding failures got the column into this state:
--   1. A 'None'-serialization leak (last seen 2026-05-13, addressed
--      on the READ side in lib/taxii-client.ts but never on the
--      WRITE side in feeds/taxii.ts). Some path — most likely the
--      upstream OTX response header `x-taxii-date-added-last:
--      None` on an empty window — got written verbatim into the
--      column.
--   2. The cursor-advancement guard `fetched.nextCursor > cursor`
--      did a lexicographic compare. Any real ISO timestamp starts
--      with a digit ('2'=0x32); 'None' starts with 'N'=0x4E. So
--      every real future cursor compared LESS THAN 'None' and was
--      rejected. The feed wedged on the OTX epoch backlog and
--      every page came back all-duplicates.
--
-- The companion code change in feeds/taxii.ts now:
--   • Treats "None"/"null"/empty values as "no cursor" on both
--     READ and WRITE so this can't repeat.
--   • Drops the redundant SELECT-before-INSERT dedup that doubled
--     D1 round-trips per indicator (per CLAUDE.md §8: use
--     INSERT OR IGNORE, not SELECT-then-INSERT). This was pushing
--     the 9-min inner budget into the 12-min outer wall guard.
--
-- This migration unsticks the live cursor by setting it to 24h
-- ago — same backstop migration 0169 applied when the column was
-- NULL. The guard here also catches the 'None'/'null' sentinel
-- so the fix is idempotent if either value resurfaces.

UPDATE feed_configs
   SET taxii_next_added_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours'),
       updated_at             = datetime('now')
 WHERE feed_name = 'taxii_otx'
   AND (taxii_next_added_after IS NULL
        OR taxii_next_added_after = 'None'
        OR taxii_next_added_after = 'null'
        OR taxii_next_added_after = '');
