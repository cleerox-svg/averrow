-- Add PhishStats and PhishDestroy feed configurations

INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, schedule_cron, rate_limit, batch_size, enabled) VALUES
  ('phishstats',   'PhishStats',    'Phishing URLs with confidence scores, IP, ASN, country (CSV)', 'https://phishstats.info/phish_score.csv',  '0 */2 * * *', 10, 2000, 1),
  ('phishdestroy', 'PhishDestroy',  'Curated phishing & scam domain blocklist (770K+ domains)',     'https://raw.githubusercontent.com/phishdestroy/destroylist/main/list.json', '0 */6 * * *', 10, 5000, 1);

INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES
  ('phishstats',   'healthy'),
  ('phishdestroy', 'healthy');
