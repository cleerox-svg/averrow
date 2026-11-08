-- 0322 — partial indexes for three `threats` work-queue reads that full-scan.
--
-- ── Why ──────────────────────────────────────────────────────────────
-- prod d1_top_queries_24h, 2026-11-08 (while D1 was returning
-- `D1 DB is overloaded`), rows read per call:
--
--   idx_threats_active_no_geo — Flight Control `backlog.total_no_geo`
--     `(lat IS NULL OR lng IS NULL) AND status = 'active'` walked every
--     active threat through idx_threats_status_created (~1.5M rows). FC now
--     runs a bounded probe (≤ 5001 rows, the `> 5000` gate) that seeks this
--     index.
--
--   idx_threats_ip_no_provider — Cartographer `count.threats.without_provider`
--     `hosting_provider_id IS NULL AND ip_address IS NOT NULL` walked every
--     NULL-provider row of idx_threats_provider (~644K rows, most of them
--     domain-only threats with no IP). The index holds only rows that have
--     an IP and still lack a provider.
--
--   idx_threats_surbl_pending — the SURBL feed's work SELECT and FC's
--     `backlog.surbl.pending` count (one shared WHERE) walked
--     idx_threats_domain (~426K rows). The index holds only unchecked
--     domain rows keyed by created_at, so the 7-day range is a seek.
--
-- Each partial WHERE is the text of a constant in
-- src/lib/threat-rescan-predicates.ts (ACTIVE_NO_GEO_SQL, IP_NO_PROVIDER_SQL,
-- SURBL_PENDING_SQL). SQLite only uses a partial index when the query's
-- WHERE contains every index term, so the two must stay identical;
-- test/d1-rescan-partial-indexes.test.ts asserts that and pins each plan.
-- The queries name their index with INDEXED BY through
-- withIndexHintFallback, so they stay correct (just expensive) if an index
-- is missing.
--
-- ── Cost ─────────────────────────────────────────────────────────────
-- One pass over `threats` per index to build. Afterwards: one index write
-- when a row enters a set (insert without geo / without provider / with an
-- unchecked domain) and one when it leaves (geo or provider stamped,
-- SURBL checked, status changes). Additive; no table or column changes.

CREATE INDEX IF NOT EXISTS idx_threats_active_no_geo ON threats(created_at)
  WHERE (lat IS NULL OR lng IS NULL) AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_threats_ip_no_provider ON threats(created_at)
  WHERE hosting_provider_id IS NULL AND ip_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_threats_surbl_pending ON threats(created_at)
  WHERE surbl_checked = 0 AND malicious_domain IS NOT NULL;
