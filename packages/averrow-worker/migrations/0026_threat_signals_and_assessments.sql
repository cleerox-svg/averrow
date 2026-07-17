-- Phase 1: threat_signals table for normalized external threat intelligence
CREATE TABLE IF NOT EXISTS threat_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  indicator TEXT NOT NULL,
  indicator_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  details_json TEXT,
  brand_match_id TEXT,
  threat_match_id TEXT,
  first_seen_at TEXT,
  fetched_at TEXT DEFAULT (datetime('now')),
  is_processed INTEGER DEFAULT 0,
  processed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (brand_match_id) REFERENCES brands(id),
  FOREIGN KEY (threat_match_id) REFERENCES threats(id)
);

CREATE INDEX IF NOT EXISTS idx_signals_source ON threat_signals(source);
CREATE INDEX IF NOT EXISTS idx_signals_indicator ON threat_signals(indicator);
CREATE INDEX IF NOT EXISTS idx_signals_brand ON threat_signals(brand_match_id);
CREATE INDEX IF NOT EXISTS idx_signals_type ON threat_signals(signal_type);
CREATE INDEX IF NOT EXISTS idx_signals_severity ON threat_signals(severity);
CREATE INDEX IF NOT EXISTS idx_signals_processed ON threat_signals(is_processed);

-- Phase 3: brand_threat_assessments table for correlation snapshots
CREATE TABLE IF NOT EXISTS brand_threat_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  composite_risk_score REAL NOT NULL,
  risk_level TEXT NOT NULL,
  risk_factors_json TEXT,
  email_security_grade TEXT,
  trap_catches_30d INTEGER DEFAULT 0,
  trap_phishing_catches_30d INTEGER DEFAULT 0,
  ai_phishing_detected INTEGER DEFAULT 0,
  phishtank_active_urls INTEGER DEFAULT 0,
  urlhaus_malware_urls INTEGER DEFAULT 0,
  credential_breaches INTEGER DEFAULT 0,
  dmarc_failures_30d INTEGER DEFAULT 0,
  threat_summary TEXT,
  recommended_actions_json TEXT,
  assessed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (brand_id) REFERENCES brands(id)
);

CREATE INDEX IF NOT EXISTS idx_assessments_brand ON brand_threat_assessments(brand_id);
CREATE INDEX IF NOT EXISTS idx_assessments_risk ON brand_threat_assessments(risk_level);
CREATE INDEX IF NOT EXISTS idx_assessments_date ON brand_threat_assessments(assessed_at);
CREATE INDEX IF NOT EXISTS idx_assessments_score ON brand_threat_assessments(composite_risk_score);
