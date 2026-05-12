-- Trust Radar — two more zero-credential public feeds.
--
-- Same shape as 0168 / 0170 / 0171 — public, no auth required.
-- This pass focuses on first-party attacker telemetry: honeypot-
-- derived IPs and Talos's curated community blocklist. Both
-- complement (rather than duplicate) the existing reputation
-- feeds.
--
--   dataplane    — DataPlane.org honeypot mesh. One module pulls
--                  six categorized lists (sshpwauth, sshclient,
--                  telnetlogin, dnsrd, sipinvitation, proto41)
--                  and tags each IP with the attack category in
--                  ioc_value JSON. Severity varies by category:
--                  ssh_password_spray + telnet_brute → high,
--                  ssh_scanner + dns_recursion_abuse + sip → med,
--                  ipv6 proto-41 abuse → low. Hourly cadence.
--
--   talos_ips    — Cisco Talos / Snort community IP blocklist.
--                  Plain-text, daily refresh upstream. Single
--                  IP per row, threat_type='malicious_ip'. Cisco
--                  doesn't publish a programmatic reputation
--                  API (their web lookup is UI-only and
--                  scraping would violate TOS); the bulk
--                  blocklist is the feed-shaped equivalent.
--                  6-hourly cadence — upstream only refreshes
--                  daily, so hourly polls would burn rate on
--                  nothing.

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'dataplane',
  'DataPlane.org honeypot mesh',
  'Six categorized attacker-IP feeds from DataPlane.org honeypots — SSH password spray, telnet brute force, DNS recursion abuse, SIP scanners, IPv6 proto-41 abuse.',
  'https://dataplane.org/',
  '0 * * * *',
  5000,
  30,
  1
);

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'talos_ips',
  'Cisco Talos / Snort IP Blocklist',
  'Curated IP blocklist from Cisco Talos (powers Snort community rules). Plain-text bulk download, refreshed daily upstream.',
  'https://www.talosintelligence.com/documents/ip-blacklist',
  '0 */6 * * *',
  5000,
  30,
  1
);
