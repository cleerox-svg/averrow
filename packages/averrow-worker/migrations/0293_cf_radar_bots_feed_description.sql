-- Refresh the cf_radar_bots feed description shown on the Feeds page.
--
-- Migration 0290 seeded it when the feed made five Radar calls and used the
-- shared CF_API_TOKEN. Since #1822/#1825 the feed makes eight calls (adds
-- layer-7 attack origins/targets and the human top-locations list used to
-- derive per-country bot density into radar_country_snapshots, 0292) and
-- prefers the read-only CF_RADAR_API_TOKEN secret. Data-only, idempotent;
-- touches this one row.
UPDATE feed_configs
SET description = 'Cloudflare Radar internet bot traffic (daily): global HTTP bot-vs-human share with 28-day backfill, top bot-origin countries and ASNs, verified-bot category mix, layer-7 attack origins/targets (7d), and per-country bot density. Writes bot_traffic_snapshots and radar_country_snapshots (not threats). Uses the read-only CF_RADAR_API_TOKEN secret (falls back to CF_API_TOKEN); needs Radar Read.'
WHERE feed_name = 'cf_radar_bots';
