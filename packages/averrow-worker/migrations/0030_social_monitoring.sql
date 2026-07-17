-- Social Brand Monitoring tables

-- Brand profiles with official handles and monitoring config
CREATE TABLE IF NOT EXISTS brand_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  domain TEXT NOT NULL,
  brand_name TEXT NOT NULL,
  aliases TEXT,  -- JSON array of alternate names
  official_handles TEXT,  -- JSON: {"twitter": "@acme", "linkedin": "acmecorp", ...}
  brand_keywords TEXT,  -- JSON array: ["acme", "acme corp", "acmecorp"]
  executive_names TEXT,  -- JSON array for enterprise tier
  logo_url TEXT,
  logo_hash TEXT,  -- perceptual hash for visual similarity
  monitoring_tier TEXT DEFAULT 'scan',  -- scan | professional | business | enterprise
  status TEXT DEFAULT 'active',  -- active | paused | archived
  last_full_scan TEXT,
  next_scheduled_scan TEXT,
  exposure_score INTEGER,  -- 0-100
  email_grade TEXT,  -- A+ through F
  social_risk_score INTEGER,  -- 0-100
  domain_risk_score INTEGER,  -- 0-100
  threat_feed_score INTEGER,  -- 0-100
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_profiles_user_domain
  ON brand_profiles(user_id, domain);
CREATE INDEX IF NOT EXISTS idx_brand_profiles_next_scan
  ON brand_profiles(next_scheduled_scan) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_brand_profiles_user
  ON brand_profiles(user_id);

-- Social monitoring scan results
CREATE TABLE IF NOT EXISTS social_monitor_results (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brand_profiles(id),
  platform TEXT NOT NULL,  -- twitter, linkedin, instagram, tiktok, github, youtube
  check_type TEXT NOT NULL,  -- handle_check, impersonation_scan, mention_scan
  handle_checked TEXT,
  handle_available INTEGER,  -- 0/1/null
  handle_owner_matches_brand INTEGER,  -- 0/1
  suspicious_account_url TEXT,
  suspicious_account_name TEXT,
  impersonation_score REAL,  -- 0.0-1.0
  impersonation_signals TEXT,  -- JSON array
  ai_assessment TEXT,
  severity TEXT DEFAULT 'LOW',  -- LOW | MEDIUM | HIGH | CRITICAL
  status TEXT DEFAULT 'open',  -- open | investigating | resolved | false_positive
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_social_results_brand
  ON social_monitor_results(brand_id);
CREATE INDEX IF NOT EXISTS idx_social_results_severity
  ON social_monitor_results(severity) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_social_results_platform
  ON social_monitor_results(brand_id, platform);

-- Social monitoring schedule per platform per brand
CREATE TABLE IF NOT EXISTS social_monitor_schedule (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brand_profiles(id),
  platform TEXT NOT NULL,
  last_checked TEXT,
  next_check TEXT,
  check_interval_hours INTEGER DEFAULT 24,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_schedule_brand_platform
  ON social_monitor_schedule(brand_id, platform);
CREATE INDEX IF NOT EXISTS idx_social_schedule_next
  ON social_monitor_schedule(next_check) WHERE enabled = 1;
