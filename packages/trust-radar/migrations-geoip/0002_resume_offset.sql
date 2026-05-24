-- Add resume-from-row checkpoint to geo_ip_refresh_log.
--
-- The MaxMind import (runGeoipBlocksImport in lib/geoip-import.ts) was
-- discovered in 2026-05-24 audit to fail ~40% of refreshes — either
-- via Cloudflare WorkflowInternalError (5/5, 5/14) or via Flight
-- Control "stuck >60 min" auto-recovery (5/24). Each failure left
-- the shadow table half-populated, and the next Workflow retry of
-- the `import` step re-streamed the CSV from row 0, re-issuing
-- INSERT OR IGNORE for already-inserted rows.
--
-- last_committed_row tracks how far the loader has progressed within
-- a single refresh run. Updated after every successful batch flush
-- so a retry of the import step can stream-and-skip up to that row,
-- then start writing from there. INSERT OR IGNORE remains the
-- collision safety net.
--
-- shadow_version is the source SHA256 fingerprint corresponding to
-- the data currently in geo_ip_ranges_new. If a retry starts with
-- a different MaxMind version, the prepare-shadow step must drop+
-- recreate the shadow rather than resume (different dataset =
-- mixing rows from two releases).

ALTER TABLE geo_ip_refresh_log ADD COLUMN last_committed_row INTEGER NOT NULL DEFAULT 0;
ALTER TABLE geo_ip_refresh_log ADD COLUMN shadow_version TEXT;
