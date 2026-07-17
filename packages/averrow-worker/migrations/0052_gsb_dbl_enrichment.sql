-- 0052_gsb_dbl_enrichment.sql
-- Add Google Safe Browsing and Spamhaus DBL enrichment columns to threats table

-- Google Safe Browsing enrichment columns
ALTER TABLE threats ADD COLUMN gsb_checked INTEGER DEFAULT 0;
ALTER TABLE threats ADD COLUMN gsb_flagged INTEGER DEFAULT 0;
ALTER TABLE threats ADD COLUMN gsb_threat_type TEXT;

-- Spamhaus DBL enrichment columns
ALTER TABLE threats ADD COLUMN dbl_checked INTEGER DEFAULT 0;
ALTER TABLE threats ADD COLUMN dbl_listed INTEGER DEFAULT 0;
ALTER TABLE threats ADD COLUMN dbl_type TEXT;

-- Register Google Safe Browsing feed (enabled, enrichment type, every 30 min)
INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size, retry_count)
VALUES ('google_safe_browsing', 'Google Safe Browsing',
  'URL safety checks against Google''s phishing and malware lists (Lookup API v4). Batch checks up to 100 URLs per run.',
  'https://safebrowsing.googleapis.com/v4/', 1, '*/30 * * * *', 'enrichment', 500, 100, 2);

INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('google_safe_browsing', 'healthy');

-- Register Spamhaus DBL feed (enabled, enrichment type, every 30 min)
INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size, retry_count)
VALUES ('spamhaus_dbl', 'Spamhaus DBL',
  'Domain Block List checks via dbl.spamhaus.org DNS — identifies spam, phishing, malware, and botnet C2 domains.',
  'dns:dbl.spamhaus.org', 1, '*/30 * * * *', 'enrichment', 50, 50, 2);

INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('spamhaus_dbl', 'healthy');
