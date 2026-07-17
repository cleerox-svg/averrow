-- Trust Radar — two more zero-credential public OSINT feeds.
--
-- Same shape as 0168 (PhishStats + urlscan.io) and 0170 (NVD CVE +
-- CryptoScamDB) — public, no auth required, drop into the standard
-- FeedRunner pipeline. Brings the no-auth feed count to 8 across
-- these recent volume passes.
--
--   digitalside_osint  — DigitalSide.it OSINT project. Plain-text
--                        lists of recent malicious URLs / IPs /
--                        domains. One module pulls all three
--                        endpoints serially. Continuous refresh
--                        upstream; hourly pull is plenty for our
--                        downstream uses.
--
--   tweetfeed          — Researcher-curated IOCs from X/Twitter.
--                        90+ infosec accounts → curated JSON
--                        feed. Refreshed every 15 min upstream;
--                        hourly is the right cadence on our end
--                        (anything tighter overlaps too much
--                        with the previous pull). Default `today`
--                        endpoint carries the last 24h of new
--                        rows so we self-correct on missed ticks.

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'digitalside_osint',
  'DigitalSide.it OSINT',
  'DigitalSide Threat-Intel project — latest malicious URL/IP/domain lists. Free public text feeds.',
  'https://osint.digitalside.it/Threat-Intel/lists/',
  '0 * * * *',
  1000,
  30,
  1
);

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'tweetfeed',
  'TweetFeed.live',
  'IOCs aggregated from 90+ infosec researchers on X/Twitter. Refreshed every 15 min upstream; we pull `today` hourly.',
  'https://api.tweetfeed.live/v1/today',
  '0 * * * *',
  500,
  30,
  1
);
