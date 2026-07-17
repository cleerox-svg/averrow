-- Migration 0021: CISA Iran IOC feed configuration
-- Adds feed_configs entry for the new CISA Iran IOC ingest feed.

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, feed_type, enabled,
  schedule_cron, source_url, batch_size, rate_limit,
  retry_count, retry_delay_seconds,
  created_at, updated_at
) VALUES (
  'cisa_iran_iocs',
  'CISA Iran IOCs',
  'Iranian APT indicators of compromise from CISA advisories, APT35 GitHub repo, and community feeds. Includes IPs, domains, and hashes from known IRGC-linked operations.',
  'ingest',
  1,
  '0 */6 * * *',
  'https://raw.githubusercontent.com/JayGLXR/APT35-IOCs/main/IOCs/master_feed.json',
  200,
  30,
  3,
  60,
  datetime('now'),
  datetime('now')
);

-- Seed known Iranian APT infrastructure as threats (immediate backfill)
INSERT OR IGNORE INTO threats (
  id, source_feed, threat_type, ip_address, ioc_value,
  severity, confidence_score, status, created_at
) VALUES
  ('thr-iran-seed-157-20-182-49', 'cisa_iran_iocs', 'c2', '157.20.182.49', '157.20.182.49', 'critical', 95, 'active', datetime('now')),
  ('thr-iran-seed-38-180-239-161', 'cisa_iran_iocs', 'c2', '38.180.239.161', '38.180.239.161', 'critical', 95, 'active', datetime('now')),
  ('thr-iran-seed-91-132-197-186', 'cisa_iran_iocs', 'c2', '91.132.197.186', '91.132.197.186', 'critical', 95, 'active', datetime('now')),
  ('thr-iran-seed-104-129-28-18', 'cisa_iran_iocs', 'c2', '104.129.28.18', '104.129.28.18', 'critical', 95, 'active', datetime('now'));

-- Update Telegram feed config to reflect new channel list and schedule
UPDATE feed_configs SET
  description = 'Monitors public Telegram channels for credential leaks, phishing kits, brand abuse, and Iranian threat actor activity (IRGC, APT35, CyberAv3ngers, Handala).',
  updated_at = datetime('now')
WHERE feed_name = 'telegram';
