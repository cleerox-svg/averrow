-- CERT Polska Warning List feed (feeds/certPolska.ts).
--
-- https://hole.cert.pl/domains/v2/domains.json: the full 6-month list of
-- dangerous domains maintained by CSIRT NASK (~124K records, ~22 MB,
-- regenerated about every 5 min; verified 2026-11-15), newest first by
-- RegisterPositionId. The module streams only the head of the file down to
-- its KV watermark, so a pull reads a few KB. First pull: baseline = only
-- the last 24h of additions; later pulls: additions since the watermark,
-- at most 500 rows per pull. Expected ~300-900 new domains/day.
--
-- Licence: "may be used by any user for any purpose, including commercial
-- purposes" (cert.pl/en/warning-list, Data usage policy). Attribution not
-- required; it must not imply cooperation with or endorsement by NASK-PIB /
-- CERT Polska. See docs/licences/cert_polska.md.
--
-- schedule_cron is a poll INTERVAL (parseCronIntervalMs, lib/feedRunner.ts):
-- '0 * * * *' = every hour. Additive only: one feed_configs + feed_status seed.

INSERT INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('cert_polska', 'CERT Polska Warning List',
  'Dangerous (phishing / fraud) domains targeting Polish internet users, curated by CSIRT NASK. Hourly watermark diff of the newest additions; the 6-month back-catalog is not ingested. Source: CERT Polska Warning List, https://cert.pl/en/warning-list/ (commercial use permitted).',
  'https://hole.cert.pl/domains/v2/domains.json', 1, '0 * * * *', 'ingest', 60, 500)
ON CONFLICT(feed_name) DO NOTHING;

INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('cert_polska', 'healthy');
