-- Migration 0055: Register Telegram and Mastodon social feeds

-- Register Telegram feed
INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('telegram', 'Telegram Threat Channel Monitor',
  'Monitors public Telegram channels for credential leaks, phishing kits, brand abuse, and threat actor discussions.',
  'https://api.telegram.org/', 1, '0 */4 * * *', 'social', 60, 5);

-- Register Mastodon feed
INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('mastodon', 'Mastodon/Fediverse Monitor',
  'Searches Mastodon instances (including infosec.exchange) for brand mentions, vulnerability disclosures, and threat discussions.',
  'https://mastodon.social/api/v2/', 1, '0 */4 * * *', 'social', 300, 10);

-- Ensure feed_status rows exist
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('telegram', 'healthy');
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('mastodon', 'healthy');

-- Index for faster social mentions platform queries
CREATE INDEX IF NOT EXISTS idx_social_mentions_platform_status ON social_mentions(platform, status, created_at);
