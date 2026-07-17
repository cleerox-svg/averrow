-- AI-generated threat narratives
CREATE TABLE IF NOT EXISTS threat_narratives (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  title TEXT NOT NULL,
  narrative TEXT NOT NULL,  -- Full AI-generated narrative
  summary TEXT,  -- 2-3 sentence summary
  threat_ids TEXT,  -- JSON array of related threat IDs
  signal_types TEXT,  -- JSON array: ['phishing', 'lookalike', 'impersonation', 'email_degradation']
  severity TEXT DEFAULT 'MEDIUM',
  confidence INTEGER DEFAULT 50,  -- 0-100
  attack_stage TEXT,  -- reconnaissance, weaponization, delivery, exploitation
  recommendations TEXT,  -- JSON array of action items
  status TEXT DEFAULT 'active',  -- active, acknowledged, resolved
  generated_by TEXT DEFAULT 'analyst',  -- analyst, observer
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_narratives_brand ON threat_narratives(brand_id);
CREATE INDEX IF NOT EXISTS idx_narratives_severity ON threat_narratives(severity);
CREATE INDEX IF NOT EXISTS idx_narratives_created ON threat_narratives(created_at);
CREATE INDEX IF NOT EXISTS idx_narratives_status ON threat_narratives(status) WHERE status = 'active';
