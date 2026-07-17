-- Add attempted_resolve_at to suppress retrying permanently-unresolvable domains.
-- Domains that fail DNS resolution get stamped; the backfill query skips them
-- for 7 days before retrying. Without this, the same ~200 dead domains block
-- the queue every 5-minute tick.

ALTER TABLE threats ADD COLUMN attempted_resolve_at TEXT;

-- Partial index: only rows that still need resolution.
-- Covers the candidate query in dns-backfill.ts efficiently.
CREATE INDEX idx_threats_unresolved_pending
  ON threats(attempted_resolve_at)
  WHERE ip_address IS NULL AND malicious_domain IS NOT NULL;
