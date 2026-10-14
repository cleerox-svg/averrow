-- 0304 — infrastructure_clusters(actor_id, status) covering index.
--
-- Additive only. No column is dropped, altered or rewritten.
--
-- Actor reads now exclude retired clusters (status 'superseded' /
-- 'shared_infra', lib/cluster-status.ts — migration 0303 retired ~76K
-- legacy rows, 91 of them carrying an actor_id):
--
--   Observatory actors list:  (SELECT COUNT(*) FROM infrastructure_clusters c
--                               WHERE c.actor_id = a.id AND c.status NOT IN (…))
--   Actor detail clusters:    … WHERE actor_id = ? AND status NOT IN (…)
--
-- idx_clusters_actor (actor_id) alone would need a table lookup per cluster
-- to test status; (actor_id, status) answers the per-actor count from the
-- index (COVERING), as the list read did before the status filter. Pinned by
-- EXPLAIN QUERY PLAN in test/observatory-lens-plans.test.ts.
--
-- idx_clusters_actor is kept (never drop) — it is a prefix of this index.

CREATE INDEX IF NOT EXISTS idx_clusters_actor_status
  ON infrastructure_clusters(actor_id, status);
