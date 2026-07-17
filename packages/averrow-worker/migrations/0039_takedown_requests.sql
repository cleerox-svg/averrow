-- Takedown request workflow for tenant and SOC use

CREATE TABLE IF NOT EXISTS takedown_requests (
  id TEXT PRIMARY KEY,
  org_id INTEGER REFERENCES organizations(id),  -- NULL for SOC-initiated
  brand_id TEXT NOT NULL REFERENCES brands(id),

  -- What to take down
  target_type TEXT NOT NULL,                     -- domain|social_profile|url|email
  target_value TEXT NOT NULL,                    -- the phishing URL, impersonation handle, etc.
  target_platform TEXT,                          -- twitter, linkedin, etc. (for social)
  target_url TEXT,                               -- direct link to the offending content

  -- Source reference
  source_type TEXT,                              -- alert|social_profile|threat|manual
  source_id TEXT,                                -- ID of the alert/profile/threat that triggered this

  -- Evidence
  evidence_summary TEXT NOT NULL,                -- brief description of the violation
  evidence_detail TEXT,                          -- AI-generated or manually written full evidence
  evidence_urls TEXT,                            -- JSON array of supporting URLs
  screenshot_url TEXT,                           -- R2 link to screenshot (future)

  -- Provider/platform to contact
  provider_name TEXT,                            -- e.g. "Twitter/X", "GoDaddy", "Cloudflare"
  provider_abuse_contact TEXT,                   -- email or URL for abuse reports
  provider_method TEXT DEFAULT 'email',          -- email|form|api

  -- Workflow status
  status TEXT NOT NULL DEFAULT 'draft',
  -- Flow: draft -> requested -> submitted -> pending_response -> taken_down -> failed | expired

  requested_by TEXT REFERENCES users(id),
  requested_at TEXT,

  submitted_by TEXT REFERENCES users(id),        -- SOC analyst who submitted
  submitted_at TEXT,

  response_received_at TEXT,
  response_notes TEXT,

  resolved_at TEXT,
  resolution TEXT,                               -- taken_down|refused|expired|withdrawn

  -- Priority
  severity TEXT DEFAULT 'MEDIUM',
  priority_score INTEGER DEFAULT 50,             -- 0-100, used for SOC queue ordering

  -- Metadata
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_takedown_org ON takedown_requests(org_id);
CREATE INDEX IF NOT EXISTS idx_takedown_brand ON takedown_requests(brand_id);
CREATE INDEX IF NOT EXISTS idx_takedown_status ON takedown_requests(status);
CREATE INDEX IF NOT EXISTS idx_takedown_severity ON takedown_requests(severity) WHERE status NOT IN ('taken_down', 'failed', 'expired');
CREATE INDEX IF NOT EXISTS idx_takedown_created ON takedown_requests(created_at);
