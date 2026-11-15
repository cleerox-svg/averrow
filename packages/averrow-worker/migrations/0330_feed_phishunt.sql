-- phishunt.io phishing-URL feed (feeds/phishunt.ts).
--
-- https://phishunt.io/feed.json: the rolling window of currently active,
-- brand-labelled phishing URLs (~700 records, ~0.85 MB, regenerated hourly,
-- edge-cached 15 min; verified 2026-11-15). Rows land in threats as
-- source_feed='phishunt', threat_type='phishing'; severity/confidence follow
-- phishunt's own verdict band, 'noise' is skipped. Dedup is the per-feed
-- SHA-256 threat id + INSERT OR IGNORE, so the repeated window is a no-op
-- and itemsNew counts only genuinely new URLs (~25-60/day).
--
-- Licence: CC0 1.0 on every data output (phishunt.io/tos §7); attribution
-- appreciated, not required. See docs/licences/phishunt.md.
--
-- schedule_cron is a poll INTERVAL (parseCronIntervalMs, lib/feedRunner.ts):
-- '0 * * * *' = every hour, dispatched from the hourly orchestrator's
-- runAllFeeds. Additive only: one feed_configs + feed_status seed.

INSERT INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('phishunt', 'phishunt.io',
  'Brand-labelled phishing URLs currently active, classified from Certificate Transparency and public phishing feeds, with hosting IP/ASN. Hourly rolling window; noise-band detections skipped. Source: phishunt.io (CC0 1.0), https://phishunt.io/feed/.',
  'https://phishunt.io/feed.json', 1, '0 * * * *', 'ingest', 60, 2000)
ON CONFLICT(feed_name) DO NOTHING;

INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('phishunt', 'healthy');
