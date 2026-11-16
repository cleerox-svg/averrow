-- Site Script Watch — client-side supply-chain monitoring of a brand's OWN
-- website (Magecart / polyfill.io class). PR1: schema only. Nothing reads or
-- writes these tables yet; the scanner agent, cron, routes and alerts land in
-- later PRs. Pure diff / matching logic: src/lib/site-script-watch.ts.
--
-- Scope: brands the platform covers (brands.tier IN ('monitored','customer'),
-- lib/monitored-brands.ts) — the scanner decides that, not the schema.
--
-- Status / kind columns are free text (no CHECK) so a later PR can add a
-- value without a table rebuild (D1 enforces FKs, so rebuilds are unsafe);
-- the allowed values are documented here and in site-script-watch.ts.
--
-- ── Retention (enforced by the scanner PR, not here) ──────────────────
--   site_scans            90 days by scanned_at   (idx_site_scans_scanned)
--   site_contacted_hosts  90 days by last_seen    (idx_site_contacted_hosts_last_seen)
--   site_script_findings 180 days by created_at   (idx_site_script_findings_created)
--   site_script_inventory by last_seen: a script not seen for 90 days is
--                         dropped (idx_site_script_inventory_last_seen), so a
--                         script that comes back is "new" again.
--
-- ── site_scans ────────────────────────────────────────────────────────
-- One row per scan of a brand's site. url = the entry page fetched (a scan
-- may visit further pages; findings carry their own page_url).
--   status: 'running' | 'complete' | 'failed' | 'skipped'. 'skipped' = the
--   scan finished but looked implausible (e.g. 0 scripts where the previous
--   complete scan had several, assessScanPlausibility) — it is neither
--   diffed nor counted as history for the baseline decision.
--   scripts_count / hosts_count = distinct normalised scripts / external
--   script hosts seen. capture_ref = R2 key of any stored evidence object.
--
-- ── site_script_inventory ─────────────────────────────────────────────
-- One row per (brand, script_host, path_norm).
--   External script: script_host = lowercase ASCII (punycode) host; path_norm
--     = URL path + the identity-bearing query params only (`id` always, plus
--     a small per-host allowlist, sorted — normaliseScriptUrl). Cache-buster
--     params and the fragment are dropped. The port is not part of the key.
--   Inline script: is_inline = 1, script_host = '(inline)' (not a valid
--     hostname, so it can never collide with a real host), path_norm =
--     'sha256:<hex>' of the NORMALISED script text (normaliseInlineScriptText:
--     whitespace collapsed, long digit / hex runs masked). An edited inline
--     script is therefore a new row, never body_changed.
--   last_sha256 / prev_sha256: body on the latest scan / the one before a
--     change (`body_changed`). integrity: the script tag's SRI attribute on
--     the latest scan (NULL = none); losing it raises `sri_removed`.
--   first_page_url: the page the script was first seen on.
--
-- ── site_contacted_hosts ──────────────────────────────────────────────
-- Every host the page contacted (scripts, XHR / fetch, beacons, websockets),
-- one row per (brand, host). initiator_host / initiator_path = the script
-- that made the FIRST observed request to the host (kept, not overwritten),
-- so a new exfil endpoint points at the script that calls it.
--
-- ── site_script_findings ──────────────────────────────────────────────
-- Diff / IOC outcomes. kind:
--   new_host           — external script host never seen for the brand
--                        (public script CDNs exempt; shared-hosting tenants
--                        such as *.herokuapp.com are NOT exempt)
--   new_script         — new path on an already-inventoried host (first-party
--                        content-hashed build files exempt), or a new inline
--                        script once inline scripts are inventoried
--   body_changed       — same host + path_norm, different sha256
--   sri_removed        — the script carried an integrity attribute before and
--                        no longer does
--   new_contacted_host — the page contacted a host it never did before
--                        (first-party and public script CDNs exempt)
--   ioc_match          — a script / contacted host / script URL matches an
--                        ACTIVE threat (threat_id set)
-- status: 'open' (default) | 'acknowledged' | 'dismissed' | 'resolved'.
-- page_url: the page the finding was observed on.
-- dedupe_key: findingDedupeKey() — kind | host | path_norm | threat_id, plus
--   the new sha256 for body_changed (a second change while the first is open
--   is a new finding). One OPEN finding per (brand_id, dedupe_key): writers
--   INSERT … ON CONFLICT (brand_id, dedupe_key) WHERE status = 'open'
--   DO NOTHING. Once closed, the same key may open again.
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

-- Latest scans per brand (baseline decision, plausibility check, history).
CREATE INDEX IF NOT EXISTS idx_site_scans_brand_scanned
  ON site_scans(brand_id, scanned_at DESC);
-- Retention sweep.
CREATE INDEX IF NOT EXISTS idx_site_scans_scanned
  ON site_scans(scanned_at);

CREATE TABLE IF NOT EXISTS site_script_inventory (
  brand_id        TEXT NOT NULL,
  script_host     TEXT NOT NULL,
  path_norm       TEXT NOT NULL,
  is_first_party  INTEGER NOT NULL DEFAULT 0 CHECK (is_first_party IN (0, 1)),
  is_inline       INTEGER NOT NULL DEFAULT 0 CHECK (is_inline IN (0, 1)),
  first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen       TEXT NOT NULL DEFAULT (datetime('now')),
  first_page_url  TEXT,
  last_sha256     TEXT,
  prev_sha256     TEXT,
  integrity       TEXT,
  change_count    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (brand_id, script_host, path_norm)
);

-- Retention sweep (inventory rows not seen for 90 days).
CREATE INDEX IF NOT EXISTS idx_site_script_inventory_last_seen
  ON site_script_inventory(last_seen);

CREATE TABLE IF NOT EXISTS site_contacted_hosts (
  brand_id        TEXT NOT NULL,
  host            TEXT NOT NULL,
  first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen       TEXT NOT NULL DEFAULT (datetime('now')),
  request_count   INTEGER NOT NULL DEFAULT 0,
  initiator_host  TEXT,
  initiator_path  TEXT,
  UNIQUE (brand_id, host)
);

-- Retention sweep.
CREATE INDEX IF NOT EXISTS idx_site_contacted_hosts_last_seen
  ON site_contacted_hosts(last_seen);

CREATE TABLE IF NOT EXISTS site_script_findings (
  id             TEXT PRIMARY KEY,
  brand_id       TEXT NOT NULL,
  scan_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,
  host           TEXT NOT NULL,
  path_norm      TEXT,
  page_url       TEXT,
  threat_id      TEXT,
  dedupe_key     TEXT NOT NULL,
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
-- Retention sweep.
CREATE INDEX IF NOT EXISTS idx_site_script_findings_created
  ON site_script_findings(created_at);
-- One OPEN finding per (brand, dedupe_key); the conflict target for
-- INSERT … ON CONFLICT (brand_id, dedupe_key) WHERE status = 'open' DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_script_findings_open_dedupe
  ON site_script_findings(brand_id, dedupe_key) WHERE status = 'open';
