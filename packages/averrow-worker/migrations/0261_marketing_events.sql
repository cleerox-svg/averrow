-- Marketing page analytics + AI visibility events.
-- Tracks page views + clicks/CTAs on the public marketing site, plus
-- AI-crawler visits (edge-logged) and human arrivals from AI chat
-- services (beacon-logged with server-side referrer classification).
-- Raw IP is never stored — visitor_hash is a salted, truncated SHA-256.
CREATE TABLE IF NOT EXISTS marketing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,          -- 'pageview' | 'click' | 'cta'
  source TEXT NOT NULL,              -- 'edge' | 'beacon'
  page TEXT NOT NULL,
  cta_id TEXT,
  visitor_hash TEXT,
  user_agent TEXT,
  referer TEXT,
  country TEXT,
  city TEXT,
  asn TEXT,
  is_bot INTEGER DEFAULT 0,
  is_ai_crawler INTEGER DEFAULT 0,
  crawler_name TEXT,
  is_ai_referral INTEGER DEFAULT 0,
  ai_source TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_me_type_created ON marketing_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_me_created ON marketing_events(created_at);
CREATE INDEX IF NOT EXISTS idx_me_crawler ON marketing_events(crawler_name);
CREATE INDEX IF NOT EXISTS idx_me_ai_source ON marketing_events(ai_source);
