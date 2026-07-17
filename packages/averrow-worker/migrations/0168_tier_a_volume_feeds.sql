-- Trust Radar — Tier-A volume adds.
--
-- Two no-auth, high-volume public feeds from the OSINT-expansion
-- plan's Tier-A list (the velocity track, no operator setup
-- required). Each lands as a feed_configs row dispatched to its
-- own module under feeds/index.ts. Both write into threats via
-- the standard insertThreat dedup helper, so any overlap with
-- existing feeds (openphish, phishtank, urlhaus) is absorbed
-- by threat_id collisions.
--
--   phishstats  — JSON phishing-URL feed, ~500/pull, hourly
--   urlscanio   — public urlscan search for recent malicious
--                 verdicts, ~200/pull, hourly. Optional
--                 URLSCAN_API_KEY env var bumps rate limit;
--                 module falls through to anonymous if unset.
--
-- Both feeds complement (not duplicate) the existing phishing
-- corpus and add per-row metadata (ASN, country, screenshot URL,
-- urlscan _id) that downstream correlation will need once the
-- visual-hashing pipeline (Stride 3 of the OSINT plan) lands.

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'phishstats',
  'PhishStats',
  'Community phishing URL feed, no auth. JSON, ~500 latest entries per pull.',
  'https://phishstats.info:2096/api/phishing',
  '0 * * * *',
  500,
  60,
  1
);

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'urlscanio',
  'urlscan.io public search',
  'Recent public scans flagged malicious by urlscan verdicts. Anonymous access by default; URLSCAN_API_KEY (optional) bumps rate limit.',
  'https://urlscan.io/api/v1/search/',
  '0 * * * *',
  200,
  60,
  1
);
