-- 0329_dmarc_sensor.sql
-- Hosted DMARC aggregate reporting as a first-party spoofing sensor.
--
-- Additive only: CREATE TABLE / CREATE INDEX IF NOT EXISTS. No existing
-- table or column is dropped or altered.
--
-- ─── 1. dmarc_report_records (prod table that predates migrations/) ─────
-- No migration ever created dmarc_report_records; prod has it out-of-band.
-- The DDL below is the prod definition as copied from prod sqlite_master on
-- 2026-11-10 (test/brand-threat-assessments-daily.test.ts carried it as
-- PROD_DMARC_REPORT_RECORDS_DDL). In prod `IF NOT EXISTS` makes every
-- statement in this section a no-op; on a fresh database it installs the
-- exact prod shape, so no later migration may ADD COLUMN any of these
-- columns (it would fail in prod as a duplicate).
-- test/dmarc-sensor.test.ts pins the column set against that DDL.
--
-- dmarc_reports and dmarc_daily_stats are NOT recreated here: migration
-- 0043 already rebuilt both into their final shape (prod ran 0043, which
-- DROPped the out-of-band tables and renamed the _new ones in), so their
-- prod shape is migration-defined.

CREATE TABLE IF NOT EXISTS dmarc_report_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, report_id INTEGER NOT NULL, source_ip TEXT NOT NULL,
  count INTEGER DEFAULT 1, disposition TEXT, dkim_result TEXT, spf_result TEXT, dmarc_result TEXT,
  header_from TEXT, envelope_from TEXT, dkim_domain TEXT, spf_domain TEXT, country_code TEXT,
  city TEXT, lat REAL, lng REAL, asn TEXT, org TEXT,
  FOREIGN KEY (report_id) REFERENCES dmarc_reports(id)
);
CREATE INDEX IF NOT EXISTS idx_drr_report ON dmarc_report_records(report_id);
CREATE INDEX IF NOT EXISTS idx_drr_ip ON dmarc_report_records(source_ip);
CREATE INDEX IF NOT EXISTS idx_drr_dmarc_result ON dmarc_report_records(dmarc_result);

-- Diagnostics `dmarc_ingest.reports_24h` reads a received_at range; the only
-- existing index leads with brand_id (0325). The table is empty in prod, so
-- the build is instant.
CREATE INDEX IF NOT EXISTS idx_dmarc_reports_received ON dmarc_reports(received_at);

-- ─── 2. dmarc_report_seen — report de-duplication ───────────────────────
-- One row per (policy domain, reporter org, report id). The receiver claims
-- the key with INSERT … ON CONFLICT DO NOTHING inside the same D1 batch
-- that writes the dmarc_reports row and the daily-stats upsert; both of
-- those are guarded on `claim_id` matching this run's claim, so a resent
-- report changes nothing.
--
-- A separate table rather than CREATE UNIQUE INDEX on dmarc_reports: a
-- unique index fails the deploy if prod already holds a duplicate (the
-- table is believed empty but that is unverified); a brand-new table cannot
-- fail. report_id is the reporter's id, or `sha256:<hex>` of the XML when
-- the report carries none.
CREATE TABLE IF NOT EXISTS dmarc_report_seen (
  domain        TEXT NOT NULL,
  reporter_org  TEXT NOT NULL,
  report_id     TEXT NOT NULL,
  claim_id      TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (domain, reporter_org, report_id)
);

-- ─── 3. dmarc_source_daily — per brand × day × source IP rollup ─────────
-- Written by lib/dmarc-source-rollup.ts for the NON-PASSING source IPs of
-- each accepted report (≤200 per report). Read by
-- GET /api/dmarc-reports/:brandId/spoof-sources. METADATA ONLY: never
-- creates alerts or threats, never gates triage.
--   source_class      most-suspicious class seen (lib/dmarc-source-classify.ts
--                     DMARC_SOURCE_CLASS_RANK; merged in SQL on conflict)
--   source_rule       explainDmarcSource rule that produced source_class
--                     (evidence; follows the winning class on merge)
--   reporters         JSON array of reporter org names (≤20)
--   dkim_domain       DKIM d= of the largest failing record (latest wins)
--   envelope_from     envelope-from of the largest failing record
--   asn               canonical 'AS<digits>' (asnKey) or NULL when unknown
--   asn_drop_listed   1 when asn is on Spamhaus ASN-DROP (removed_at IS NULL)
-- brands.id is TEXT (migration 0043), so brand_id is TEXT.
-- The (brand_id, date) range reads are served by the primary key's own
-- index (brand_id, date, source_ip); no separate (brand_id, date) index.
CREATE TABLE IF NOT EXISTS dmarc_source_daily (
  brand_id            TEXT NOT NULL,
  date                TEXT NOT NULL,          -- 'YYYY-MM-DD' (UTC report day)
  source_ip           TEXT NOT NULL,
  messages            INTEGER NOT NULL DEFAULT 0,
  fail_messages       INTEGER NOT NULL DEFAULT 0,
  source_class        TEXT NOT NULL,
  source_rule         TEXT,
  reporters           TEXT,
  dkim_domain         TEXT,
  envelope_from       TEXT,
  asn                 TEXT,
  as_org              TEXT,
  country_code        TEXT,
  hosting_provider_id TEXT,
  cluster_id          TEXT,
  asn_drop_listed     INTEGER NOT NULL DEFAULT 0,
  first_seen          TEXT NOT NULL,
  last_seen           TEXT NOT NULL,
  PRIMARY KEY (brand_id, date, source_ip)
);
-- The rollup reuses an IP's already-resolved ASN / country from the last
-- 7 days before spending an ipinfo lookup on it.
CREATE INDEX IF NOT EXISTS idx_dmarc_source_daily_brand_ip
  ON dmarc_source_daily(brand_id, source_ip, date);

-- ─── 4. dmarc_enrollment — brands whose rua= points at Averrow ──────────
-- A report is stored only for an enrolled brand. Enrollment is established
-- from the brand's latest email_security_scans.dmarc_rua ('scan') or a live
-- DoH lookup of _dmarc.<domain> ('live_dns'), and re-verified after 30 days.
CREATE TABLE IF NOT EXISTS dmarc_enrollment (
  brand_id        TEXT PRIMARY KEY,
  domain          TEXT NOT NULL,
  rua_verified_at TEXT NOT NULL,
  verified_via    TEXT NOT NULL CHECK (verified_via IN ('scan', 'live_dns')),
  last_report_at  TEXT
);
