-- 0277_threats_asn_gsb_indexes.sql
-- D1 read-spend (2026-10, read guard in `skip`: 816M rows/24h vs 833M
-- budget). Two missing indexes on `threats`, each found by EXPLAIN QUERY
-- PLAN against prod as a full `SCAN threats`.
--
-- ── 1. idx_threats_asn (~70M reads/24h) ─────────────────────────────
-- lib/threat-aggregates.ts (`/api/threats/aggregate`) joins
--     threats t JOIN threat_actor_infrastructure tai ON tai.asn = t.asn
-- for the `attributed` count, `top_actors` and `multi_brand_actors`. The
-- only asn index on threats is the partial idx_threats_asn_type_unclustered
-- (WHERE cluster_id IS NULL, migration 0176), which these queries cannot
-- use, so SQLite drove from the small tai side and SCANned threats once
-- per tai row. With this index the join is an index SEARCH per tai row:
--     SEARCH t USING INDEX idx_threats_asn (asn=?)
-- Partial on `asn IS NOT NULL`: SQLite treats the `x = y` join term as
-- implying `t.asn IS NOT NULL`, so the join qualifies for the partial
-- index without any query change, and the (large) asn-less tail of the
-- table stays out of it.
--
-- ── 2. idx_threats_gsb_pending (~40M reads/24h) ─────────────────────
-- feeds/googleSafeBrowsing.ts (candidate SELECT) and
-- agents/flightControl.ts (`backlog.gsb` counter) both filter:
--     WHERE gsb_checked = 0
--       AND (malicious_url IS NOT NULL OR malicious_domain IS NOT NULL)
--       AND first_seen >= datetime('now', '-7 days')
-- Every sibling enrichment queue (dbl 0251, seclookup 0254, vt, pdns,
-- abuseipdb) has a `*_pending` partial index; gsb never got one. Same
-- shape as idx_threats_dbl_pending: keyed on first_seen DESC so the
-- 7-day bound is a range scan at the head of the index. The index WHERE
-- copies the queries' predicate text exactly (SQLite only uses a partial
-- index when the query's WHERE provably implies the index's WHERE):
--     SEARCH threats USING INDEX idx_threats_gsb_pending (first_seen>?)
--
-- Prod vs migrations (verified read-only against prod 2026-10-04): prod
-- plans this query as `SCAN threats` + a temp b-tree. Migration 0001
-- creates idx_threats_first_seen, so a schema rebuilt from migrations/
-- (the test harness) can range-seek first_seen with no new index. Prod
-- has no idx_threats_first_seen; it was dropped out of band. The only prod
-- indexes on first_seen / gsb / asn are idx_threats_gsb_flagged_brand and
-- idx_threats_asn_type_unclustered, and neither serves this predicate. So
-- the index IS needed in prod; the test drops idx_threats_first_seen
-- before planning to mirror prod.
--
-- Selectivity: gsb_checked = 0 stays set on old rows the feed never
-- reached (it only scans the last 7 days, 100 rows a run), so this partial
-- index still covers most URL/domain-bearing threats. The win is NOT a
-- small index; it is the first_seen range seek that reads only the 7-day
-- head instead of the whole table. Cost: one index write per threats
-- insert (and per gsb_checked flip).
--
-- Cost: each is a one-time build over ~1.25M threats rows (≈1.25M rows
-- read apiece, ≈2.5M total — paid back within the first hour of the
-- reads it removes). Write amplification: one index row per threats
-- write touching asn / gsb_checked / malicious_url / malicious_domain /
-- first_seen, same profile as the other partial indexes.
--
-- Additive only: CREATE INDEX IF NOT EXISTS, no table or column changes.

CREATE INDEX IF NOT EXISTS idx_threats_asn
  ON threats(asn)
  WHERE asn IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_threats_gsb_pending
  ON threats(first_seen DESC)
  WHERE gsb_checked = 0
    AND (malicious_url IS NOT NULL OR malicious_domain IS NOT NULL);
