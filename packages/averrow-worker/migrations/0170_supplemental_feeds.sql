-- Trust Radar — supplemental no-auth feeds.
--
-- Two new ingest feeds that don't require any operator credential
-- registration — both land as standard feed_configs rows pulled
-- on the hourly orchestrator tick. They complement the existing
-- corpus rather than overlap with it:
--
--   nvd_cve       — NIST NVD CVE 2.0 JSON. Pulls a sliding 24-hour
--                   window of newly-published CVEs. Supplements
--                   CISA KEV (which is the curated "known
--                   exploited" subset of ~1000 entries) with the
--                   FULL CVE catalog. Schedule is hourly + low
--                   batch since NVD's free rate limit is 5 req /
--                   30 sec without an API key.
--
--   cryptoscamdb  — community-maintained crypto-phishing
--                   blacklist (URLs only for v1; wallet
--                   addresses deferred until we add a dedicated
--                   schema column). Direct relevance to fintech
--                   / crypto customers (Crypto.com is already
--                   in our brand catalog). Static JSON file
--                   from the GitHub mirror; pulling every 6h is
--                   sufficient given the project's update cadence.

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'nvd_cve',
  'NIST NVD (CVE 2.0)',
  'NIST National Vulnerability Database — full CVE catalog with CVSS scoring. Supplements CISA KEV with broader vuln context.',
  'https://services.nvd.nist.gov/rest/json/cves/2.0',
  '0 * * * *',
  2000,
  10,
  1
);

INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled
) VALUES (
  'cryptoscamdb',
  'CryptoScamDB',
  'Community blacklist of crypto-phishing URLs + scam exchanges. Brand-protection signal for fintech / web3 customers.',
  'https://raw.githubusercontent.com/CryptoScamDB/blacklist/master/data/urls.json',
  '17 */6 * * *',
  10000,
  60,
  1
);
