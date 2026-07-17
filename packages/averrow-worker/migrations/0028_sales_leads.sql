-- Migration 0028: Sales Leads & Lead Activity Log
-- Used by the Prospector agent for sales intelligence pipeline

CREATE TABLE IF NOT EXISTS sales_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  prospect_score REAL NOT NULL,
  score_breakdown_json TEXT,
  status TEXT NOT NULL DEFAULT 'new',

  -- Company research
  company_name TEXT,
  company_domain TEXT,
  company_industry TEXT,
  company_size TEXT,
  company_revenue_range TEXT,
  company_hq TEXT,
  research_json TEXT,
  researched_at TEXT,

  -- Security leader target
  target_name TEXT,
  target_title TEXT,
  target_linkedin TEXT,
  target_email TEXT,

  -- Platform findings snapshot
  email_security_grade TEXT,
  threat_count_30d INTEGER,
  phishing_urls_active INTEGER,
  trap_catches_30d INTEGER,
  composite_risk_score REAL,
  pitch_angle TEXT,
  findings_summary TEXT,

  -- Outreach
  outreach_variant_1 TEXT,
  outreach_variant_2 TEXT,
  outreach_selected TEXT,
  outreach_sent_at TEXT,
  outreach_channel TEXT,

  -- Follow-up tracking
  response_received_at TEXT,
  response_sentiment TEXT,
  meeting_booked_at TEXT,
  follow_up_count INTEGER DEFAULT 0,
  next_follow_up_at TEXT,

  -- Meta
  identified_by TEXT DEFAULT 'pathfinder_agent',
  reviewed_by INTEGER,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (brand_id) REFERENCES brands(id)
);

CREATE INDEX IF NOT EXISTS idx_sales_leads_status ON sales_leads(status);
CREATE INDEX IF NOT EXISTS idx_sales_leads_score ON sales_leads(prospect_score);
CREATE INDEX IF NOT EXISTS idx_sales_leads_brand ON sales_leads(brand_id);
CREATE INDEX IF NOT EXISTS idx_sales_leads_created ON sales_leads(created_at);

CREATE TABLE IF NOT EXISTS lead_activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  activity_type TEXT NOT NULL,
  details_json TEXT,
  performed_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lead_id) REFERENCES sales_leads(id)
);

CREATE INDEX IF NOT EXISTS idx_lead_activity_lead ON lead_activity_log(lead_id);
