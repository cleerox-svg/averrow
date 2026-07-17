-- Public + authenticated brand scan results table.
--
-- Same class of bug as scan_leads (PR #843): handlers in
-- handlers/brandScan.ts INSERT/UPDATE/SELECT against brand_scans but
-- no migration ever created it. handlePublicBrandScan was 500'ing on
-- every call (silently behind the generic "internal error" catch)
-- because the INSERT at the end of the scan threw "no such table".
--
-- This is the missing schema, derived from the columns the handlers
-- actually reference:
--   handlePublicBrandScan inserts: id, domain, status, trust_score,
--     spf_policy, dmarc_policy, feed_mentions, scanned_by, timestamps
--   handleBrandScan inserts/updates: + spf_record, dmarc_record,
--     mx_records, lookalikes_found, lookalikes, feed_matches,
--     risk_factors, recommendations, scan_duration_ms
--
-- Status values reflect the lifecycle: 'pending' on insert,
-- 'completed' after results are written, 'failed' if the scan threw.

CREATE TABLE IF NOT EXISTS brand_scans (
  id                TEXT PRIMARY KEY,
  domain            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'completed', 'failed'
  )),
  scanned_by        TEXT NOT NULL DEFAULT 'public',
  trust_score       INTEGER,
  spf_record        TEXT,
  spf_policy        TEXT,
  dmarc_record      TEXT,
  dmarc_policy      TEXT,
  mx_records        TEXT,
  lookalikes_found  INTEGER,
  lookalikes        TEXT,
  feed_mentions     INTEGER,
  feed_matches      TEXT,
  risk_factors      TEXT,
  recommendations   TEXT,
  scan_duration_ms  INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_brand_scans_domain     ON brand_scans(domain);
CREATE INDEX IF NOT EXISTS idx_brand_scans_status     ON brand_scans(status);
CREATE INDEX IF NOT EXISTS idx_brand_scans_created_at ON brand_scans(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_brand_scans_scanned_by ON brand_scans(scanned_by);
