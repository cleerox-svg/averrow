-- Reset stuck enrichment: threats that cartographer marked as enriched
-- but never wrote geo data to (silent failure from unconditional enriched_at stamp).
--
-- Before running, verify the count:
--   SELECT COUNT(*) FROM threats
--   WHERE status = 'active' AND enriched_at IS NOT NULL AND lat IS NULL
--     AND ip_address IS NOT NULL AND ip_address != '';
--
-- Expected: ~16,569 (±500). If dramatically different, STOP and investigate.

UPDATE threats
SET enriched_at = NULL
WHERE status = 'active'
  AND enriched_at IS NOT NULL
  AND lat IS NULL
  AND ip_address IS NOT NULL
  AND ip_address != '';
