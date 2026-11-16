-- Site Script Watch — client-side supply-chain monitoring of a brand's OWN
-- website (Magecart / polyfill.io class). PR1: schema only. Nothing reads or
-- writes these tables yet; the scanner agent, cron, routes and alerts land in
-- later PRs. Pure diff / matching logic: src/lib/site-script-watch.ts.
--
-- Scope: brands the platform covers (brands.tier IN ('monitored','customer'),
-- lib/monitored-brands.ts) — the scanner decides that, not the schema.
--
-- site_scans: one row per scan of a brand's site (the page URL fetched).
--   status is free text (no CHECK, so a later PR can add a state without a
--   table rebuild): 'running' | 'complete' | 'failed' | 'skipped'.
--   scripts_count / hosts_count = distinct normalised scripts / external
--   script hosts seen. capture_ref = R2 key of any stored evidence object.
--
-- site_script_inventory: one row per (brand, script host, normalised path).
--   path_norm drops the query string and fragment (cache-busters). The
--   sha256 pair supports the `body_changed` diff: last_sha256 is the body seen
--   on the most recent scan, prev_sha256 the one before a change.
--
-- site_contacted_hosts: every host the page contacted (scripts, XHR, beacons),
--   one row per (brand, host).
--
-- site_script_findings: diff / IOC outcomes per scan. kind:
--   new_host     — an external script host never seen before for the brand
--   body_changed — same host + path, different sha256
--   ioc_match    — a script / contacted host matches an ACTIVE threat
--                  (threat_id set)
--   status is free text, default 'open' ('open' | 'acknowledged' |
--   'dismissed' | 'resolved').
--
-- No FOREIGN KEYs to brands / threats: D1 enforces FKs, and brands / threats
-- rows are retired by other writers that must not be blocked by this table.
--
-- Additive only: four new tables and their indexes.

CREATE TABLE IF NOT EXISTS site_scans (
  id             TEXT PRIMARY KEY,
  brand_id       TEXT NOT NULL,
  url            TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running',
  scanned_at     TEXT NOT NULL DEFAULT (datetime('now')),
  scripts_count  INTEGER NOT NULL DEFAULT 0,
  hosts_count    INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  capture_ref    TEXT
);

-- Latest scans per brand (baseline check, brand detail history).
CREATE INDEX IF NOT EXISTS idx_site_scans_brand_scanned
  ON site_scans(brand_id, scanned_at DESC);

CREATE TABLE IF NOT EXISTS site_script_inventory (
  brand_id        TEXT NOT NULL,
  script_host     TEXT NOT NULL,
  path_norm       TEXT NOT NULL,
  is_first_party  INTEGER NOT NULL DEFAULT 0 CHECK (is_first_party IN (0, 1)),
  first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen       TEXT NOT NULL DEFAULT (datetime('now')),
  last_sha256     TEXT,
  prev_sha256     TEXT,
  change_count    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (brand_id, script_host, path_norm)
);

CREATE TABLE IF NOT EXISTS site_contacted_hosts (
  brand_id       TEXT NOT NULL,
  host           TEXT NOT NULL,
  first_seen     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  request_count  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (brand_id, host)
);

CREATE TABLE IF NOT EXISTS site_script_findings (
  id             TEXT PRIMARY KEY,
  brand_id       TEXT NOT NULL,
  scan_id        TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('new_host', 'body_changed', 'ioc_match')),
  host           TEXT NOT NULL,
  path_norm      TEXT,
  threat_id      TEXT,
  evidence_json  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL DEFAULT 'open'
);

-- Brand detail: newest findings for a brand.
CREATE INDEX IF NOT EXISTS idx_site_script_findings_brand_created
  ON site_script_findings(brand_id, created_at DESC);
-- Findings produced by one scan.
CREATE INDEX IF NOT EXISTS idx_site_script_findings_scan
  ON site_script_findings(scan_id);
-- Open-findings queue (partial: only the rows a triage view reads).
CREATE INDEX IF NOT EXISTS idx_site_script_findings_open
  ON site_script_findings(created_at DESC) WHERE status = 'open';
