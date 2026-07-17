-- Phase 1: Unify brand data model — add social monitoring fields to core brands table

-- Social identity fields
ALTER TABLE brands ADD COLUMN official_handles TEXT;          -- JSON: {"twitter":"@acme","linkedin":"acmecorp",...}
ALTER TABLE brands ADD COLUMN aliases TEXT;                   -- JSON array: ["ACME","Acme Corporation"]
ALTER TABLE brands ADD COLUMN brand_keywords TEXT;            -- JSON array: ["acme","acmecorp","acme-corp"]
ALTER TABLE brands ADD COLUMN executive_names TEXT;           -- JSON array: ["Jane Smith (CEO)"]
ALTER TABLE brands ADD COLUMN logo_url TEXT;
ALTER TABLE brands ADD COLUMN logo_hash TEXT;                 -- perceptual hash for visual similarity matching
ALTER TABLE brands ADD COLUMN website_url TEXT;               -- public website for social link discovery

-- Monitoring configuration
ALTER TABLE brands ADD COLUMN monitoring_tier TEXT DEFAULT 'scan';  -- scan|professional|business|enterprise
ALTER TABLE brands ADD COLUMN monitoring_status TEXT DEFAULT 'inactive'; -- inactive|active|paused

-- Composite scores (updated by scanners and agents)
ALTER TABLE brands ADD COLUMN social_risk_score INTEGER;      -- 0-100
ALTER TABLE brands ADD COLUMN domain_risk_score INTEGER;      -- 0-100
ALTER TABLE brands ADD COLUMN email_grade TEXT;               -- A+ through F
ALTER TABLE brands ADD COLUMN exposure_score INTEGER;         -- 0-100 composite

-- Social monitoring timestamps
ALTER TABLE brands ADD COLUMN last_social_scan TEXT;
ALTER TABLE brands ADD COLUMN next_social_scan TEXT;

-- New table: social_profiles — one row per platform per brand (replaces social_monitor_results for profile tracking)
CREATE TABLE IF NOT EXISTS social_profiles (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,               -- twitter, linkedin, instagram, tiktok, github, youtube
  handle TEXT NOT NULL,                 -- the actual handle (without @)
  profile_url TEXT,                     -- full URL to the profile
  display_name TEXT,                    -- scraped display name
  bio TEXT,                             -- scraped bio/description
  avatar_url TEXT,                      -- profile picture URL
  followers_count INTEGER,
  verified INTEGER DEFAULT 0,           -- 0/1
  account_created TEXT,                 -- if discoverable

  -- Classification
  classification TEXT DEFAULT 'unknown', -- official|legitimate|suspicious|impersonation|parked
  classified_by TEXT,                    -- 'ai'|'manual'|user_id
  classification_confidence REAL,        -- 0.0-1.0 (AI confidence)
  classification_reason TEXT,            -- human-readable explanation

  -- AI assessment fields
  ai_assessment TEXT,                   -- full AI assessment text
  ai_confidence REAL,                   -- 0.0-1.0
  ai_action TEXT,                       -- safe|review|escalate|takedown
  ai_evidence_draft TEXT,               -- pre-drafted takedown evidence
  ai_assessed_at TEXT,                  -- when AI last assessed this profile

  -- Impersonation scoring (from impersonation-scorer.ts)
  impersonation_score REAL DEFAULT 0,   -- 0.0-1.0
  impersonation_signals TEXT,           -- JSON array of signal descriptions
  severity TEXT DEFAULT 'LOW',          -- LOW|MEDIUM|HIGH|CRITICAL

  -- Status tracking
  status TEXT DEFAULT 'active',         -- active|resolved|false_positive|takedown_requested|taken_down
  resolved_by TEXT,
  resolved_at TEXT,
  takedown_requested_at TEXT,
  taken_down_at TEXT,

  -- Metadata
  last_checked TEXT,
  last_changed TEXT,                    -- when profile content last changed
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_social_profiles_brand ON social_profiles(brand_id);
CREATE INDEX IF NOT EXISTS idx_social_profiles_platform ON social_profiles(brand_id, platform);
CREATE INDEX IF NOT EXISTS idx_social_profiles_classification ON social_profiles(classification);
CREATE INDEX IF NOT EXISTS idx_social_profiles_severity ON social_profiles(severity) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_social_profiles_status ON social_profiles(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_profiles_brand_platform_handle ON social_profiles(brand_id, platform, handle);

-- Update social_monitor_schedule to reference brands.id instead of brand_profiles.id
-- We create a NEW schedule table that references brands
CREATE TABLE IF NOT EXISTS brand_monitor_schedule (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  monitor_type TEXT NOT NULL,           -- social|email|domain|threat_feed
  platform TEXT,                        -- for social: twitter, linkedin, etc. NULL for other types
  last_checked TEXT,
  next_check TEXT,
  check_interval_hours INTEGER DEFAULT 24,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_schedule_type ON brand_monitor_schedule(brand_id, monitor_type, platform);
CREATE INDEX IF NOT EXISTS idx_brand_schedule_next ON brand_monitor_schedule(next_check) WHERE enabled = 1;
