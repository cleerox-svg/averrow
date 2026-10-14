-- 0305 — cluster_repoint_log: undo record for the NEXUS cluster re-point job.
--
-- Additive only: a new table + index. No existing table or column changes.
--
-- POST /api/internal/nexus/cluster-retirement?dry_run=0
-- (lib/cluster-retirement.ts runClusterRetirementBatch) overwrites
-- threats.cluster_id — re-pointing threats off legacy / retired cluster ids
-- onto the stable `cluster_asn_<asn>_<type>` row, or releasing them (NULL).
-- Before each move, in the SAME db.batch, the job records every threat it is
-- about to move here, so the re-point can be undone from this table, one
-- run_at at a time, NEWEST FIRST (SELECT DISTINCT run_at ... ORDER BY
-- run_at DESC, then for each):
--
--   UPDATE threats SET cluster_id = l.old_cluster_id
--     FROM cluster_repoint_log l
--    WHERE threats.id = l.threat_id
--      AND l.run_at = ?
--      AND threats.cluster_id IS l.new_cluster_id;
--
-- Newest-first matters when a threat moved twice (U -> X, then X -> NULL).
-- The cluster_id IS new_cluster_id guard is required: a log row can exist
-- for a threat the guarded move skipped (a concurrent NEXUS stamp got there
-- first), and a released threat may since have been claimed by NEXUS; the
-- guard leaves both alone. The POST result and its audit_log row carry the
-- call's run_at. A run_at-only undo scans this (small) table.
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
