-- Feed-expansion Phase 1 — four zero-key net-new signal feeds.
--
-- Each lands as a feed_configs row dispatched to its own module under
-- feeds/index.ts. runAllFeeds auto-discovers them via the enabled=1
-- query + module map, so no orchestrator change is needed. schedule_cron
-- is interpreted as a poll INTERVAL by parseCronIntervalMs (feedRunner.ts),
-- not an exact fire time — "0 */6 * * *" = every 6h, "0 */12 * * *" = 12h.
--
--   ipsum             — stamparm/ipsum aggregated bad-IP feed WITH a
--                       blocklist-count score; we ingest score>=3 only.
--                       Complements dshield/cins_army/blocklist_de/
--                       spamhaus_drop by adding tunable confidence.
--   phishing_database — Phishing-Database NEW-today validated phishing
--                       DOMAINS (complements the URL feeds openphish/
--                       phishdestroy; de-risks the dead phishtank feed).
--   scam_blocklist    — jarelllama/Scam-Blocklist fresh scam/fraud
--                       domains (fake stores, drainers, impersonation).
--   epss              — FIRST.org Exploit Prediction Scoring System;
--                       writes an agent_outputs 'insight' row (like
--                       cisa_kev/nvd_cve), NOT threats. Prioritizes the
--                       vuln signal class by real-world exploit odds.
--
-- All free, no API key. Any IOC overlap with existing feeds is absorbed
-- by the deterministic threatId PK + KV dedup in insertThreat.

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'ipsum',
  'IPsum (aggregated bad-IP)',
  'stamparm/ipsum daily union of 30+ IP blocklists with a per-IP score (number of lists). Ingested at score>=3 for confidence control.',
  'https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt',
  '0 */6 * * *',
  1000,
  60,
  1
);
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('ipsum', 'healthy');

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'phishing_database',
  'Phishing.Database (new today)',
  'Phishing-Database/Phishing.Database PyFunceble-validated phishing domains — the NEW-today (freshly added) list. Domain-level phishing signal complementing the openphish/phishdestroy URL feeds.',
  'https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-NEW-today.txt',
  '0 */6 * * *',
  3000,
  60,
  1
);
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('phishing_database', 'healthy');

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'scam_blocklist',
  'Scam-Blocklist (jarelllama)',
  'jarelllama/Scam-Blocklist newly-created scam/fraud domains (fake stores, crypto drainers, brand-impersonation shops) detected via automated sweeps and liveness-validated.',
  'https://raw.githubusercontent.com/jarelllama/Scam-Blocklist/main/lists/wildcard_domains/scams.txt',
  '0 */12 * * *',
  5000,
  60,
  1
);
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('scam_blocklist', 'healthy');

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'epss',
  'EPSS (exploit prediction)',
  'FIRST.org Exploit Prediction Scoring System — top CVEs by 30-day exploitation probability. Writes an agent_outputs insight (not threats) to prioritize the vuln signal class alongside CISA KEV / NVD.',
  'https://api.first.org/data/v1/epss?order=!epss&limit=100',
  '0 */12 * * *',
  100,
  60,
  1
);
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('epss', 'healthy');
