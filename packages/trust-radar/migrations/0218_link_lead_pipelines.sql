-- Link the two lead pipelines: inbound public scan leads (scan_leads)
-- and outbound Pathfinder-researched prospects (sales_leads). They had
-- no bridge, so a rep viewing one couldn't see the other for the same
-- company. Correlation is by domain (scan_leads.domain ↔
-- sales_leads.company_domain), resolved + cached opportunistically at
-- read time in the lead-detail handlers.
--
-- Additive only (ADD COLUMN) per CLAUDE.md §8 — no existing column is
-- dropped or altered, so this is safe to leave in place on rollback.

ALTER TABLE scan_leads  ADD COLUMN correlated_sales_lead_id TEXT;
ALTER TABLE sales_leads ADD COLUMN correlated_scan_lead_id  TEXT;

CREATE INDEX IF NOT EXISTS idx_scan_leads_correlated_sales
  ON scan_leads(correlated_sales_lead_id);
CREATE INDEX IF NOT EXISTS idx_sales_leads_correlated_scan
  ON sales_leads(correlated_scan_lead_id);
