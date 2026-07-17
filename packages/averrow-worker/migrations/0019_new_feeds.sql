-- New feeds: AlienVault OTX, CISA KEV, MalwareBazaar

-- ─── Register feed configs ───────────────────────────────────────
INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, schedule_cron, rate_limit, batch_size, enabled) VALUES
  ('otx_alienvault', 'AlienVault OTX', 'Community threat intelligence pulses from AlienVault Open Threat Exchange', 'https://otx.alienvault.com/api/v1/pulses/activity', '0 */2 * * *', 10, 200, 1),
  ('cisa_kev',       'CISA KEV',       'Known exploited vulnerabilities catalog from US Cybersecurity and Infrastructure Security Agency', 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', '0 6 * * *', 5, 50, 1),
  ('malwarebazaar',  'MalwareBazaar',   'Recent malware samples with delivery URLs from abuse.ch', 'https://mb-api.abuse.ch/api/v1/', '0 */4 * * *', 10, 100, 1);

-- ─── Register feed_status entries ────────────────────────────────
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES
  ('otx_alienvault', 'healthy'),
  ('cisa_kev',       'healthy'),
  ('malwarebazaar',  'healthy');
