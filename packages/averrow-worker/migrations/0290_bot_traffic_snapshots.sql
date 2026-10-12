-- Internet bot traffic — Cloudflare Radar daily snapshots.
--
-- Backs GET /api/bot-traffic (handlers/botTraffic.ts). Written once a day
-- by the cf_radar_bots feed module (feeds/cf_radar_bots.ts), which pulls
-- five Cloudflare Radar endpoints and upserts one row per
-- (snapshot_date, metric, dim_key):
--
--   bot_share    — dim_key 'bot' / 'human'; global HTTP request share (%).
--                  Backfilled from a 28-day 1d timeseries on every pull so
--                  the trend chart has history from day one.
--   top_location — dim_key = ISO alpha-2 country, label = country name,
--                  rank 1..10; share (%) of LIKELY_AUTOMATED traffic.
--   top_asn      — dim_key = ASN as text, label = AS name, rank 1..10.
--   bot_category — dim_key = verified-bot category (AI_CRAWLER, ...).
--
-- Additive only: new table + index + one feed_configs/feed_status seed.
-- Nothing is written to `threats` — this is platform context, not IOCs.

CREATE TABLE IF NOT EXISTS bot_traffic_snapshots (
  snapshot_date TEXT NOT NULL,
  metric        TEXT NOT NULL CHECK (metric IN ('bot_share', 'top_location', 'top_asn', 'bot_category')),
  dim_key       TEXT NOT NULL,
  label         TEXT,
  rank          INTEGER,
  value_pct     REAL NOT NULL,
  fetched_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (snapshot_date, metric, dim_key)
);

CREATE INDEX IF NOT EXISTS idx_bot_traffic_snapshots_metric_date
  ON bot_traffic_snapshots (metric, snapshot_date);

-- Feed registration. schedule_cron is a poll INTERVAL (parseCronIntervalMs
-- in lib/feedRunner.ts), not an exact fire time — "0 6 * * *" = every 24h,
-- dispatched from the hourly orchestrator's runAllFeeds. feed_type defaults
-- to 'ingest' (migration 0051), which is the dispatch lane feedModules uses.
-- Requires the existing CF_API_TOKEN secret to carry the "Radar Read"
-- permission; without it every pull fails loudly (HTTP 401/403).
INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'cf_radar_bots',
  'Cloudflare Radar — Bot Traffic',
  'Cloudflare Radar global HTTP bot-vs-human share (with 28-day daily backfill), top source countries and ASNs of likely-automated traffic, and verified-bot category mix. Writes bot_traffic_snapshots (not threats). Needs Radar Read on CF_API_TOKEN.',
  'https://api.cloudflare.com/client/v4/radar',
  '0 6 * * *',
  100,
  60,
  1
);
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('cf_radar_bots', 'healthy');
