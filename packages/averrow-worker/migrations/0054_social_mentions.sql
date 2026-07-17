-- Migration 0054: Social mentions table for cross-platform brand mention tracking
-- Used by Reddit, GitHub, Telegram, Mastodon feeds + Watchdog agent classification

CREATE TABLE IF NOT EXISTS social_mentions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,              -- 'reddit', 'telegram', 'github', 'mastodon'
  source_feed TEXT NOT NULL,           -- feed_name for tracking

  -- Content
  content_type TEXT NOT NULL,          -- 'post', 'comment', 'repo', 'commit', 'channel_message', 'toot'
  content_url TEXT,                    -- direct link to the content
  content_text TEXT,                   -- the actual text/title (first 2000 chars)
  content_author TEXT,                 -- username/handle of poster
  content_author_url TEXT,             -- link to author profile
  content_created TEXT,                -- when the content was posted

  -- Brand matching
  brand_id TEXT REFERENCES brands(id), -- matched brand (NULL if unmatched)
  brand_name TEXT,                     -- brand name that matched
  match_type TEXT,                     -- 'keyword', 'domain', 'handle', 'executive', 'phishing_url', 'code_leak'
  match_confidence REAL DEFAULT 0,     -- 0-100 confidence of brand match

  -- Classification (filled by Watchdog agent)
  threat_type TEXT,                    -- 'impersonation', 'credential_leak', 'phishing_link',
                                       -- 'brand_abuse', 'code_leak', 'threat_actor_chatter',
                                       -- 'vulnerability_disclosure', 'benign'
  severity TEXT DEFAULT 'low',         -- critical/high/medium/low
  ai_assessment TEXT,                  -- Haiku classification result
  ai_confidence REAL,                  -- AI confidence score

  -- Status
  status TEXT DEFAULT 'new',           -- 'new', 'classified', 'escalated', 'resolved', 'false_positive'
  escalated_to_threat_id TEXT,         -- if escalated, links to threats table
  reviewed_by TEXT,
  reviewed_at TEXT,

  -- Metadata
  platform_metadata TEXT,              -- JSON: subreddit, channel_name, repo_name, etc.
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_social_mentions_brand ON social_mentions(brand_id);
CREATE INDEX IF NOT EXISTS idx_social_mentions_platform ON social_mentions(platform, created_at);
CREATE INDEX IF NOT EXISTS idx_social_mentions_status ON social_mentions(status);
CREATE INDEX IF NOT EXISTS idx_social_mentions_severity ON social_mentions(severity);

-- Register Reddit feed
INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('reddit', 'Reddit Social Monitor',
  'Monitors Reddit for brand mentions, phishing reports, credential leaks, and threat actor discussions across cybersecurity subreddits.',
  'https://oauth.reddit.com/', 1, '0 */2 * * *', 'social', 100, 10);

-- Register GitHub feed
INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('github', 'GitHub Code & Leak Monitor',
  'Scans GitHub for leaked credentials, API keys, configuration files, and security advisories mentioning monitored brands.',
  'https://api.github.com/', 1, '0 */4 * * *', 'social', 30, 10);

-- Ensure feed_status rows exist
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('reddit', 'healthy');
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('github', 'healthy');
