-- 0301 — Observatory operations-geo: status-filtered top-N index.
--
-- Additive only. No column is dropped, altered or rewritten.
--
-- GET /api/observatory/operations-geo (default status=active) reads
--   SELECT … FROM infrastructure_clusters c LEFT JOIN threat_actors a …
--   WHERE c.status = 'active'
--   ORDER BY c.threat_count DESC, c.id LIMIT ?
--
-- 0298's idx_clusters_threat_count (threat_count DESC, id) serves only the
-- unfiltered status=all read. With the status filter SQLite prefers the
-- equality index idx_clusters_status (status) — with or without ANALYZE
-- stats — and then sorts every matching row in a TEMP B-TREE: ~71K rows
-- read and sorted per cache miss on a 77K-row table that is ~92% active.
--
-- (status, threat_count DESC, id) answers the equality AND the ORDER BY
-- (including the id tie-break) from one index, so the read seeks to
-- status='active' and stops at LIMIT. Pinned by EXPLAIN QUERY PLAN against
-- the full migrated schema in test/observatory-lenses.test.ts.
--
-- idx_clusters_status is kept: other readers filter on status alone, and
-- 0298's idx_clusters_threat_count still serves status=all.

CREATE INDEX IF NOT EXISTS idx_clusters_status_threat_count
  ON infrastructure_clusters(status, threat_count DESC, id);
