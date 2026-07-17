-- Compound indexes for page-load query hot paths.
--
-- The observatory arcs query filters on status + created_at + lat/lng/brand NOT NULL,
-- then GROUP BY country_code, target_brand_id, threat_type. The existing
-- idx_threats_status_created covers (status, created_at) but the additional NOT NULL
-- filters still require row lookups. This partial index pre-filters to only geo-tagged
-- threats with brand associations, matching the arcs query predicate exactly.
--
-- The heatmap query has the same pattern minus target_brand_id.
--
-- The provider compound index speeds up dashboard provider timeline queries that
-- GROUP BY hosting_provider_id with time-range filters.

-- Partial index for observatory arcs: active threats with geo + brand data
CREATE INDEX IF NOT EXISTS idx_threats_arcs_covering
  ON threats(status, created_at DESC, country_code, target_brand_id, threat_type)
  WHERE lat IS NOT NULL AND lng IS NOT NULL AND target_brand_id IS NOT NULL;

-- Partial index for heatmap: active threats with geo data
CREATE INDEX IF NOT EXISTS idx_threats_heatmap_geo
  ON threats(status, created_at DESC)
  WHERE lat IS NOT NULL AND lng IS NOT NULL;

-- Compound index for provider timeline queries
CREATE INDEX IF NOT EXISTS idx_threats_provider_created
  ON threats(hosting_provider_id, created_at DESC);
