-- Trust Radar — Partial index on brands.email_security_grade IS NULL.
--
-- Flight Control's parallel_reads phase runs this counter every hourly
-- tick to surface "unscanned brand" backlog:
--
--   SELECT COUNT(*) as count FROM brands WHERE email_security_grade IS NULL
--
-- Without a usable index the planner falls back to a full-table scan.
-- With 94K brands and ~25 FC ticks/day that's ~2.35M wasted D1 reads
-- per day on a counter that drifts <0.5%/hour.
--
-- A partial index — narrow because the NULL set is a fraction of
-- total brands — lets the COUNT(*) walk only the matching B-tree
-- leaves. On D1 the read cost drops from O(table) to O(matching).
--
-- Once a brand is scanned its email_security_grade becomes non-NULL
-- and falls out of the index, so growth is bounded by the unscanned
-- queue (which Cartographer is draining).
--
-- The FC `parallel_reads` phase ballooned 272ms → 5,792ms in one
-- diagnostic sample on 2026-05-21 — almost certainly multiple
-- concurrent COUNT(*) cache misses landing on the threats + brands
-- full-scan paths at the same time. This is one of two paths in that
-- batch without index support; the threats counters are already
-- behind cachedCount + selective indexes.
--
-- Sibling improvement (PR-BM):
--   - lib/notifications.ts dedup query: COUNT(*) → SELECT 1 LIMIT 1
--   - agents/cube-healer.ts: hot/cold split (2d default, 14d daily)

CREATE INDEX IF NOT EXISTS idx_brands_email_security_grade_null
  ON brands(id)
  WHERE email_security_grade IS NULL;
