-- Phase 2 cube rollout — geo cube for Observatory map, clusters, arcs, country views.
--
-- Moves Observatory aggregation workload off the threats OLTP table. Each row is
-- the aggregated threat count for a single (hour, 0.01° lat bucket, 0.01° lng bucket,
-- country, threat_type, severity, source_feed) tuple. 0.01° ≈ 1.1km grid.
--
-- Refresh is via INSERT OR REPLACE keyed on the full 7-tuple PK, which makes
-- hour-by-hour rebuilds idempotent and re-runnable without cleanup.
--
-- source_feed is included in the PK deliberately: the Observatory needs to split
-- clusters by feed provenance (e.g. phishtank vs urlhaus).
--
-- Rows in threats with NULL lat/lng do NOT appear in this cube.
--
-- This migration only creates the table + indexes. Population happens via
-- POST /api/admin/cube-backfill. Automatic refresh lands in Phase 3.

CREATE TABLE IF NOT EXISTS threat_cube_geo (
  hour_bucket   TEXT    NOT NULL,
  lat_bucket    REAL    NOT NULL,
  lng_bucket    REAL    NOT NULL,
  country_code  TEXT    NOT NULL,
  threat_type   TEXT    NOT NULL,
  severity      TEXT    NOT NULL,
  source_feed   TEXT    NOT NULL,
  threat_count  INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed)
);

CREATE INDEX IF NOT EXISTS idx_cube_geo_hour
  ON threat_cube_geo(hour_bucket DESC);

CREATE INDEX IF NOT EXISTS idx_cube_geo_country_hour
  ON threat_cube_geo(country_code, hour_bucket DESC);
