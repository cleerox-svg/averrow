-- Materialized counter cache for Flight Control backlog metrics.
--
-- Context: Flight Control's measureBacklogs() runs 13 COUNT(*) queries against
-- threats (174K rows) every hourly tick. Eight of them filter on _checked
-- columns that have no index, so each is a full scan. At ~720 ticks/month
-- that's roughly 1B rows_read/month just for monitoring counters that drift
-- by <0.1% per tick.
--
-- This table stores the latest value per metric key with a TTL. Flight
-- Control reads the cached value when fresh and recomputes only when stale.
-- Expensive monitoring backlogs (SURBL, DBL, GSB, SecLookup — the ones
-- where the predicate matches 50-70% of the table and a partial index
-- wouldn't save much) get a 4h TTL: one recompute every 4 ticks instead
-- of every tick.
--
-- Cubes (threat_cube_*) are NOT a substitute: they drop NULL-dimension
-- rows by design (geo cube has no entries for NULL lat/lng; brand cube
-- has no entries for NULL target_brand_id) and they don't track
-- enrichment state columns (enriched_at, surbl_checked, vt_checked, etc).
-- Backlog queries are specifically about the rows cubes omit.

CREATE TABLE IF NOT EXISTS system_metrics (
  metric_key   TEXT PRIMARY KEY,
  value_int    INTEGER NOT NULL,
  computed_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  ttl_seconds  INTEGER NOT NULL DEFAULT 3600
);

-- Covering lookup by key — read path is WHERE metric_key = ? only.
-- (PRIMARY KEY already provides this on most SQLite configs, but being
-- explicit keeps it consistent across D1 versions.)
CREATE INDEX IF NOT EXISTS idx_system_metrics_key
  ON system_metrics(metric_key);
