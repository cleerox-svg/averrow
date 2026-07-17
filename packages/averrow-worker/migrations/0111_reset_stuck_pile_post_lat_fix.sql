-- Reset the stuck pile so it can re-enter cartographer's queue.
--
-- Background: before the cartographer.ts fix that pairs with this migration,
-- threats whose ip-api.com response was status='success' but with no lat/lng
-- (ASN-only or empty geo responses — ~93% of "successful" responses per
-- 2026-04-27 cartographer-health snapshot) were stamped with enriched_at.
-- That graduated them out of the queue with lat=NULL, accumulating ~40,865
-- rows that would never be retried.
--
-- The cartographer fix now stamps enriched_at only when geo.lat is set, so
-- new partial-success threats will retry instead of joining this pile. This
-- migration unsticks the existing rows by clearing enriched_at; they re-enter
-- the queue at enrichment_attempts (which is currently 0 across the board
-- since migration 0110 just landed) and get their full 5-attempt budget.
--
-- Safety: only touches active threats with no geo data. Does NOT reset
-- enrichment_attempts — if a row was already partway through its budget
-- via the new code, that progress is preserved. Currently every row is at
-- attempts=0 (migration 0110 just defaulted everything), so this is moot
-- for the first wave but stays correct for any future re-run.
--
-- Before running, verify the count:
--   SELECT COUNT(*) FROM threats
--   WHERE status = 'active' AND enriched_at IS NOT NULL AND lat IS NULL
--     AND ip_address IS NOT NULL AND ip_address != '';
--
-- Expected: ~40,865 (±500). If dramatically different, STOP and investigate.

UPDATE threats
SET enriched_at = NULL
WHERE status = 'active'
  AND enriched_at IS NOT NULL
  AND lat IS NULL
  AND ip_address IS NOT NULL
  AND ip_address != '';
