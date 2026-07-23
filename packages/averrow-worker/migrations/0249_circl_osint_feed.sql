-- Feed-expansion Phase 2 — CIRCL OSINT (no-key MISP-format feed).
--
-- Phase 2 was originally scoped as "wire more TAXII 2.1 collections
-- through the generic taxii.ts consumer, config-row only." That premise
-- no longer holds: the free TAXII 2.1 IOC ecosystem has collapsed —
-- CIRCL and abuse.ch never ran / dropped TAXII, Anomali Limo + Hail-a-
-- TAXII are dead, and the remaining live TAXII 2.1 IOC feeds (Pulsedive,
-- SikkerAPI) are now API-key-gated. So the no-key half of Phase 2 is
-- delivered as a purpose-built MISP-feed module instead.
--
--   circl_osint — CIRCL (Luxembourg CERT) OSINT indicator set, published
--                 as a MISP feed (manifest.json + per-event JSON). The
--                 module (feeds/circl_osint.ts) walks the manifest, drains
--                 events newer than a KV timestamp cursor (oldest-first,
--                 capped per pull, 30-day backfill floor), and extracts
--                 detection-quality (to_ids) network IOCs (domain / url /
--                 ip) into threats. Overlap absorbed by the threatId PK.
--
-- Free, no API key. schedule_cron is a poll INTERVAL (parseCronIntervalMs)
-- — "0 */6 * * *" = every 6h; CIRCL adds a handful of events per day.
--
-- source_url is MISP's documented default-feed location for CIRCL OSINT;
-- the module appends manifest.json / <uuid>.json to it.

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'circl_osint',
  'CIRCL OSINT (MISP)',
  'CIRCL (Luxembourg CERT) OSINT indicator set via its MISP feed (manifest + per-event JSON). Detection-quality network IOCs (domain/url/ip). Not TAXII — purpose-built MISP walker.',
  'https://www.circl.lu/doc/misp/feed-osint',
  '0 */6 * * *',
  500,
  60,
  1
);
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('circl_osint', 'healthy');
