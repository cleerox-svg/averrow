-- 0300 — Observatory Phase B (B3): weaponization-velocity cube + the
-- indexes that keep its writers bounded.
--
-- Additive only. New table + two partial indexes on threats; no existing
-- column is dropped, altered or rewritten.
--
-- threat_cube_velocity
--   Hourly count of ACTIVE threats per (country, weaponization flag), for
--   the two "fast" flags only. Source: threats.weaponization_flag (0259),
--   bucketed by threats.created_at like every other cube; country_code NULL
--   → 'XX' (same key normalisation as threat_cube_geo / _arcs).
--   Written ONLY by the cube_healer agent (day-chunked [stale sweep, guarded
--   upsert] batches — same atomic pattern as the other cubes; the source
--   predicate is VELOCITY_SOURCE_FILTER in lib/cube-builder.ts). NOT rebuilt by
--   Navigator: flags are stamped after ingest (cube_healer's incremental
--   stamping page), never at insert time, so the current/previous hour
--   almost never carries a flag and a 5-min rebuild would be pure read cost.
--   Metadata only — never gates alert triage / the AI judge.
CREATE TABLE IF NOT EXISTS threat_cube_velocity (
  hour_bucket  TEXT    NOT NULL,
  country_code TEXT    NOT NULL,
  flag         TEXT    NOT NULL CHECK (flag IN ('very_fast', 'fast')),
  threat_count INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (hour_bucket, country_code, flag)
);

-- Cube source index. The heal/sweep read
--   WHERE created_at >= ? AND created_at < ? AND status = 'active'
--     AND weaponization_flag IN ('very_fast','fast')
-- With this partial COVERING index the read touches only the flagged
-- index entries of the window (a small fraction of threats, no table
-- lookups), which is what makes a 90-day cold heal of this cube affordable.
-- Leading `status` matters: with ANALYZE stats a (created_at)-only partial
-- index loses to idx_threats_status_created, which walks EVERY active row of
-- the window (pinned by EXPLAIN QUERY PLAN in test/velocity-cube.test.ts).
CREATE INDEX IF NOT EXISTS idx_threats_velocity_fast_created
  ON threats(status, created_at, country_code, weaponization_flag)
  WHERE weaponization_flag IN ('very_fast', 'fast');

-- Incremental stamping index. cube_healer stamps ≤500 rows per run with a
-- keyset page
--   WHERE domain_created_at IS NOT NULL AND weaponization_flag IS NULL
--     AND id > ? ORDER BY id LIMIT ?
-- A stamped row leaves this index, so it stays the size of the unstamped
-- backlog (+ the rows whose velocity is not computable, which the cursor
-- walks past once per cycle).
CREATE INDEX IF NOT EXISTS idx_threats_velocity_unstamped
  ON threats(id)
  WHERE domain_created_at IS NOT NULL AND weaponization_flag IS NULL;
