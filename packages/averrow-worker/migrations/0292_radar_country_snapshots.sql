-- Cloudflare Radar — per-country daily snapshots (attack origins/targets,
-- bot density).
--
-- Backs the attack_origins / attack_targets / bot_density sections of
-- GET /api/bot-traffic (handlers/botTraffic.ts). Written once a day by the
-- cf_radar_bots feed module (feeds/cf_radar_bots.ts) alongside
-- bot_traffic_snapshots (migration 0290). A separate table because 0290's
-- `metric` CHECK cannot be widened without a table rebuild.
--
--   attack_origin — /radar/attacks/layer7/top/locations/origin (dateRange=7d).
--                   country_code = ISO alpha-2 of the attacking client IP,
--                   value_pct = share (%) of ALL layer-7 attacks, rank 1..10.
--   attack_target — /radar/attacks/layer7/top/locations/target (dateRange=7d).
--                   country_code = billing country of the attacked zone,
--                   value_pct = share (%) of ALL layer-7 attacks, rank 1..10.
--   bot_density   — derived (computeBotDensity) from the 1d bot-class
--                   summary + top-100 locations of LIKELY_AUTOMATED and
--                   LIKELY_HUMAN traffic. value_pct = % of that country's
--                   OWN HTTP traffic that is likely automated; traffic_pct =
--                   the country's share (%) of all HTTP traffic. Every
--                   country in both lists with traffic_pct >= 0.1, ranked
--                   by value_pct desc, capped at 100 rows.
--
-- traffic_pct is NULL for the attack metrics.
--
-- Additive only: new table + index. Nothing is written to `threats`.

CREATE TABLE IF NOT EXISTS radar_country_snapshots (
  snapshot_date TEXT NOT NULL,
  metric        TEXT NOT NULL CHECK (metric IN ('attack_origin', 'attack_target', 'bot_density')),
  country_code  TEXT NOT NULL,
  label         TEXT,
  rank          INTEGER,
  value_pct     REAL NOT NULL,
  traffic_pct   REAL,
  fetched_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (snapshot_date, metric, country_code)
);

CREATE INDEX IF NOT EXISTS idx_radar_country_snapshots_metric_date
  ON radar_country_snapshots (metric, snapshot_date);
