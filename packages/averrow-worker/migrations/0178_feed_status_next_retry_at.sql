-- Per-feed circuit breaker: add `next_retry_at` to feed_status so
-- failing feeds back off with exponential delay + jitter instead of
-- pulling every hour and burning subrequests while the upstream is
-- broken.
--
-- Before PR-K: feed pulled hourly regardless of recent failures.
--   Failure #1 (e.g. taxii_otx HTTP 500) → log, increment counter.
--   Failure #2 → log, increment.
--   …
--   Failure #N (threshold) → autoPauseFeed flips enabled=0 for 4h.
--
-- After PR-K: each failure stamps a next_retry_at into the future,
-- and runAllFeeds skips feeds whose retry window hasn't opened yet.
-- Backoff schedule (with ±25% jitter):
--   Fail #1 →  5 min
--   Fail #2 → 15 min
--   Fail #3 → 45 min
--   Fail #4 →  2 hours  (capped at the hourly cadence boundary)
-- After the auto-pause threshold the existing 4h auto-recovery path
-- still owns recovery.
--
-- On any success (HTTP 200 + parse ok), next_retry_at is cleared so
-- the feed returns to its normal hourly cadence.
--
-- Indexed because runAllFeeds' dispatch query filters on it on every
-- hourly tick; partial index keeps the index small (only rows that
-- currently have a backoff window).

ALTER TABLE feed_status ADD COLUMN next_retry_at TEXT;

CREATE INDEX IF NOT EXISTS idx_feed_status_next_retry
  ON feed_status(next_retry_at)
  WHERE next_retry_at IS NOT NULL;
