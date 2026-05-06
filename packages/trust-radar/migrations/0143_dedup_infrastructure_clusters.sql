-- Migration 0143 — dedup infrastructure_clusters rows that share a
-- generated cluster_name.
--
-- Audit 2026-05-06 (audit C3) caught 6 near-identical "CA AS13335
-- malware distribution cluster" rows on the Campaigns view. Pre-fix
-- nexus.ts called `crypto.randomUUID()` for every cluster on every
-- run, so the same logical cluster (same asn + threat_type) accreted
-- one new row per NEXUS cycle.
--
-- The agent now uses a deterministic id derived from the natural
-- key (`cluster_asn_<asn>_<type>` etc.) and ON CONFLICT DO UPDATE,
-- so future runs converge on a single row per cluster. This
-- migration cleans up the historical duplicates by:
--
--   1. Picking the row with the highest threat_count per cluster_name
--      as canonical (longest-lived = most data).
--   2. Repointing threats.cluster_id to the canonical id.
--   3. Deleting the non-canonical rows.
--
-- The remaining UUID-id rows continue to coexist with the new
-- deterministic-id rows the agent inserts going forward; they're
-- still valid history. A future migration can rename them once the
-- deterministic format has been live long enough to verify.

CREATE TEMP TABLE cluster_dedup AS
WITH ranked AS (
  SELECT
    id,
    cluster_name,
    threat_count,
    last_seen,
    ROW_NUMBER() OVER (
      PARTITION BY cluster_name
      ORDER BY threat_count DESC, last_seen DESC, id ASC
    ) AS rn
  FROM infrastructure_clusters
  WHERE cluster_name IS NOT NULL AND cluster_name != ''
)
SELECT
  src.id AS old_id,
  dst.id AS canonical_id
FROM ranked src
JOIN ranked dst
  ON dst.cluster_name = src.cluster_name AND dst.rn = 1
WHERE src.rn > 1;

-- Repoint threats.cluster_id from non-canonical to canonical.
UPDATE threats
SET cluster_id = (
  SELECT canonical_id FROM cluster_dedup
  WHERE old_id = threats.cluster_id
)
WHERE cluster_id IN (SELECT old_id FROM cluster_dedup);

-- Drop the duplicate rows.
DELETE FROM infrastructure_clusters
WHERE id IN (SELECT old_id FROM cluster_dedup);

DROP TABLE cluster_dedup;
