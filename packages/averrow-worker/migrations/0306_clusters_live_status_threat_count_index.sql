-- 0306 — partial (status, threat_count DESC, id) index over LIVE clusters.
--
-- Additive only. No column is dropped, altered or rewritten.
--
-- Retirement is the retired_reason column (migration 0303), not a status
-- value, so the ~76K retired legacy rows keep status 'active' / 'dormant'.
-- 0301's idx_clusters_status_threat_count therefore can no longer skip them:
-- a `status IN (…)` seek walks every retired row of that status and filters
-- retired_reason per row.
--
-- This index holds only live rows (WHERE retired_reason IS NULL — a few
-- thousand at most). SQLite uses a partial index only when the query's WHERE
-- contains the index's WHERE term, which every live-cluster reader does
-- through lib/cluster-status.ts (notRetiredClusterSql /
-- liveClusterStatusSql). Readers served:
--   - Attribution Backlog (handlers/admin/attribution.ts) — pinned with
--     `INDEXED BY idx_clusters_live_status_threat_count`;
--   - providers clusters list / stats, operations list + stats, attributor
--     pending queue, platform totals — free to pick it.
-- Plans pinned in test/cluster-list-plans.test.ts.
--
-- Built after 0303's backfill, so it indexes only the live rows.
-- idx_clusters_status_threat_count (0301) and idx_clusters_status are kept
-- (never drop).

CREATE INDEX IF NOT EXISTS idx_clusters_live_status_threat_count
  ON infrastructure_clusters(status, threat_count DESC, id)
  WHERE retired_reason IS NULL;
