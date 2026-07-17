-- Migration 0204: Named-threat catalog + advisory feed registration
--
-- Adds the platform's first catalog of KNOWN, NAMED threats (PhaaS kits,
-- malware families, campaigns, APT toolkits). Until now naming came only
-- from OTX adversary tags (state APTs + ransomware) and AI-invented
-- campaign names — there was no way to match an incoming indicator/lure
-- against a real-world name like "Kali365".
--
-- The catalog is matched two ways:
--   1. abuse-mailbox / lure content  → lib/named-threat-matcher.ts
--   2. government / vendor advisories → feeds/advisories.ts (populates it)
--
-- Signatures are intentionally split:
--   keyword_signatures  — lowercased substrings (cheap contains check)
--   regex_signatures    — JS-flavored regex source strings (behavioral)
--   ioc_domains/urls/ips — exact-match indicators
-- A match is only NAMED when a strong signal (IOC or regex) fires, or a
-- technique match is corroborated by >=2 keyword hits. See the matcher.

CREATE TABLE IF NOT EXISTS named_threats (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  aliases            TEXT,            -- JSON array of alternate names
  category           TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (category IN ('phaas','apt','ransomware','malware','botnet','scam','campaign','unknown')),
  technique          TEXT,            -- e.g. 'device_code_phishing','oauth_consent_phishing','aitm_phishing'
  description        TEXT,
  severity           TEXT DEFAULT 'medium'
                       CHECK (severity IN ('critical','high','medium','low','info')),
  keyword_signatures TEXT,            -- JSON array of lowercased substrings
  regex_signatures   TEXT,            -- JSON array of regex source strings
  ioc_domains        TEXT,            -- JSON array
  ioc_urls           TEXT,            -- JSON array
  ioc_ips            TEXT,            -- JSON array
  source             TEXT NOT NULL DEFAULT 'manual'
                       CHECK (source IN ('manual','fbi','cisa','vendor','news','otx')),
  source_url         TEXT,
  reference_url      TEXT,
  match_count        INTEGER NOT NULL DEFAULT 0,   -- bumped each time the matcher names something
  last_matched_at    TEXT,
  first_seen         TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_named_threats_technique ON named_threats(technique);
CREATE INDEX IF NOT EXISTS idx_named_threats_enabled ON named_threats(enabled);

-- ─── Seed: Kali365 (the headline) ───────────────────────────────
-- Microsoft 365 device-code OAuth-token-theft PhaaS, FBI PSA May 2026.
-- source_url left NULL deliberately — we don't fabricate the IC3 URL;
-- the advisories feed fills it in if/when the PSA is ingested.
INSERT OR IGNORE INTO named_threats
  (id, name, aliases, category, technique, description, severity,
   keyword_signatures, regex_signatures, ioc_domains, ioc_urls, ioc_ips,
   source, first_seen)
VALUES (
  'nt_kali365', 'Kali365', '["Kali 365","Kali-365"]', 'phaas', 'device_code_phishing',
  'Phishing-as-a-Service kit targeting Microsoft 365. Steals OAuth access tokens and bypasses MFA via device-code phishing without intercepting credentials. AI-generated lures, automated templates, OAuth token capture. Distributed via Telegram. Subject of an FBI PSA, May 2026.',
  'high',
  '["device code","devicelogin","microsoft 365","office 365","m365","oauth token","verification code","enter the code","enter this code","sign-in code","outlook","onedrive","teams"]',
  '["microsoft\\.com\\/devicelogin","aka\\.ms\\/devicelogin","login\\.microsoftonline\\.com\\/[^\\s\"]*device(?:code|auth)","microsoft\\.com\\/device\\b"]',
  '[]', '[]', '[]',
  'fbi', '2026-04-01'
);

-- ─── Seed: other publicly-documented M365 PhaaS / AiTM kits ──────
-- These mostly match advisory TEXT (the kit name) + IOCs the advisory
-- feed attaches over time. Lures rarely contain the kit name, so their
-- keyword signatures are the names themselves — useful on the feed path,
-- harmless on the lure path.
INSERT OR IGNORE INTO named_threats
  (id, name, aliases, category, technique, description, severity,
   keyword_signatures, regex_signatures, ioc_domains, ioc_urls, ioc_ips, source, first_seen)
VALUES
 ('nt_tycoon2fa', 'Tycoon 2FA', '["Tycoon2FA"]', 'phaas', 'aitm_phishing',
  'Adversary-in-the-middle PhaaS kit that proxies Microsoft 365 / Gmail logins to capture session cookies and bypass MFA.',
  'high', '["tycoon 2fa","tycoon2fa"]', '[]', '[]', '[]', '[]', 'vendor', '2023-10-01'),
 ('nt_evilproxy', 'EvilProxy', '["Storm-1167"]', 'phaas', 'aitm_phishing',
  'Reverse-proxy AiTM phishing service that harvests session tokens for MFA-protected accounts.',
  'high', '["evilproxy"]', '[]', '[]', '[]', '[]', 'vendor', '2022-09-01'),
 ('nt_greatness', 'Greatness', '[]', 'phaas', 'aitm_phishing',
  'Phishing-as-a-Service kit focused on Microsoft 365 credential and session-token theft.',
  'high', '["greatness phishing"]', '[]', '[]', '[]', '[]', 'vendor', '2023-05-01');

-- ─── Advisory ingestion feed registration ───────────────────────
-- Pulls CISA's (and CISA/FBI joint) cybersecurity-advisories RSS and
-- extracts NAMED threats into named_threats above. See feeds/advisories.ts.
INSERT OR IGNORE INTO feed_configs
  (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES (
  'advisories', 'Gov/Vendor Advisories',
  'CISA & CISA/FBI joint cybersecurity advisories (RSS). Extracts named threats — PhaaS kits, malware families, campaigns — into the named-threat catalog so incoming indicators can be identified by name.',
  'https://www.cisa.gov/cybersecurity-advisories/all.xml',
  1, '0 7 * * *', 'ingest', 30, 50
);

INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('advisories', 'healthy');
