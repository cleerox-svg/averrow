-- Platform Notifications: per-user notifications with preferences
-- Run in D1 Console manually

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'brand_threat', 'campaign_escalation', 'feed_health',
    'intelligence_digest', 'agent_milestone'
  )),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  brand_threat BOOLEAN NOT NULL DEFAULT 1,
  campaign_escalation BOOLEAN NOT NULL DEFAULT 1,
  feed_health BOOLEAN NOT NULL DEFAULT 1,
  intelligence_digest BOOLEAN NOT NULL DEFAULT 1,
  agent_milestone BOOLEAN NOT NULL DEFAULT 1,
  browser_notifications BOOLEAN NOT NULL DEFAULT 0,
  push_notifications BOOLEAN NOT NULL DEFAULT 0
);
