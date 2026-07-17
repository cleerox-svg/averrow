-- threat_cube_status — captures every threat row, including those that
-- the existing cubes drop (NULL lat/lng, NULL hosting_provider_id, NULL
-- target_brand_id) and those with non-active status (down, remediated).
--
-- Why this cube exists:
-- The diagnostics' d1_top_queries_24h block flagged ~124M reads/day
-- (Group 3, ~15% of the daily budget) coming from these query shapes
-- against the raw threats table:
--   SELECT COUNT(*) FROM threats
--   SELECT COUNT(*) FROM threats WHERE status = 'active'
--   SELECT COUNT(DISTINCT threat_type) FROM threats
--   SELECT threat_type, COUNT(*) FROM threats GROUP BY threat_type
--   SELECT COUNT(DISTINCT target_brand_id) FROM threats
--
-- The existing cubes (geo, provider, brand) can't answer these because
-- they all filter status='active' AND drop NULL dimensions, so SUMming
-- them undercounts. This cube has no dimension filter — every threats
-- row is represented exactly once per hour bucket.
--
-- Grain: (hour_bucket, threat_type, severity, source_feed, status)
-- Cardinality: ~3 statuses × ~10 types × ~4 severities × ~25 feeds × 24h
-- ≈ 72K rows/day worst case, typically much less. Negligible storage.
--
-- Refresh model (matches geo/provider/brand cubes):
--   Navigator (every 5 min) — current + previous hour
--   cube-healer (every 6h)  — full 30-day rebuild
--
-- The 6h cube-healer cadence is the lag window for status changes:
-- when a threat decays from active→down, the affected hour bucket
-- carries stale numbers for at most 6 hours before the full rebuild
-- corrects them. Acceptable for displays like "113K+ threats tracked"
-- and "X active threats."

CREATE TABLE IF NOT EXISTS threat_cube_status (
  hour_bucket   TEXT    NOT NULL,
  threat_type   TEXT    NOT NULL,
  severity      TEXT    NOT NULL,
  source_feed   TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  threat_count  INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (hour_bucket, threat_type, severity, source_feed, status)
);

CREATE INDEX IF NOT EXISTS idx_cube_status_hour
  ON threat_cube_status(hour_bucket DESC);

CREATE INDEX IF NOT EXISTS idx_cube_status_status_hour
  ON threat_cube_status(status, hour_bucket DESC);

CREATE INDEX IF NOT EXISTS idx_cube_status_type_hour
  ON threat_cube_status(threat_type, hour_bucket DESC);
