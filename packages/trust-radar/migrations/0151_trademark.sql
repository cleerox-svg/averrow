-- Trademark Infringement — registered assets + discovered uses.
--
-- Two-table additive layout:
--
--   trademark_assets    one row per brand-registered asset (logo,
--                       wordmark, combined). Stores raw file
--                       bytes by SHA-256 (in R2/KV; this row keeps
--                       the URL pointer) plus a perceptual hash
--                       (pHash) for fuzzy match at scan time.
--
--   trademark_findings  one row per discovered use of an asset
--                       somewhere it shouldn't be (a third-party
--                       site, social profile picture, app icon).
--                       Bound to its source asset by asset_id;
--                       match_distance is the Hamming distance
--                       between the source pHash and the found
--                       image pHash (lower = closer match).
--
-- Tenant scope: brand_id on every row → org_brands at read time.
-- Scanner wiring (image-hash crawler + vision-LLM fallback) lands
-- in a follow-up sprint; this surface ships read-side.
--
-- Phase B sprint 7.

CREATE TABLE IF NOT EXISTS trademark_assets (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,

  -- Asset identity
  asset_type TEXT NOT NULL,                    -- 'logo' | 'wordmark' | 'combined'
  asset_name TEXT,                             -- customer-supplied label, e.g. "Acme primary mark"
  asset_url  TEXT,                             -- pointer to raw file (R2 / external)
  asset_hash TEXT,                             -- sha256 of raw bytes
  phash      TEXT,                             -- 64-bit perceptual hash, stored as 16-char hex

  -- Registration metadata (optional, customer may not have a registration on file)
  registration_country TEXT,
  registration_number  TEXT,
  registration_date    TEXT,

  -- Lifecycle
  status     TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'retired'
  created_by TEXT,                             -- user_id who uploaded

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trademark_assets_brand
  ON trademark_assets (brand_id, status);

CREATE INDEX IF NOT EXISTS idx_trademark_assets_phash
  ON trademark_assets (phash)
  WHERE phash IS NOT NULL;

CREATE TABLE IF NOT EXISTS trademark_findings (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  asset_id TEXT             REFERENCES trademark_assets(id) ON DELETE SET NULL,

  -- Where it was found
  found_url       TEXT NOT NULL,               -- the page / app / profile location
  found_context   TEXT,                        -- 'website' | 'social' | 'app_store' | 'marketplace' | 'other'
  found_image_url TEXT,                        -- direct URL to the image asset that was matched
  found_at        TEXT NOT NULL DEFAULT (datetime('now')),

  -- Match math
  found_phash      TEXT,                       -- pHash of the discovered image
  match_distance   INTEGER,                    -- Hamming distance to source asset pHash (0-64; 0 = identical)
  match_confidence REAL,                       -- 0-1 normalized score (1 - distance/64, with floor)

  -- Classification
  classification            TEXT NOT NULL DEFAULT 'unknown',  -- unknown | confirmed | likely | false_positive | resolved
  classified_by             TEXT,                              -- system | ai | manual
  classification_confidence REAL,
  classification_reason     TEXT,
  ai_assessment             TEXT,
  ai_action                 TEXT,                              -- safe | review | escalate | takedown

  -- Risk
  severity TEXT NOT NULL DEFAULT 'LOW',        -- LOW | MEDIUM | HIGH | CRITICAL
  status   TEXT NOT NULL DEFAULT 'active',     -- active | resolved | false_positive | investigating

  -- Timestamps
  first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen    TEXT,
  resolved_at  TEXT,
  resolved_by  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dedup: one row per (brand, found_url, asset). Re-encounters update last_seen.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trademark_findings_uniq
  ON trademark_findings (brand_id, found_url, COALESCE(asset_id, ''));

CREATE INDEX IF NOT EXISTS idx_trademark_findings_brand
  ON trademark_findings (brand_id);

CREATE INDEX IF NOT EXISTS idx_trademark_findings_active_severity
  ON trademark_findings (brand_id, severity)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_trademark_findings_classification
  ON trademark_findings (classification, status);

CREATE INDEX IF NOT EXISTS idx_trademark_findings_context
  ON trademark_findings (found_context, status);
