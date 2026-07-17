-- Covering index for date-range + brand grouping queries.
--
-- The brand list endpoint's sparkline subquery (temporarily removed for perf)
-- and several observatory/dashboard queries filter by created_at then GROUP BY
-- target_brand_id. The existing idx_threats_created_at only covers the date
-- column; this composite index lets the query planner satisfy both the range
-- filter AND the group-by from a single index scan.
--
-- Also benefits: handleThreatStats, handleGeoClusters, observatory arcs —
-- any query with WHERE created_at >= ? ... GROUP BY target_brand_id.

CREATE INDEX IF NOT EXISTS idx_threats_created_brand
  ON threats(created_at, target_brand_id);
