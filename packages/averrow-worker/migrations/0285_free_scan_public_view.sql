-- Free scan (Section 7, owner-approved 2026-10-05).
--
-- brand_scans.public_view — JSON of the public result shown at
--   /scan/?id=<id> (email grade + SPF/DKIM/DMARC/MX/BIMI facts and the
--   registered-lookalike COUNTS). Written once at scan time so the
--   results link is stable; GET /api/brand-scan/public/:id returns only
--   this (allowlisted on read). NULL on rows written before this
--   migration and on staff scans — those 404 on the public lookup.
-- brand_scans.registered_lookalikes — JSON array of the registered
--   lookalike names found by the scan. Staff/report only; never in a
--   public response.
-- scan_leads.scan_id — the free scan the lead came from (nullable; the
--   brand_scans row is deleted after 90 days, the lead is kept).
-- scan_leads.consent_at — when the visitor ticked the consent box.
--
-- Additive only. brand_scans rows older than 90 days are deleted daily
-- by Navigator (lib/brand-scan-retention.ts) via idx_brand_scans_created_at.

ALTER TABLE brand_scans ADD COLUMN public_view TEXT;
ALTER TABLE brand_scans ADD COLUMN registered_lookalikes TEXT;
ALTER TABLE scan_leads ADD COLUMN scan_id TEXT;
ALTER TABLE scan_leads ADD COLUMN consent_at TEXT;
