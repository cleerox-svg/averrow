-- 0190_sales_leads_firmographic_snapshot.sql
--
-- Snapshot firmographic + buying-signal data onto sales_leads at the
-- moment a lead is created or enriched. This mirrors how
-- email_security_grade / threat_count_30d are already snapshotted —
-- the lead is a point-in-time record of "what we knew about this
-- brand when we qualified it for outbound", not a live join.
--
-- Why snapshot instead of join-on-read:
--   1. Outbound emails reference these numbers ("you have a B revenue
--      band, 700 employees"). If the underlying firmographic data
--      changes after we sent the email, the lead record should still
--      show what we said.
--   2. List/kanban renders fast — no per-row JOIN.
--   3. Brand-level firmographics is sparse; snapshotting null is
--      cheaper than a left-join that returns null rows.
--
-- Source of truth remains brand_firmographics. enrichLead() in
-- db/sales-leads.ts pulls from brand_firmographics + the Pathfinder
-- AI research JSON, then writes both the snapshot here and (when
-- the AI surfaces something new) back to brand_firmographics.

ALTER TABLE sales_leads ADD COLUMN revenue_band TEXT;
ALTER TABLE sales_leads ADD COLUMN employee_band TEXT;
ALTER TABLE sales_leads ADD COLUMN industry_naics TEXT;
ALTER TABLE sales_leads ADD COLUMN is_public INTEGER;
ALTER TABLE sales_leads ADD COLUMN ticker TEXT;
ALTER TABLE sales_leads ADD COLUMN founded_year INTEGER;
ALTER TABLE sales_leads ADD COLUMN parent_company TEXT;
ALTER TABLE sales_leads ADD COLUMN security_maturity TEXT;
ALTER TABLE sales_leads ADD COLUMN last_breach_disclosed_at TEXT;
ALTER TABLE sales_leads ADD COLUMN security_news_headline TEXT;
ALTER TABLE sales_leads ADD COLUMN security_news_url TEXT;
ALTER TABLE sales_leads ADD COLUMN cyber_10k_mentions INTEGER;

CREATE INDEX IF NOT EXISTS idx_sales_leads_is_public ON sales_leads(is_public);
CREATE INDEX IF NOT EXISTS idx_sales_leads_revenue_band ON sales_leads(revenue_band);
CREATE INDEX IF NOT EXISTS idx_sales_leads_breach_signal
  ON sales_leads(last_breach_disclosed_at)
  WHERE last_breach_disclosed_at IS NOT NULL;
