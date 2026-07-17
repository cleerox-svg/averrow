-- Brand cube — pre-aggregated threat counts by brand, enabling sparklines
-- on the brands list page without correlated subqueries against 113K+ threats.
--
-- Grain: (hour_bucket, target_brand_id, threat_type, severity, source_feed)
-- Same pattern as threat_cube_geo and threat_cube_provider.
--
-- Uses INSERT OR REPLACE keyed on the full 5-tuple PK, so hour-by-hour
-- rebuilds are idempotent and re-runnable without cleanup.
--
-- Rows with NULL target_brand_id are dropped (not useful for brand analytics).
--
-- Refresh: fast_tick current+previous hour (Phase 3 pattern).
-- Backfill: POST /api/admin/cube-backfill?cube=brand

CREATE TABLE IF NOT EXISTS threat_cube_brand (
  hour_bucket      TEXT    NOT NULL,
  target_brand_id  TEXT    NOT NULL,
  threat_type      TEXT    NOT NULL,
  severity         TEXT    NOT NULL,
  source_feed      TEXT    NOT NULL,
  threat_count     INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (hour_bucket, target_brand_id, threat_type, severity, source_feed)
);

CREATE INDEX IF NOT EXISTS idx_cube_brand_hour
  ON threat_cube_brand(hour_bucket DESC);

CREATE INDEX IF NOT EXISTS idx_cube_brand_id_hour
  ON threat_cube_brand(target_brand_id, hour_bucket DESC);
