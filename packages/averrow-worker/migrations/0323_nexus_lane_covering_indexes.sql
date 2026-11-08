-- 0323_nexus_lane_covering_indexes.sql
-- Covering partial indexes for the NEXUS ASN and /24-subnet lanes
-- (lib/nexus-threat-lanes.ts), keyed on the lanes' normalised group keys.
--
-- Perf fix (D1 "overloaded", live diagnostics 2026-11-08). NEXUS runs every
-- 4h (NEXUS_RUN workflow, plus the agents/nexus.ts fallback); attribution
-- put workflow:nexus_run at ~33M rows read / day, dominated by two lanes:
--
--   ASN lane   ~2.28M rows / call. It groups active threats by
--              asnKeySql(asn) (the long CASE normaliser in
--              lib/shared-infra-asns.ts). No index carried that key, so
--              `status = 'active'` drove idx_threats_status_created with a
--              table lookup per active row (≈ 2 × the active set), then a
--              temp b-tree sort for the GROUP BY.
--   /24 lane   ~1.34M rows / call. It groups by the ip_subnet24 VIRTUAL
--              generated column (0235) and walked idx_threats_subnet24 —
--              every IPv4 row of ANY status — with a table lookup per entry
--              for status / brand / asn / type / country / first_seen.
--
-- Each index below is
--   * partial on exactly the rows its lane can group, so inactive /
--     unattributed / IP-reputation rows are never visited;
--   * keyed first on the lane's GROUP BY expression, so the lane is one
--     ordered index walk with no temp b-tree for the grouping;
--   * COVERING: it carries every column the lane reads. `status` is a
--     trailing key column even though the partial WHERE fixes it — SQLite
--     (3.53) does not count terms implied by a partial index's WHERE as
--     covered (same as 0315), so without it every entry pays a table lookup.
-- Rows read per call drop to the number of qualifying index entries.
--
-- Pinned with INDEXED BY (lib/indexed-by-fallback.ts, as 0315): without
-- sqlite_stat1 the planner keeps idx_threats_status_created. `status` is
-- deliberately NOT the leading column: a status-led partial index won the
-- unhinted plans, but it also captured unrelated statements whose WHERE
-- happens to imply the partial predicate (the per-IP stamp's
-- `ip_address = ? AND status = 'active' AND target_brand_id IS NOT NULL`
-- switched from an ip_address seek to a scan of the whole index). Led by
-- an expression only the lanes use, the indexes attract nothing else; a
-- missing index or a drifted WHERE re-runs the lane unhinted.
--
-- Why expression keys and not an asn_norm column. An index on a VIRTUAL
-- generated column (how 0235 added ip_subnet24, and the only kind ALTER
-- TABLE ADD COLUMN can add) is never covering in SQLite — every entry
-- still costs a table lookup. A plain stored asn_norm column would need
-- every writer of threats.asn to fill it (feed ingest, lib/enrichment.ts,
-- lib/geoip.ts, workflows/cartographerBackfill.ts and four sites in
-- agents/cartographer.ts) or a trigger, plus a backfill rewriting ~1.5M+
-- rows. An index on the EXPRESSION stores the normalised key in the index
-- itself, maintained by SQLite on every insert/update of asn: no writer
-- changes, no backfill window, and the value is asnKeySql(asn) by
-- construction. The planner matches it because the lane SQL uses the same
-- expression text:
--   - idx_threats_asn_lane's key is asnKeySql('asn') verbatim. The ASN lane
--     SQL is unchanged by this migration.
--   - idx_threats_subnet_lane's key is rtrim(ip_address, '0123456789'),
--     ip_subnet24's value expression. The /24 lane now groups by that
--     expression under ip_subnet24's own IPv4 predicates (its stamp still
--     seeks idx_threats_subnet24).
-- test/nexus-lane-covering-indexes.test.ts pins both texts against the
-- lane SQL and the EXPLAIN QUERY PLAN of both lanes, so an edit to
-- asnKeySql or the lane SQL that would orphan an index fails CI instead of
-- silently falling back to the pre-0323 plan.
--
-- Not baked into the partial WHEREs: the shared-infra ASN lists (edited
-- more often than this schema). The lanes filter them per entry from the
-- covering columns. The ASN index's IP-reputation list IS baked in:
-- `threat_type NOT IN ('scanning', 'malicious_ip')` is the lane's own term
-- (IP_REPUTATION_THREAT_TYPES); changing that list needs a migration that
-- re-creates this index (the plan pin fails first).
--
-- Cost: one entry per qualifying active row in each index, rewritten when
-- an indexed column changes (enrichment's one-time asn / country /
-- provider fill, a status flip). cluster_id is deliberately NOT a column,
-- so the lanes' own `SET cluster_id` stamps never touch either index. The
-- one-time build reads threats once (≈ one old ASN-lane call).
--
-- Index writes: also rewritten when campaign_id / target_brand_id /
-- hosting_provider_id / country_code change on a qualifying row
-- (Strategist's campaign stamps, brand match, Cartographer's provider fill).
-- Build: a full pass over threats plus a sort, holding D1's single writer
-- for its duration. That is why the two lane indexes are split one per
-- migration file (this one: ASN lane; 0324: /24 lane), so a build that
-- hits a D1 limit fails alone and the other still lands.
--
-- Additive only — CREATE INDEX IF NOT EXISTS; no table or column changes.
-- Rollback: DROP INDEX idx_threats_asn_lane.

CREATE INDEX IF NOT EXISTS idx_threats_asn_lane
  ON threats(
    (CASE WHEN length(upper(substr(trim(replace(asn, ',', ' ')), 1, instr(trim(replace(asn, ',', ' ')) || ' ', ' ') - 1))) > 2 AND substr(upper(substr(trim(replace(asn, ',', ' ')), 1, instr(trim(replace(asn, ',', ' ')) || ' ', ' ') - 1)), 1, 2) = 'AS' AND ltrim(substr(upper(substr(trim(replace(asn, ',', ' ')), 1, instr(trim(replace(asn, ',', ' ')) || ' ', ' ') - 1)), 3), '0123456789') = '' THEN upper(substr(trim(replace(asn, ',', ' ')), 1, instr(trim(replace(asn, ',', ' ')) || ' ', ' ') - 1)) WHEN length(upper(substr(trim(replace(asn, ',', ' ')), 1, instr(trim(replace(asn, ',', ' ')) || ' ', ' ') - 1))) > 0 AND ltrim(upper(substr(trim(replace(asn, ',', ' ')), 1, instr(trim(replace(asn, ',', ' ')) || ' ', ' ') - 1)), '0123456789') = '' THEN 'AS' || upper(substr(trim(replace(asn, ',', ' ')), 1, instr(trim(replace(asn, ',', ' ')) || ' ', ' ') - 1)) END),
    threat_type,
    target_brand_id,
    campaign_id,
    hosting_provider_id,
    country_code,
    first_seen,
    asn,
    status
  )
  WHERE status = 'active'
    AND asn IS NOT NULL
    AND threat_type NOT IN ('scanning', 'malicious_ip');
