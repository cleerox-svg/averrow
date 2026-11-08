-- 0318 — idx_threats_severity_rank_created: expression index for the
-- default threats-list sort.
--
-- ── Why ──────────────────────────────────────────────────────────────
-- The ops Threats page opens on `GET /api/threats?sort=severity&dir=desc`
-- with no filter (handlers/threats.ts handleListThreats). It orders by
--   CASE t.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3
--                   WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
--   t.created_at DESC
-- which no index could satisfy, so every cold page load scanned and sorted
-- the whole threats table (~5.4M rows read per call with the joins,
-- d1_top_queries_24h 2026-11-08). Stacked on the Threats aggregate burst,
-- that tripped `D1 DB is overloaded` on prod 2026-11-08 ~03:40 and ~03:53
-- UTC, taking login and every D1-backed route down for minutes.
--
-- With this index the planner walks it backwards and stops after
-- OFFSET + LIMIT rows: `SCAN t USING INDEX idx_threats_severity_rank_created`
-- with no temp B-tree (pinned by test/threats-severity-rank-index.test.ts).
-- The expression MUST stay byte-for-byte equal to SORT_COLUMNS.severity in
-- handlers/threats.ts (and handlers/tenantData.ts) or SQLite won't match it.
--
-- ── Cost ─────────────────────────────────────────────────────────────
-- One-time build: one pass over `threats` plus one index entry per row.
-- Additive; no existing column or index is touched.

CREATE INDEX IF NOT EXISTS idx_threats_severity_rank_created ON threats(
  (CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END),
  created_at
);
