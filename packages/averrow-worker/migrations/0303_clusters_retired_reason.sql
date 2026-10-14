-- 0303 — infrastructure_clusters.retired_reason + retire the legacy
-- random-UUID NEXUS clusters (owner-approved 2026-10-14).
--
-- Additive + data-only. One new nullable column; no column is dropped,
-- altered or rewritten, `status` is NOT touched, and no row is deleted.
--
-- retired_reason: NULL = a live operation. Non-NULL = retired, kept for
-- audit / reversibility but excluded from every reader that lists, counts,
-- attributes or groups operations (lib/cluster-status.ts):
--   'superseded'   legacy duplicate (this migration), or a `cluster_asn_*`
--                  row keyed on a malformed ASN (NEXUS retire pass)
--   'shared_infra' ASN / per-IP / subnet row that is not operator evidence
--                  (NEXUS retire pass, lib/nexus-threat-lanes.ts)
--
-- Why a column and not new `status` values: prod's infrastructure_clusters
-- was created outside the repo's migrations and carries
--   status TEXT DEFAULT 'active' CHECK (status IN ('active','dormant','disrupted'))
-- The first version of this migration wrote status='superseded' and failed
-- the deploy on that CHECK. Widening the CHECK means rebuilding the table
-- (unsafe under D1's enforced foreign keys), so retirement lives here
-- instead and `status` keeps its prod domain.
--
-- File history: this file replaces `0303_supersede_legacy_clusters.sql`,
-- which never applied anywhere it hit the prod CHECK (D1 records a migration
-- in d1_migrations only on success). It is RENAMED rather than edited in
-- place because wrangler tracks applied migrations by file name: any DB
-- without the CHECK (a fresh staging / dev DB bootstrapped from 0136) may
-- have recorded the old name, and an in-place edit would then never run
-- there, leaving the code reading a column that does not exist. Under the
-- new name it applies everywhere it has not run.
--
-- Before 2026-09-11 the NEXUS workflow's ASN lane minted crypto.randomUUID()
-- ids every run (~768 copies per (asn, threat_type) group, frozen counts).
-- Every id that does not start with `cluster_` is one of those copies; the
-- live row for the group is the stable `cluster_asn_<asn>_<type>`. At the
-- 2026-10-14 audit: ~70.3K active + ~6.3K dormant legacy rows. Their status
-- and actor_id / counts / notes are left exactly as they are
-- (undo = SET retired_reason = NULL).
--
-- "Does not start with `cluster_`" is written as two PRIMARY KEY ranges —
-- id < 'cluster_' OR id >= 'cluster`' ('`' is the code point after '_') —
-- and split by leading character so each statement updates a bounded slice
-- (~1/8 of the UUID-keyed rows) instead of all 76K rows in one statement.
-- The ranges are contiguous and together cover exactly the non-`cluster_`
-- ids. No index covers retired_reason yet (0304 / 0306 build theirs after
-- this backfill), so these UPDATEs maintain no secondary index.
--
-- Threats that still reference a legacy id are re-pointed / released by the
-- bounded admin job POST /api/internal/nexus/cluster-retirement
-- (lib/cluster-retirement.ts), not here — that writes the threats table.

ALTER TABLE infrastructure_clusters ADD COLUMN retired_reason TEXT;

UPDATE infrastructure_clusters SET retired_reason = 'superseded'
 WHERE id < '2' AND retired_reason IS NULL;

UPDATE infrastructure_clusters SET retired_reason = 'superseded'
 WHERE id >= '2' AND id < '4' AND retired_reason IS NULL;

UPDATE infrastructure_clusters SET retired_reason = 'superseded'
 WHERE id >= '4' AND id < '6' AND retired_reason IS NULL;

UPDATE infrastructure_clusters SET retired_reason = 'superseded'
 WHERE id >= '6' AND id < '8' AND retired_reason IS NULL;

UPDATE infrastructure_clusters SET retired_reason = 'superseded'
 WHERE id >= '8' AND id < 'a' AND retired_reason IS NULL;

UPDATE infrastructure_clusters SET retired_reason = 'superseded'
 WHERE id >= 'a' AND id < 'c' AND retired_reason IS NULL;

UPDATE infrastructure_clusters SET retired_reason = 'superseded'
 WHERE id >= 'c' AND id < 'cluster_' AND retired_reason IS NULL;

UPDATE infrastructure_clusters SET retired_reason = 'superseded'
 WHERE id >= 'cluster`' AND retired_reason IS NULL;
