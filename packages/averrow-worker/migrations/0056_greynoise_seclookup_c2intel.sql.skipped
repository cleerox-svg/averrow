-- Migration 0056: GreyNoise + SecLookup enrichment columns + C2IntelFeeds registration
-- GreyNoise columns
ALTER TABLE threats ADD COLUMN greynoise_checked INTEGER DEFAULT 0;
ALTER TABLE threats ADD COLUMN greynoise_noise INTEGER;
ALTER TABLE threats ADD COLUMN greynoise_riot INTEGER;
ALTER TABLE threats ADD COLUMN greynoise_classification TEXT;

-- SecLookup columns
ALTER TABLE threats ADD COLUMN seclookup_checked INTEGER DEFAULT 0;
ALTER TABLE threats ADD COLUMN seclookup_risk_score INTEGER;
ALTER TABLE threats ADD COLUMN seclookup_threat_type TEXT;

-- Feed config registrations
INSERT INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('greynoise', 'GreyNoise IP Context',
  'Determines if threat IPs are mass-scanning the internet (noise) or potentially targeting specific organizations. Separates background noise from real attacks.',
  'https://api.greynoise.io/v3/community/', 1, '0 */4 * * *', 'enrichment', 50, 8)
ON CONFLICT(feed_name) DO NOTHING;

INSERT INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('seclookup', 'SecLookup Intelligence',
  'Domain and IP threat intelligence with 1M free lookups/month. Bulk enrichment engine for comprehensive threat validation.',
  'https://api.seclookup.com/v1/', 1, '*/30 * * * *', 'enrichment', 33000, 100)
ON CONFLICT(feed_name) DO NOTHING;

INSERT INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('c2_intel_feeds', 'C2 Intel Feeds',
  'C2 infrastructure domains and IPs with 30-day rolling window from drb-ra/C2IntelFeeds.',
  'https://github.com/drb-ra/C2IntelFeeds', 1, '0 5 * * *', 'ingest', 60, 300)
ON CONFLICT(feed_name) DO NOTHING;

-- Feed status rows
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('greynoise', 'healthy');
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('seclookup', 'healthy');
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('c2_intel_feeds', 'healthy');
