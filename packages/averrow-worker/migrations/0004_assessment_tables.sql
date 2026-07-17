-- Trust Radar v2 — Public Assessment & Lead Tables
-- assessments, leads, assessment_history

-- ─── Assessments ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assessments (
  id                    TEXT PRIMARY KEY,
  domain                TEXT NOT NULL,
  requested_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at          TEXT,
  trust_score           INTEGER,        -- 0-100
  grade                 TEXT CHECK (grade IN ('A', 'B', 'C', 'D', 'F')),
  summary_text          TEXT,           -- brief public-facing summary
  full_report           TEXT,           -- JSON, complete detailed analysis (never exposed publicly)
  domain_health_results TEXT,           -- JSON, DNS/SSL/email auth raw results
  threat_intel_results  TEXT,           -- JSON, threat intelligence overlay from platform D1
  score_breakdown       TEXT,           -- JSON, per-category scores and weights
  ip_address            TEXT,           -- requestor IP for rate limiting
  lead_id               TEXT
);

CREATE INDEX idx_assessments_domain ON assessments(domain);
CREATE INDEX idx_assessments_requested ON assessments(requested_at DESC);
CREATE INDEX idx_assessments_score ON assessments(trust_score);

-- ─── Leads ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id             TEXT PRIMARY KEY,
  assessment_id  TEXT NOT NULL REFERENCES assessments(id),
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  company        TEXT NOT NULL,
  phone          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new', 'contacted', 'qualified', 'proposal_sent', 'converted', 'closed_lost'
  )),
  assigned_to    TEXT REFERENCES users(id),
  notes          TEXT,
  follow_up_at   TEXT
);

CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_assigned ON leads(assigned_to);
CREATE INDEX idx_leads_created ON leads(created_at DESC);
CREATE INDEX idx_leads_assessment ON leads(assessment_id);

-- Add foreign key back-reference from assessments to leads
-- (deferred because leads table didn't exist when assessments was created)

-- ─── Assessment History ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assessment_history (
  domain        TEXT NOT NULL,
  assessment_id TEXT NOT NULL REFERENCES assessments(id),
  trust_score   INTEGER NOT NULL,  -- 0-100
  grade         TEXT NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D', 'F')),
  scanned_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (domain, scanned_at)
);

CREATE INDEX idx_assessment_history_domain ON assessment_history(domain, scanned_at DESC);
