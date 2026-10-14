-- 0305 — cluster_repoint_log: undo record for the NEXUS cluster re-point job.
--
-- Additive only: a new table + index. No existing table or column changes.
--
-- POST /api/internal/nexus/cluster-retirement?dry_run=0
-- (lib/cluster-retirement.ts runClusterRetirementBatch) overwrites
-- threats.cluster_id — re-pointing threats off legacy / retired cluster ids
-- onto the stable `cluster_asn_<asn>_<type>` row, or releasing them (NULL).
-- Before each move, in the SAME db.batch, the job records every threat it is
-- about to move here, so the re-point can be undone from this table:
--
--   UPDATE threats SET cluster_id = l.old_cluster_id
--     FROM cluster_repoint_log l
--    WHERE threats.id = l.threat_id
--      AND threats.cluster_id IS l.new_cluster_id;
--
-- new_cluster_id is NULL for a release. run_at is bound once per call
-- (ms precision); the job's UPDATE moves exactly the rows its own call
-- logged (old_cluster_id = ? AND run_at = ?), hence the composite index.
-- Append-only by convention; no FK (threats rows may later be deleted by
-- retention, and the log must not cascade).

CREATE TABLE IF NOT EXISTS cluster_repoint_log (
  threat_id       TEXT NOT NULL,
  old_cluster_id  TEXT NOT NULL,
  new_cluster_id  TEXT,
  run_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cluster_repoint_log_old
  ON cluster_repoint_log(old_cluster_id, run_at);
