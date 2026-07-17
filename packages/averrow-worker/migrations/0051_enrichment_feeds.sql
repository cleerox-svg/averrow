-- 0051_enrichment_feeds.sql
-- Add enrichment feed infrastructure: SURBL, VirusTotal, HIBP stealer logs

-- Add feed_type column to distinguish ingest feeds from enrichment feeds
ALTER TABLE feed_configs ADD COLUMN feed_type TEXT NOT NULL DEFAULT 'ingest';

-- Add SURBL enrichment columns to threats table
ALTER TABLE threats ADD COLUMN surbl_checked INTEGER DEFAULT 0;
ALTER TABLE threats ADD COLUMN surbl_listed INTEGER DEFAULT 0;
ALTER TABLE threats ADD COLUMN surbl_type TEXT;

-- Add VirusTotal enrichment columns to threats table
ALTER TABLE threats ADD COLUMN vt_checked INTEGER DEFAULT 0;
ALTER TABLE threats ADD COLUMN vt_malicious INTEGER DEFAULT 0;
ALTER TABLE threats ADD COLUMN vt_reputation INTEGER;

-- Create stealer_log_results table for HIBP integration
CREATE TABLE IF NOT EXISTS stealer_log_results (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  brand_id TEXT,
  entries_count INTEGER DEFAULT 0,
  latest_entry_date TEXT,
  checked_at TEXT NOT NULL,
  raw_response TEXT
);

CREATE INDEX IF NOT EXISTS idx_stealer_log_results_domain ON stealer_log_results(domain);
CREATE INDEX IF NOT EXISTS idx_stealer_log_results_brand ON stealer_log_results(brand_id);

-- Register SURBL feed (enabled, enrichment type, every 30 min)
INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size, retry_count)
VALUES ('surbl', 'SURBL Domain Reputation', 'DNS-based domain reputation checks via multi.surbl.org — validates existing threat domains against SURBL blocklists', 'dns:multi.surbl.org', 1, '*/30 * * * *', 'enrichment', 50, 200, 2);

INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('surbl', 'healthy');

-- Register VirusTotal enrichment feed (enabled, enrichment type, every 30 min)
INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size, retry_count)
VALUES ('virustotal', 'VirusTotal Domain Enrichment', 'Domain reputation enrichment for high-severity threats via VirusTotal API (free tier: 4 req/min, 500/day)', 'https://www.virustotal.com/api/v3/', 1, '*/30 * * * *', 'enrichment', 4, 10, 1);

INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('virustotal', 'healthy');

-- Register HIBP stealer logs feed (DISABLED — requires Pro subscription)
INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size, retry_count)
VALUES ('hibp_stealer_logs', 'HIBP Stealer Logs', 'Credential exposure checks for monitored brand domains via Have I Been Pwned stealer log API (requires Pro subscription)', 'https://haveibeenpwned.com/api/v3/', 0, '0 6 * * *', 'enrichment', 10, 50, 2);

INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('hibp_stealer_logs', 'disabled');
