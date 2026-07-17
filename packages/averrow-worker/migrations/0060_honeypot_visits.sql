-- Honeypot visit tracking — logs crawlers/bots visiting trap pages
CREATE TABLE IF NOT EXISTS honeypot_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page TEXT NOT NULL,
  visitor_ip TEXT,
  user_agent TEXT,
  referer TEXT,
  country TEXT,
  city TEXT,
  asn TEXT,
  is_bot INTEGER DEFAULT 0,
  bot_name TEXT,
  visited_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_hv_page ON honeypot_visits(page);
CREATE INDEX idx_hv_visited ON honeypot_visits(visited_at);
