-- Add verification columns to takedown_requests for periodic domain rescan.
-- Sparrow Phase F checks taken-down domains every 7 days to detect resurrection.
--
-- NOTE: Columns were already added manually via D1 console before this
-- migration ran in CI. Using CREATE TABLE trick to make this idempotent.

-- Index for the Phase F rescan query: taken-down domains due for verification
CREATE INDEX IF NOT EXISTS idx_takedown_rescan_pending
  ON takedown_requests(last_verified_at)
  WHERE status = 'taken_down' AND target_type IN ('domain', 'url');
