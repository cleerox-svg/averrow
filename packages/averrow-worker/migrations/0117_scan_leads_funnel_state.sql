-- scan_leads sales-funnel state extensions.
--
-- After PR #843 created the table and PR #844 added the qualified
-- report (token-shareable artifact), the next step in the funnel is
-- (a) sending the prospect the report via templated outreach email,
-- and (b) converting a qualified lead into a tenant organization.
--
-- These columns track those transitions:
--   correlated_brand_id — set on INSERT in handleLeadCapture if a
--     brands.canonical_domain row already exists for the submitted
--     domain. Lets sales see "this prospect is asking about a brand
--     we already monitor" without a JOIN at read time.
--   outreach_sent_at + outreach_email_id — when the templated outreach
--     email was sent (POST /api/admin/leads/:id/outreach). email_id
--     is Resend's message id, useful for delivery troubleshooting.
--   converted_org_id — the organizations.id created when the lead
--     was converted to a tenant (POST /api/admin/leads/:id/convert-
--     to-tenant). Status flips to 'converted' in the same write.
--
-- All four columns nullable so existing rows aren't broken.

ALTER TABLE scan_leads ADD COLUMN correlated_brand_id TEXT;
ALTER TABLE scan_leads ADD COLUMN outreach_sent_at    TEXT;
ALTER TABLE scan_leads ADD COLUMN outreach_email_id   TEXT;
ALTER TABLE scan_leads ADD COLUMN converted_org_id    INTEGER;

CREATE INDEX IF NOT EXISTS idx_scan_leads_correlated_brand ON scan_leads(correlated_brand_id);
CREATE INDEX IF NOT EXISTS idx_scan_leads_converted_org    ON scan_leads(converted_org_id);
