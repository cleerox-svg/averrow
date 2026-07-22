-- Add verification columns to takedown_requests for periodic domain rescan.
-- Sparrow Phase F checks taken-down domains every 7 days to detect resurrection.
--
-- NOTE: Columns were already added manually via D1 console before this
-- migration ran in CI. Using CREATE TABLE trick to make this idempotent.
--
-- Fresh-bootstrap fix: the "already added manually" columns
-- (last_verified_at, verification_status — the two takedown_requests columns
-- Sparrow Phase F reads/writes, src/agents/sparrow.ts) were never added by any
-- migration, so a fresh `d1 migrations apply` failed here creating the index
-- below on a non-existent column. Add them additively before the index. Both
-- are prod-invisible: 0092 is long-applied in prod (which already has the
-- columns out-of-band) and never re-runs (D1 tracks migrations by filename).
ALTER TABLE takedown_requests ADD COLUMN last_verified_at    TEXT;
ALTER TABLE takedown_requests ADD COLUMN verification_status TEXT;

-- Index for the Phase F rescan query: taken-down domains due for verification
CREATE INDEX IF NOT EXISTS idx_takedown_rescan_pending
  ON takedown_requests(last_verified_at)
  WHERE status = 'taken_down' AND target_type IN ('domain', 'url');
