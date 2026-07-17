-- Canonicalize hosting_providers.id to hp_${asn} for all rows with an asn.
--
-- Background: cartographer historically derived hosting_providers.id from
-- the provider NAME (e.g. hp_china_unicom_beijing). ip-api returns name
-- variants for the same ASN over time ("AS4837 China Unicom Beijing" vs
-- "AS4837 China Unicom"), so different threats with the same ASN generated
-- different ids. UNIQUE(asn) caught the conflict and rolled back the entire
-- batch chunk atomically — see PR #826 for the cartographer-side fix.
--
-- After PR #826, new providers use the canonical hp_${asn} form. This
-- migration backfills existing rows so the legacy/new dichotomy goes away
-- permanently.
--
-- ─── FK strategy ─────────────────────────────────────────────────────
-- D1 enforces FOREIGN KEY constraints by default. The first attempt at
-- this migration (commit 901f94b) failed because UPDATE threats SET
-- hosting_provider_id = 'hp_' || asn ran while hosting_providers.id was
-- still in the legacy form — the FK check on each updated row found no
-- matching parent and aborted the migration.
--
-- PRAGMA defer_foreign_keys = ON defers FK checks to commit time. Within
-- the migration's transaction we can update threats, threat_cube_provider,
-- and hosting_providers in any order; SQLite verifies all FKs resolve
-- when the migration commits. Since the END STATE is consistent (all
-- threats reference canonical ids that all exist in hosting_providers),
-- the commit succeeds.
--
-- This is distinct from `PRAGMA foreign_keys = OFF` which CANNOT be
-- toggled inside a transaction and would silently no-op here. The
-- defer_foreign_keys pragma is auto-cleared on COMMIT/ROLLBACK so it
-- doesn't leak past this migration.
--
-- Order within the deferred block doesn't matter for correctness, but
-- I've kept the threats / cube updates first because they reference the
-- BEFORE state of hosting_providers via subquery — running them after
-- the rename would lose the mapping.

PRAGMA defer_foreign_keys = ON;

-- ─── Step 1: Update threats.hosting_provider_id ──────────────────────
UPDATE threats
SET hosting_provider_id = 'hp_' || (
  SELECT asn FROM hosting_providers hp
  WHERE hp.id = threats.hosting_provider_id
    AND hp.asn IS NOT NULL
    AND hp.asn != ''
)
WHERE hosting_provider_id IN (
  SELECT id FROM hosting_providers
  WHERE asn IS NOT NULL AND asn != '' AND id != 'hp_' || asn
);

-- ─── Step 2: Update threat_cube_provider.hosting_provider_id ─────────
-- The cube self-heals on the next 6-hour cube_healer pass, but explicitly
-- updating avoids an inconsistency window where queries against the cube
-- would miss rows because hosting_provider_id no longer matches anything
-- in hosting_providers.
UPDATE threat_cube_provider
SET hosting_provider_id = 'hp_' || (
  SELECT asn FROM hosting_providers hp
  WHERE hp.id = threat_cube_provider.hosting_provider_id
    AND hp.asn IS NOT NULL
    AND hp.asn != ''
)
WHERE hosting_provider_id IN (
  SELECT id FROM hosting_providers
  WHERE asn IS NOT NULL AND asn != '' AND id != 'hp_' || asn
);

-- ─── Step 3: Rename hosting_providers.id to canonical form ───────────
-- Safe because UNIQUE(asn) guarantees one row per asn — no destination
-- id collisions are possible.
UPDATE hosting_providers
SET id = 'hp_' || asn
WHERE asn IS NOT NULL AND asn != '' AND id != 'hp_' || asn;
