-- 0325_dmarc_reports_brand_received_index.sql
-- Index for the daily brand threat assessment's DMARC reads
-- (brand-threat-correlator.ts: SUM(total_fail) and the unauthorized-sender
-- count, both `WHERE brand_id = ? AND received_at >= -30d`). Without it each
-- of the ~100 brands assessed per day scans dmarc_reports in full
-- (prod EXPLAIN 2026-11-10: `SCAN dmarc_reports`). The table is empty today,
-- so the build is instant.
--
-- Additive only — CREATE INDEX IF NOT EXISTS.
-- Rollback: DROP INDEX idx_dmarc_reports_brand_received.

CREATE INDEX IF NOT EXISTS idx_dmarc_reports_brand_received
  ON dmarc_reports(brand_id, received_at);
