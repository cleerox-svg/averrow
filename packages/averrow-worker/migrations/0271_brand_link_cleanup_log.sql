-- 0271_brand_link_cleanup_log.sql
-- Audit + undo log for the one-off brand-link cleanup
-- (lib/brand-link-cleanup.ts, POST /api/internal/brand-links/cleanup).
--
-- Context: the pre-#1727 matcher linked ~700K of ~900K threats to the
-- wrong brand (generic-word brands, JSON IOC blobs, IPs, TLD labels).
-- The cleanup re-validates every existing link against the new rules and
-- keeps it, relinks it to the brand the new matcher picks, or clears it.
--
-- Each relink/clear records the original brand + match method here, in
-- the same atomic D1 batch as the guarded UPDATE and only when that
-- UPDATE will apply. A row whose undone_at is NULL is a live change.
-- Undo is `mode=undo` on the same endpoint: it restores old_brand_id /
-- old_method only where the threat still holds new_brand_id (links made
-- after the cleanup are never overwritten), then stamps undone_at.
-- A later re-apply overwrites only undone rows, so the ORIGINAL
-- pre-cleanup brand is never lost.

CREATE TABLE IF NOT EXISTS brand_link_cleanup_log (
  threat_id     TEXT PRIMARY KEY,
  old_brand_id  TEXT NOT NULL,
  old_method    TEXT,
  new_brand_id  TEXT,
  new_method    TEXT,
  action        TEXT NOT NULL CHECK (action IN ('relink', 'clear')),
  reason        TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  actor         TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  undone_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_brand_link_cleanup_log_old_brand
  ON brand_link_cleanup_log(old_brand_id);
CREATE INDEX IF NOT EXISTS idx_brand_link_cleanup_log_run
  ON brand_link_cleanup_log(run_id);

-- The cleanup counts threat-sourced alerts per batch; without this every
-- batch full-scans alerts. Also serves any future source lookup.
CREATE INDEX IF NOT EXISTS idx_alerts_source
  ON alerts(source_type, source_id);
