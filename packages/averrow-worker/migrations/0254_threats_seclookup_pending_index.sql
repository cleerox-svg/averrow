-- Partial index for the SecLookup enrichment work-queue.
--
-- Context (D1 spend blowout, 2026-07): the SecLookup feed's candidate
-- SELECT (src/feeds/seclookup.ts) fetches its per-run batch with:
--
--     SELECT DISTINCT id, malicious_domain, ip_address FROM threats
--      WHERE seclookup_checked = 0
--        AND (malicious_domain IS NOT NULL OR ip_address IS NOT NULL)
--        AND first_seen >= datetime('now', '-7 days')
--      ORDER BY CASE severity ... , created_at DESC
--      LIMIT ?
--
-- No index matched, so each run full-scanned the threats table
-- (~34M rows/24h — one of the top D1 queries in the budget blowout).
-- A work-queue SELECT can't be cached (it must see fresh rows), so the
-- fix is an index.
--
-- Selectivity: the unchecked backlog is ~51K rows (~6.5% of the table),
-- so the partial predicate is genuinely selective. Both live filters
-- additionally bound `first_seen >= -7 days`; indexing on first_seen DESC
-- turns that into a bounded range scan at the head of the partial index —
-- SQLite reads only the recent slice. This mirrors idx_threats_dbl_pending
-- (migration 0251), which is likewise a no-severity-filter partial index
-- on first_seen DESC over a time-bounded work-queue SELECT.
--
-- EXPLAIN QUERY PLAN (expected):
--   SEARCH threats USING INDEX idx_threats_seclookup_pending (first_seen>?)
-- with the `(malicious_domain IS NOT NULL OR ip_address IS NOT NULL)`
-- predicate baked into the partial index and the `ORDER BY CASE severity`
-- satisfied by a temp b-tree sort over the small candidate set.
--
-- Column choice: the caller filters/scans on first_seen, so first_seen DESC
-- is the correct indexed key.
--
-- Write amplification: each threats INSERT/UPDATE touching seclookup_checked,
-- malicious_domain, or ip_address writes one index row — same profile as the
-- other *_pending partial indexes, negligible vs the read savings.

CREATE INDEX IF NOT EXISTS idx_threats_seclookup_pending
  ON threats(first_seen DESC)
  WHERE seclookup_checked = 0
    AND (malicious_domain IS NOT NULL OR ip_address IS NOT NULL);
