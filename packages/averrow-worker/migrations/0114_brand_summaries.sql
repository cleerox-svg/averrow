-- Brand-keyed summary tables for dark-web mentions and app-store listings.
--
-- Why brand-keyed (not hour-bucketed like threat_cube_*): the dark-web and
-- app-store overview/list handlers need "count of all active mentions per
-- brand" — there is no time-windowed slice (last 7d, 24h) on these pages.
-- An hour-bucketed cube would force SUM-over-all-buckets at read time for
-- every page load; one row per brand is the minimum-work answer for this
-- query shape.
--
-- Refresh strategy: rebuilt from scratch every 6h by cube_healer (matches
-- the existing 30-day threat cube rebuild cadence). The 5-min KV cache on
-- handler responses absorbs the staleness window. Real-time invalidation
-- on PATCH/POST writes is a separate follow-up.
--
-- Same INSERT OR REPLACE shape as threat_cube_* so rebuilds are idempotent.

CREATE TABLE IF NOT EXISTS dark_web_brand_summary (
  brand_id          TEXT    PRIMARY KEY,
  total_active      INTEGER NOT NULL DEFAULT 0,
  confirmed_active  INTEGER NOT NULL DEFAULT 0,
  suspicious_active INTEGER NOT NULL DEFAULT 0,
  critical_active   INTEGER NOT NULL DEFAULT 0,
  high_active       INTEGER NOT NULL DEFAULT 0,
  medium_active     INTEGER NOT NULL DEFAULT 0,
  low_active        INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dark_web_brand_summary_active
  ON dark_web_brand_summary(total_active DESC);

CREATE TABLE IF NOT EXISTS app_store_brand_summary (
  brand_id            TEXT    PRIMARY KEY,
  total_active        INTEGER NOT NULL DEFAULT 0,
  impersonation_active INTEGER NOT NULL DEFAULT 0,
  suspicious_active   INTEGER NOT NULL DEFAULT 0,
  legitimate_active   INTEGER NOT NULL DEFAULT 0,
  official_active     INTEGER NOT NULL DEFAULT 0,
  critical_active     INTEGER NOT NULL DEFAULT 0,
  high_active         INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_store_brand_summary_active
  ON app_store_brand_summary(total_active DESC);
