-- Unified alerts pipeline for brand threat notifications
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  -- Types: social_impersonation, phishing_detected, email_grade_change,
  --        lookalike_domain_active, ct_certificate_issued, threat_feed_match
  severity TEXT NOT NULL DEFAULT 'MEDIUM',
  -- Levels: LOW, MEDIUM, HIGH, CRITICAL
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT,
  source_type TEXT,
  source_id TEXT,
  ai_assessment TEXT,
  ai_recommendations TEXT,
  status TEXT DEFAULT 'new',
  -- Flow: new → acknowledged → investigating → resolved | false_positive
  acknowledged_at TEXT,
  resolved_at TEXT,
  resolution_notes TEXT,
  email_sent INTEGER DEFAULT 0,
  webhook_sent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alerts_user_status ON alerts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_brand ON alerts(brand_id);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity) WHERE status = 'new';
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
