-- 0324_nexus_subnet_lane_covering_index.sql
-- Covering partial index for the NEXUS /24-subnet lane
-- (lib/nexus-threat-lanes.ts). Split from 0323 so each lane index builds in
-- its own migration — see 0323's header for the full rationale, plan
-- evidence, and why the key is an expression (rtrim(ip_address,
-- '0123456789') = ip_subnet24's value expression from 0235).
--
-- Index writes: rewritten when ip_address / target_brand_id / asn /
-- threat_type / country_code / first_seen / status change on a qualifying
-- row. cluster_id is not a column, so the lane's own stamps never touch it.
--
-- Additive only — CREATE INDEX IF NOT EXISTS.
-- Rollback: DROP INDEX idx_threats_subnet_lane.

CREATE INDEX IF NOT EXISTS idx_threats_subnet_lane
  ON threats(
    rtrim(ip_address, '0123456789'),
    ip_address,
    target_brand_id,
    asn,
    threat_type,
    country_code,
    first_seen,
    status
  )
  WHERE status = 'active'
    AND ip_address IS NOT NULL
    AND target_brand_id IS NOT NULL;
