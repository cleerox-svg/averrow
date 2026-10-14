-- 0303 — retire the legacy random-UUID NEXUS clusters (owner-approved
-- 2026-10-14).
--
-- Data-only and REVERSIBLE: flips status to 'superseded'. No row is deleted,
-- no column is dropped or altered, and actor_id / counts / notes are left
-- exactly as they are (undo = set status back).
--
-- Before 2026-09-11 the NEXUS workflow's ASN lane minted crypto.randomUUID()
-- ids every run (~768 copies per (asn, threat_type) group, frozen counts).
-- Every id that does not start with `cluster_` is one of those copies; the
-- live row for the group is the stable `cluster_asn_<asn>_<type>`. At the
-- 2026-10-14 audit: 70,318 active + 6,349 dormant legacy rows. Readers
-- exclude 'superseded' (lib/cluster-status.ts); there is no CHECK constraint
-- on status (migration 0136), so the new value needs no schema change.
--
-- "Does not start with `cluster_`" is written as two PRIMARY KEY ranges —
-- id < 'cluster_' OR id >= 'cluster`' ('`' is the code point after '_') —
-- and split by leading character so each statement (D1 runs migration
-- statements as separate calls) updates a bounded slice (~1/8 of the
-- UUID-keyed rows) instead of all 76K rows in one statement. The ranges are
-- contiguous and together cover exactly the non-`cluster_` ids.
--
-- Threats that still reference a legacy id are re-pointed / released by the
-- bounded admin job POST /api/internal/nexus/cluster-retirement
-- (lib/cluster-retirement.ts), not here — that writes the threats table.

UPDATE infrastructure_clusters SET status = 'superseded'
 WHERE id < '2' AND status != 'superseded';

UPDATE infrastructure_clusters SET status = 'superseded'
 WHERE id >= '2' AND id < '4' AND status != 'superseded';

UPDATE infrastructure_clusters SET status = 'superseded'
 WHERE id >= '4' AND id < '6' AND status != 'superseded';

UPDATE infrastructure_clusters SET status = 'superseded'
 WHERE id >= '6' AND id < '8' AND status != 'superseded';

UPDATE infrastructure_clusters SET status = 'superseded'
 WHERE id >= '8' AND id < 'a' AND status != 'superseded';

UPDATE infrastructure_clusters SET status = 'superseded'
 WHERE id >= 'a' AND id < 'c' AND status != 'superseded';

UPDATE infrastructure_clusters SET status = 'superseded'
 WHERE id >= 'c' AND id < 'cluster_' AND status != 'superseded';

UPDATE infrastructure_clusters SET status = 'superseded'
 WHERE id >= 'cluster`' AND status != 'superseded';
