-- Migration 0141 — dedupe hosting_providers rows that share an ASN.
--
-- Audit 2026-05-06 (audit C2) caught two rows for AS13335 — one named
-- "Cloudflare, Inc." with ~32K threats and one named "Cloudflare
-- AS13335 Cloudflare, Inc." with ~11K. Both are the same provider.
-- Cartographer post-2026-04 inserts as `hp_<asn>` and ON CONFLICT
-- merges, so duplicates only exist for legacy rows created before
-- that canonicalization landed.
--
-- Strategy:
--   1. For each ASN with >1 row, pick a canonical id, preferring
--      the `hp_<asn>` form (matches 0113's intended convention) and
--      falling back to highest active_threat_count if no `hp_<asn>`
--      row exists. Tiebreak on id ascending for determinism.
--   2. Repoint threats.hosting_provider_id, threat_cube_provider, and
--      infrastructure_clusters from non-canonical rows to canonical.
--   3. Delete the non-canonical rows.

-- Build the dedup map as a temp table — used by every UPDATE/DELETE
-- below.
--   is_canonical_form: 1 when id = 'hp_<asn>' (preferred shape)
--   ROW_NUMBER orders canonical-form first, then by threat count desc,
--   then by id ascending. rn = 1 → winner.
CREATE TEMP TABLE provider_dedup AS
WITH ranked AS (
  SELECT
    id,
    asn,
    active_threat_count,
    CASE WHEN id = 'hp_' || asn THEN 1 ELSE 0 END AS is_canonical_form,
    ROW_NUMBER() OVER (
      PARTITION BY asn
      ORDER BY
        CASE WHEN id = 'hp_' || asn THEN 1 ELSE 0 END DESC,
        active_threat_count DESC,
        id ASC
    ) AS rn
  FROM hosting_providers
  WHERE asn IS NOT NULL AND asn != ''
)
SELECT
  src.id      AS old_id,
  dst.id      AS canonical_id,
  src.asn
FROM ranked src
JOIN ranked dst
  ON dst.asn = src.asn AND dst.rn = 1
WHERE src.rn > 1;

-- Repoint threats.
UPDATE threats
SET hosting_provider_id = (
  SELECT canonical_id FROM provider_dedup
  WHERE old_id = threats.hosting_provider_id
)
WHERE hosting_provider_id IN (SELECT old_id FROM provider_dedup);

-- Repoint cubes (threat_cube_provider) so historical aggregates
-- collapse onto the canonical id.
UPDATE threat_cube_provider
SET hosting_provider_id = (
  SELECT canonical_id FROM provider_dedup
  WHERE old_id = threat_cube_provider.hosting_provider_id
)
WHERE hosting_provider_id IN (SELECT old_id FROM provider_dedup);

-- Repoint infrastructure_clusters if the FK exists. NEXUS clusters
-- can carry a hosting_provider_id reference for the dominant provider.
UPDATE infrastructure_clusters
SET hosting_provider_id = (
  SELECT canonical_id FROM provider_dedup
  WHERE old_id = infrastructure_clusters.hosting_provider_id
)
WHERE hosting_provider_id IN (SELECT old_id FROM provider_dedup);

-- Drop the now-orphaned duplicates.
DELETE FROM hosting_providers
WHERE id IN (SELECT old_id FROM provider_dedup);

DROP TABLE provider_dedup;
