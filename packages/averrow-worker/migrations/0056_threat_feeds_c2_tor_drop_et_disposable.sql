-- Migration 0056: New tables + feed registrations for 5 zero-auth threat feeds
-- C2 Tracker, Spamhaus DROP/EDROP, Tor Exit Nodes, Emerging Threats, Disposable Email

-- ─── New Lookup Tables ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tor_exit_nodes (
  ip_address TEXT PRIMARY KEY,
  last_seen TEXT DEFAULT (datetime('now')),
  source TEXT DEFAULT 'torproject'
);

CREATE TABLE IF NOT EXISTS disposable_email_domains (
  domain TEXT PRIMARY KEY,
  last_updated TEXT DEFAULT (datetime('now'))
);

-- ─── Feed Configurations ────────────────────────────────────────

INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('c2_tracker', 'C2 Tracker',
  'Command & Control server IPs for Cobalt Strike, Sliver, Brute Ratel, Metasploit, Havoc, and Posh C2. Shodan-verified, updated weekly.',
  'https://github.com/montysecurity/C2-Tracker', 1, '0 */12 * * *', 'ingest', 60, 500);

INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('spamhaus_drop', 'Spamhaus DROP/EDROP',
  'Hijacked network ranges (CIDR blocks) used for spam, malware, and botnets. Gold-standard network-level blocklist.',
  'https://www.spamhaus.org/drop/drop.txt', 1, '0 3 * * *', 'ingest', 60, 1000);

INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('tor_exit_nodes', 'Tor Exit Nodes',
  'Current Tor network exit node IPs from torproject.org. Used to flag anonymized attack traffic in threat analysis.',
  'https://check.torproject.org/torbulkexitlist', 1, '0 4 * * *', 'ingest', 60, 5000);

INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('emerging_threats', 'Emerging Threats',
  'Proofpoint ET compromised IP blocklist — well-curated list of actively compromised hosts.',
  'https://rules.emergingthreats.net/blockrules/compromised-ips.txt', 1, '0 */12 * * *', 'ingest', 60, 500);

INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('disposable_email', 'Disposable Email Domains',
  'Blocklist of throwaway email domains (~3,500). Used to flag suspicious senders in spam trap analysis.',
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf',
  1, '0 0 * * 0', 'ingest', 60, 5000);

-- ─── Feed Status Rows ───────────────────────────────────────────

INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('c2_tracker', 'healthy');
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('spamhaus_drop', 'healthy');
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('tor_exit_nodes', 'healthy');
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('emerging_threats', 'healthy');
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('disposable_email', 'healthy');
