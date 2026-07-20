-- 0240_infrastructure_clusters_component_id.sql
-- NEXUS connected-components grouping layer (S2.4 / D5a).
--
-- The six NEXUS lanes (cert-serial → cert-SAN → per-IP → /24 → registrar
-- → ASN) each write per-key `infrastructure_clusters` rows with
-- deterministic natural-key ids (`cluster_cert_<serial>`, `cluster_ip_<ip>`,
-- …). Distinct operators frequently span MORE than one per-key cluster —
-- e.g. an operator whose domains share a cert serial (one cluster) also
-- park on a shared IP (another cluster). A post-pass groups those per-key
-- clusters into transitive COMPONENTS using SPECIFIC-evidence bridges only
-- (cert-serial / cert-SAN / per-IP); ASN / /24 / registrar clusters can
-- RECEIVE a component_id but never act as a bridge (the over-merge trap).
--
-- This column is that component label. It is a SEPARATE signal from
-- `asns` / `actor_id` — component grouping deliberately does NOT widen the
-- `asns` array (which feeds the Attributor's asns.length>=3 auto-Haiku
-- gate), and does NOT touch `threats.cluster_id` stamping. Component-level
-- attribution rollup is a future increment (D5b); this migration ships the
-- storage + read index only.
--
-- Additive only — ADD COLUMN + partial index, never DROP/ALTER
-- (CLAUDE.md §8). Every existing cluster leaves component_id NULL and
-- keeps working unchanged; the post-pass backfills it idempotently.

ALTER TABLE infrastructure_clusters ADD COLUMN component_id TEXT;

-- Partial index: most clusters are singletons (no multi-cluster component),
-- so index only the sparse rows that actually carry a component label —
-- the "list a component's member clusters" read path.
CREATE INDEX IF NOT EXISTS idx_clusters_component_id
  ON infrastructure_clusters(component_id)
  WHERE component_id IS NOT NULL;
