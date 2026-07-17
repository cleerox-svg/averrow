-- App Store impersonation monitoring
-- Adds:
--   1. brands.official_apps: customer-declared legitimate apps (allowlist for classification)
--   2. app_store_listings: per-brand candidate findings from the iTunes Search API
--      (and future Google Play / 3rd-party Android stores — `store` column keeps rows disjoint)
--   3. brand_monitor_schedule unique constraint already covers ('appstore','ios'),
--      so no schema changes there — scheduler rows are inserted at scan time.

ALTER TABLE brands ADD COLUMN official_apps TEXT;

CREATE TABLE IF NOT EXISTS app_store_listings (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,

  -- Store identity
  store TEXT NOT NULL,                    -- 'ios' | 'google_play' | 'apkpure' | ...
  app_id TEXT NOT NULL,                   -- iOS trackId, Play package name
  bundle_id TEXT,                         -- iOS CFBundleIdentifier
  app_name TEXT NOT NULL,
  developer_name TEXT,
  developer_id TEXT,
  seller_url TEXT,
  app_url TEXT,
  icon_url TEXT,

  -- Store metadata (snapshot at scan time)
  price REAL,
  currency TEXT,
  rating REAL,
  rating_count INTEGER,
  release_date TEXT,
  store_updated_at TEXT,
  version TEXT,
  categories TEXT,                        -- JSON array
  description TEXT,

  -- Classification
  classification TEXT DEFAULT 'unknown',  -- unknown | official | legitimate | suspicious | impersonation
  classified_by TEXT,                     -- system | ai | manual | auto_discovery
  classification_confidence REAL,
  classification_reason TEXT,

  -- AI assessment (populated only for ambiguous rows)
  ai_assessment TEXT,
  ai_confidence REAL,
  ai_action TEXT,                         -- safe | review | escalate | takedown
  ai_assessed_at TEXT,

  -- Risk signals
  impersonation_score REAL DEFAULT 0,
  impersonation_signals TEXT,             -- JSON array
  severity TEXT DEFAULT 'LOW',            -- LOW | MEDIUM | HIGH | CRITICAL
  status TEXT DEFAULT 'active',           -- active | resolved | false_positive | takedown_requested | taken_down

  -- Timestamps
  first_seen TEXT DEFAULT (datetime('now')),
  last_checked TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  takedown_requested_at TEXT,
  taken_down_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_store_listings_uniq
  ON app_store_listings (brand_id, store, app_id);

CREATE INDEX IF NOT EXISTS idx_app_store_listings_brand
  ON app_store_listings (brand_id);

CREATE INDEX IF NOT EXISTS idx_app_store_listings_active_severity
  ON app_store_listings (brand_id, severity)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_app_store_listings_classification
  ON app_store_listings (classification, status);
