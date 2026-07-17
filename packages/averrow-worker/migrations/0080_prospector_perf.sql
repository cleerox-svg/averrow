-- Fix prospector D1 CPU timeout: enable index lookups for latest email scan per brand
CREATE INDEX IF NOT EXISTS idx_ess_brand_scanned
  ON email_security_scans(brand_id, scanned_at DESC);
