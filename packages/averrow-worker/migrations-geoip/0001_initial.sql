-- GeoIP reference database — separate D1 binding to keep the main
-- threats DB read budget untouched.
--
-- This database holds a flattened slice of the MaxMind GeoLite2-City
-- product (or an equivalent free dataset like db-ip Lite). Cartographer
-- queries it as a 3rd geo provider after ip-api.com and ipinfo.io
-- can't return lat/lng for a malicious IP — typical for sinkhole,
-- anycast, and CDN-fronted addresses.
--
-- Why a separate D1: the main `trust-radar-v2` DB carries the threats,
-- agents, and operational data that user-facing reads compete for.
-- A lookup against ~5M geo ranges every cartographer tick (up to
-- 2,500 IPs × per-tick) would inflate that DB's read budget and slow
-- user-facing pages. Isolating it in `geoip-db` keeps the read profile
-- separate, lets the operator size it independently, and eliminates
-- cube-builder ↔ geo lookup contention.
--
-- Lookup pattern: SELECT * FROM geo_ip_ranges
--                 WHERE start_ip_int <= ?  ORDER BY start_ip_int DESC
--                 LIMIT 1   ← then verify end_ip_int >= ?
--
-- That's a single-row index seek on PRIMARY KEY (start_ip_int) with
-- LIMIT 1, returning in <5ms even for a fully populated table.

CREATE TABLE IF NOT EXISTS geo_ip_ranges (
  -- IPv4 numeric form: 4 octets folded to a 32-bit integer.
  -- INTEGER PRIMARY KEY makes this a SQLite rowid table — no
  -- secondary B-tree, the row data sits inline with the key.
  start_ip_int INTEGER PRIMARY KEY NOT NULL,
  end_ip_int   INTEGER NOT NULL,

  country_code TEXT,
  country_name TEXT,
  region       TEXT,
  city         TEXT,
  postal_code  TEXT,

  -- Coordinates returned by the source. Null when the source has
  -- only country-level data for the range (still useful — country
  -- code beats nothing).
  lat REAL,
  lng REAL,

  -- Network identity. Optional because not every dataset bundles
  -- ASN with City — but if we have it, we use it (saves an extra
  -- ASN lookup downstream).
  asn         TEXT,
  asn_org     TEXT,

  -- Provenance — cartographer's outputs reference where the data
  -- came from so an operator can spot when one provider is leaking
  -- bad data into the system.
  source     TEXT NOT NULL,           -- e.g. 'maxmind-geolite2-city'
  loaded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Range queries hit the PRIMARY KEY for the upper bound; the index
-- below catches the rare case where we need to find ranges by
-- end_ip_int (e.g. validation queries, gap detection).
CREATE INDEX IF NOT EXISTS idx_geo_ip_end ON geo_ip_ranges(end_ip_int);

-- Loader bookkeeping — every successful refresh writes one row.
-- The latest row's `completed_at` drives the dashboard "last
-- refreshed" indicator.
CREATE TABLE IF NOT EXISTS geo_ip_refresh_log (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,         -- 'maxmind-geolite2-city' | 'db-ip-lite'
  rows_written INTEGER NOT NULL DEFAULT 0,
  rows_deleted INTEGER NOT NULL DEFAULT 0,
  source_version TEXT,                -- e.g. '2026-04-30' (MaxMind release date)
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  status       TEXT NOT NULL DEFAULT 'running',  -- running | success | failed
  error_message TEXT,
  duration_ms  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_geo_refresh_completed ON geo_ip_refresh_log(completed_at DESC);
