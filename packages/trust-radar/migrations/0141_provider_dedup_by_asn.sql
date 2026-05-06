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
--   2. Repoint threats.hosting_provider_id and delete cube alias
--      rows.
--   3. Delete the non-canonical hosting_providers rows.
--
-- D1's migration runner executes statements via separate API calls,
-- so CREATE TEMP TABLE doesn't persist across statements. Use a
-- regular table instead, dropped at the end.

DROP TABLE IF EXISTS _provider_dedup_0141;

CREATE TABLE _provider_dedup_0141 (
  old_id       TEXT,
  canonical_id TEXT,
  asn          TEXT
);

INSERT INTO _provider_dedup_0141 (old_id, canonical_id, asn)
WITH ranked AS (
  SELECT
    id,
    asn,
    active_threat_count,
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
  src.id AS old_id,
  dst.id AS canonical_id,
  src.asn
FROM ranked src
JOIN ranked dst ON dst.asn = src.asn AND dst.rn = 1
WHERE src.rn > 1;

-- Repoint threats.
UPDATE threats
SET hosting_provider_id = (
  SELECT canonical_id FROM _provider_dedup_0141
  WHERE old_id = threats.hosting_provider_id
)
WHERE hosting_provider_id IN (SELECT old_id FROM _provider_dedup_0141);

-- threat_cube_provider's PK includes hosting_provider_id, so UPDATE
-- on that column collides with any pre-existing canonical-id row
-- for the same (hour_bucket, threat_type, severity, source_feed).
-- Drop the old-id rows instead — the cube-healer cron (12 */6 * * *)
-- rebuilds 30 days of provider cubes every 6 hours from threats
-- (which we just repointed to canonical), so aggregates recover
-- within one cube-healer cycle.
DELETE FROM threat_cube_provider
WHERE hosting_provider_id IN (SELECT old_id FROM _provider_dedup_0141);

-- infrastructure_clusters stores `hosting_provider_ids` as a JSON
-- array snapshot, not a singular FK column. NEXUS regenerates the
-- snapshot on every run via ON CONFLICT DO UPDATE, so we leave the
-- cluster snapshots alone — the next NEXUS cycle reflects canonical
-- ids.

-- Drop the now-orphaned duplicate provider rows.
DELETE FROM hosting_providers
WHERE id IN (SELECT old_id FROM _provider_dedup_0141);

DROP TABLE _provider_dedup_0141;
