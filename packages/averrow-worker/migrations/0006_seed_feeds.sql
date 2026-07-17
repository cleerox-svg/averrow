-- Trust Radar v2 — Seed Feed Configurations
-- Default feed configs for MVP (Phase 1 feeds)

INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, schedule_cron, rate_limit, batch_size, enabled) VALUES
  ('ct_logs',     'Certificate Transparency', 'CT log monitoring for lookalike domains via crt.sh',       'https://crt.sh',                                '*/5 * * * *',  10,  100, 1),
  ('phishtank',   'PhishTank',                'Community-verified phishing URLs',                          'http://data.phishtank.com/data/online-valid.json', '0 * * * *',  60,  500, 1),
  ('urlhaus',     'URLhaus',                  'Malware distribution URLs from abuse.ch',                   'https://urlhaus-api.abuse.ch/v1/',               '*/5 * * * *',  30,  200, 1),
  ('openphish',   'OpenPhish',                'Automated phishing intelligence feed',                      'https://openphish.com/feed.txt',                 '0 */12 * * *', 10,  500, 1),
  ('threatfox',   'ThreatFox',                'IOC sharing platform from abuse.ch',                        'https://threatfox-api.abuse.ch/api/v1/',         '0 * * * *',    30,  200, 1),
  ('feodo',       'Feodo Tracker',            'Botnet C2 server tracking from abuse.ch',                   'https://feodotracker.abuse.ch/downloads/ipblocklist.json', '0 */6 * * *', 10, 500, 1);

-- Seed corresponding feed_status entries
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES
  ('ct_logs',     'disabled'),
  ('phishtank',   'disabled'),
  ('urlhaus',     'disabled'),
  ('openphish',   'disabled'),
  ('threatfox',   'disabled'),
  ('feodo',       'disabled');
