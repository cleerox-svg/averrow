-- 0271_brand_link_cleanup_log.sql
-- Audit + undo log for the one-off brand-link cleanup
-- (lib/brand-link-cleanup.ts, POST /api/internal/brand-links/cleanup).
--
-- Context: the pre-#1727 matcher linked ~700K of ~900K threats to the
-- wrong brand (generic-word brands, JSON IOC blobs, IPs, TLD labels).
-- The cleanup re-validates every existing link against the new rules and
-- either keeps it, relinks it to the brand the new matcher picks, or
-- clears it. Each relink/clear first records the original brand here,
-- so the whole run is reversible:
--
--   UPDATE threats SET target_brand_id = l.old_brand_id
--   FROM brand_link_cleanup_log l WHERE threats.id = l.threat_id;
--
-- threat_id is the PK and rows are INSERT OR IGNORE, so a re-run never
-- overwrites the ORIGINAL pre-cleanup brand.

CREATE TABLE IF NOT EXISTS brand_link_cleanup_log (
  threat_id     TEXT PRIMARY KEY,
  old_brand_id  TEXT NOT NULL,
  new_brand_id  TEXT,
  action        TEXT NOT NULL CHECK (action IN ('relink', 'clear')),
  reason        TEXT NOT NULL,
  new_method    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_brand_link_cleanup_log_old_brand
  ON brand_link_cleanup_log(old_brand_id);
