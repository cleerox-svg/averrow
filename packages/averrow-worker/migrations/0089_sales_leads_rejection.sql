-- Migration 0089: Add rejection_reason to sales_leads
-- Pathfinder post-enrichment rejection gates store the reason a lead
-- was rejected (enterprise_too_large, service_provider, excluded_industry)
-- so rejected leads are auditable and the funnel is transparent.

ALTER TABLE sales_leads ADD COLUMN rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_sales_leads_rejection ON sales_leads(status, rejection_reason)
  WHERE status = 'rejected';
