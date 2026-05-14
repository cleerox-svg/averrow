-- Arcs cube — pre-aggregated arc-corridor data for the Observatory globe.
--
-- Grain: (hour_bucket, country_code, target_brand_id, threat_type, severity, source_feed)
-- Aggregates: threat_count, source_lat/lng (representative centroid), first_seen, last_seen
--
-- Why: handleObservatoryArcs was scanning ~43K rows per uncached call from
-- the raw threats table joined to brands (idx_threats_arcs_covering partial
-- index). At 14.8M reads/24h it was the single largest D1 spender for trust-
-- radar's surfaces and grew linearly with `threats`. The current arcs SQL
-- already groups at country-level resolution (the per-row `ROUND(t.lat, 1)`
-- outside the GROUP BY just picks an arbitrary value), so the cube doesn't
-- lose visualization precision — it formalizes what the SQL already produced.
--
-- Same family as threat_cube_geo (0.01° geo grid), threat_cube_brand
-- (per-brand counts), threat_cube_provider (per-provider counts), and
-- threat_cube_status (per-status counts). The arcs cube is the country ×
-- brand × type × severity slice that the other cubes don't carry.
--
-- Refresh: Navigator current + previous hour every 5 min (Phase 3 pattern).
-- Backfill: 30-day rebuild every 6h via cube-healer.
--
-- INSERT OR REPLACE keyed on the full 6-tuple PK so hour-by-hour rebuilds
-- are idempotent and re-runnable without cleanup.
--
-- source_lat/lng are derived from `ROUND(AVG(lat), 1)` / `ROUND(AVG(lng), 1)`
-- across the rows in each PK group — the centroid of attacking IPs in that
-- country bucket. Better than the previous query's arbitrary-pick behaviour
-- and still 0.1° resolution.
--
-- first_seen / last_seen carry MIN/MAX(created_at) so the page query can
-- return them as MIN/MAX rollups across hours without re-scanning threats.

CREATE TABLE IF NOT EXISTS threat_cube_arcs (
  hour_bucket      TEXT    NOT NULL,
  country_code     TEXT    NOT NULL,
  target_brand_id  TEXT    NOT NULL,
  threat_type      TEXT    NOT NULL,
  severity         TEXT    NOT NULL,
  source_feed      TEXT    NOT NULL,
  threat_count     INTEGER NOT NULL DEFAULT 0,
  source_lat       REAL,
  source_lng       REAL,
  first_seen       TEXT,
  last_seen        TEXT,
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (hour_bucket, country_code, target_brand_id, threat_type, severity, source_feed)
);

CREATE INDEX IF NOT EXISTS idx_cube_arcs_hour
  ON threat_cube_arcs(hour_bucket DESC);

CREATE INDEX IF NOT EXISTS idx_cube_arcs_brand_hour
  ON threat_cube_arcs(target_brand_id, hour_bucket DESC);
