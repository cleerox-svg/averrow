-- Migration 0216: Index email_security_scans by domain for the lead drill-down.
--
-- The lead drill-down (GET /api/admin/leads/:id) needs the latest email
-- security posture (SPF/DMARC/MX) for a lead's domain. The scans table is
-- only indexed by brand_id (idx_ess_brand), and brand_id there is INTEGER
-- while brands.id is TEXT — so a join is unreliable. Looking up the latest
-- scan by domain is the clean path; this index makes it a bounded indexed
-- read instead of a full-table scan.

CREATE INDEX IF NOT EXISTS idx_ess_domain
  ON email_security_scans(domain, scanned_at DESC);
