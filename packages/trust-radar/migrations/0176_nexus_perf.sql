-- NEXUS workflow performance fix — index for the hot ASN UPDATE.
--
-- 24h diagnostic 2026-05-12 showed nexus with 13.76M ms avg
-- duration (~3.8 hours) and 5/7 runs reaped. Root cause was in
-- workflows/nexusRun.ts asn-correlation step:
--
--   for each of 100 ASN clusters:
--     UPDATE threats SET cluster_id = ?
--      WHERE asn = ? AND threat_type = ? AND cluster_id IS NULL
--
-- No index on `asn` meant each UPDATE fell back to scanning the
-- threats table filtered by threat_type (poor selectivity). 100
-- UPDATEs × ~265k rows scanned each ≈ 26M row reads, sequential.
--
-- Partial index on (asn, threat_type) keyed off the
-- `cluster_id IS NULL` predicate that the UPDATE always carries
-- — once a row is clustered we don't re-touch it, so keeping it
-- out of the index keeps it lean. SQLite's partial index matching
-- requires the predicate to appear verbatim, which it does in
-- the UPDATE above.

CREATE INDEX IF NOT EXISTS idx_threats_asn_type_unclustered
  ON threats(asn, threat_type)
  WHERE cluster_id IS NULL;
