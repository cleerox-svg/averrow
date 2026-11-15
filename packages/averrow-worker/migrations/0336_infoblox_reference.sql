-- Infoblox Threat Intel open indicator data, as staff-only REFERENCE context.
--
-- feeds/infobloxReference.ts (feed key `infoblox_reference`) reads the
-- per-publication CSVs under
-- https://raw.githubusercontent.com/infobloxopen/threat-intelligence/main/indicators/csv/
-- (columns type,indicator,classification,detected_date) once a day. Only
-- domain and IP rows are stored; url / sha256 / email rows are skipped, as
-- are rows Infoblox classifies 'legitimate' / 'unavailable' / 'other' and the
-- two all-legitimate files. Bounded: newest 10,000 rows per file
-- (INFOBLOX_MAX_ROWS_PER_FILE), 120,000 in total (INFOBLOX_MAX_ROWS_TOTAL);
-- about 99,000 rows on 2026-11-15.
--
-- Licence: CC BY 4.0 (attribution to Infoblox + licence link + "changed"
-- notice, INFOBLOX_CREDIT in lib/infoblox-reference.ts). Snapshot:
-- docs/licences/infoblox.md.
--
-- Reference data ONLY. No threats, alerts, attribution, scoring or triage
-- read these tables. The single reader is the staff threat detail
-- (GET /api/threats/:id -> `infoblox_reference`, lookupInfobloxReference).
-- The labels are Infoblox's naming (e.g. "VexTrio", "Prolific Puma"), not an
-- Averrow attribution, and are not shown to customers.
--
-- infoblox_reference: one row per (source_file, indicator). indicator is
-- normalised (refanged, lowercased, no trailing dot). removed_at is stamped
-- when a row leaves its file (or the file leaves upstream) on a complete
-- read, and cleared if it comes back. The PK serves the feed's per-file
-- diff; idx_infoblox_reference_indicator serves the lookup.
--
-- infoblox_reference_files: one row per upstream file: its label, the
-- ETag / sha256 of the last fully loaded body (the change guard: an
-- unchanged file costs a conditional GET and no D1 write), row counts.
--
-- Additive only: two new tables, one index, a feed_configs / feed_status seed.

CREATE TABLE IF NOT EXISTS infoblox_reference_files (
  source_file      TEXT PRIMARY KEY,          -- file name under indicators/csv/
  label            TEXT NOT NULL,             -- Infoblox's actor / campaign name
  label_kind       TEXT NOT NULL CHECK (label_kind IN ('actor', 'campaign')),
  publication_url  TEXT,
  etag             TEXT,                      -- ETag of the last fully loaded body
  content_sha256   TEXT,                      -- sha256 of that body
  rows_loaded      INTEGER NOT NULL DEFAULT 0,
  rows_capped      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'loaded' CHECK (status IN ('loaded', 'absent', 'retired')),
  loaded_at        TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS infoblox_reference (
  source_file      TEXT NOT NULL,
  indicator        TEXT NOT NULL,
  indicator_type   TEXT NOT NULL CHECK (indicator_type IN ('domain', 'ip')),
  classification   TEXT,                      -- as published, lowercased
  detected_date    TEXT,                      -- YYYY-MM-DD as published
  first_seen       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  removed_at       TEXT,                      -- NULL = present upstream
  PRIMARY KEY (source_file, indicator)
);

CREATE INDEX IF NOT EXISTS idx_infoblox_reference_indicator
  ON infoblox_reference (indicator);

-- schedule_cron is a poll INTERVAL (parseCronIntervalMs): '0 5 * * *' = every
-- 24h from the hourly orchestrator's runAllFeeds. Upstream adds a file every
-- few weeks; the first load spans about two daily runs (per-run write budget).
INSERT INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('infoblox_reference', 'Infoblox threat-intel reference',
  'Infoblox Threat Intel published indicators (domains, IPs) with Infoblox''s actor / campaign label (VexTrio, Prolific Puma, ...). Staff-only reference data: writes infoblox_reference, not threats, and never attributes, scores or triages. Source: Infoblox, https://github.com/infobloxopen/threat-intelligence - CC BY 4.0.',
  'https://raw.githubusercontent.com/infobloxopen/threat-intelligence/main/indicators/csv/', 1, '0 5 * * *', 'ingest', 60, 500)
ON CONFLICT(feed_name) DO NOTHING;

INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('infoblox_reference', 'healthy');
