-- Public scan lead-capture table.
--
-- The /api/leads endpoint (handleLeadCapture) and admin list/update
-- endpoints (handleListLeads, handleUpdateLead) all INSERT/SELECT
-- against scan_leads — but no prior migration created the table.
-- Result: every lead-capture form submission from the homepage scan
-- widget silently 500'd in production.
--
-- This migration creates the table to match the columns the handlers
-- actually reference. Status values match the four states currently
-- used in the UPDATE handler: new, contacted, qualified, converted.
--
-- Distinct from the other lead tables in the platform:
--   - leads (migrations/0004) — assessment-driven, requires assessment_id
--   - sales_leads (migrations/0028) — Pathfinder agent's auto-generated
--                                     prospects, INTEGER id, deeper
--                                     research/outreach columns
--   - scan_leads (this migration) — public-scan email captures, simpler
--                                   shape, what the homepage funnel feeds

CREATE TABLE IF NOT EXISTS scan_leads (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  name          TEXT,
  company       TEXT,
  phone         TEXT,
  domain        TEXT,
  form_type     TEXT NOT NULL DEFAULT 'brand_scan',
  source        TEXT NOT NULL DEFAULT 'public_scan',
  message       TEXT,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new', 'contacted', 'qualified', 'converted', 'closed_lost'
  )),
  notes         TEXT,
  converted_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scan_leads_status     ON scan_leads(status);
CREATE INDEX IF NOT EXISTS idx_scan_leads_email      ON scan_leads(email);
CREATE INDEX IF NOT EXISTS idx_scan_leads_domain     ON scan_leads(domain);
CREATE INDEX IF NOT EXISTS idx_scan_leads_created_at ON scan_leads(created_at DESC);
