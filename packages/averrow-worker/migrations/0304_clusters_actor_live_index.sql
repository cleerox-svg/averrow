-- 0304 — partial (actor_id) index over LIVE clusters.
--
-- Additive only. No column is dropped, altered or rewritten.
--
-- Actor reads exclude retired clusters (retired_reason IS NOT NULL,
-- lib/cluster-status.ts — migration 0303 retired ~76K legacy rows, 91 of
-- them carrying an actor_id):
--
--   Observatory actors list:  (SELECT COUNT(*) FROM infrastructure_clusters c
--                               WHERE c.actor_id = a.id AND c.retired_reason IS NULL)
--   Actor detail clusters:    … WHERE actor_id = ? AND retired_reason IS NULL
--
-- idx_clusters_actor (actor_id) alone would need a table lookup per cluster
-- to test retired_reason. This index holds only live rows and carries
-- retired_reason as a trailing column, so the per-actor count is answered
-- from it (COVERING — SQLite does not treat a partial index's WHERE as
-- making the column available, so a bare partial (actor_id) index needs a
-- table lookup per row), as the list read did before the retired filter.
-- Pinned by EXPLAIN QUERY PLAN in test/observatory-lens-plans.test.ts.
--
-- Partial rather than a FULL (actor_id, retired_reason): a full index
-- carrying retired_reason is the narrowest covering index for any bare
-- `retired_reason IS NULL` count, and without ANALYZE stats SQLite picks it
-- and scans all ~77K entries. Every index that mentions retired_reason holds
-- live rows only (this one and 0306), so whichever the planner picks for a
-- live-cluster read, it reads only live rows.
--
-- File history: replaces `0304_clusters_actor_status_index.sql`
-- ((actor_id, status)), which never applied in prod — the deploy stopped at
-- 0303. Renamed for the same reason as 0303 (wrangler tracks migrations by
-- file name). Built after 0303's backfill.
--
-- idx_clusters_actor is kept (never drop) — it serves by-actor reads that
-- include retired rows.

CREATE INDEX IF NOT EXISTS idx_clusters_actor_live
  ON infrastructure_clusters(actor_id, retired_reason)
  WHERE retired_reason IS NULL;
