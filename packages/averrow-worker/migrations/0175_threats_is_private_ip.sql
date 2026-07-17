-- Phase 3 D1 spend reduction — PR-D: structural fix for the
-- cartographer Phase 0 selector.
--
-- The 2026-05-12 diagnostic showed query #2 burning 3.45M
-- reads/hour and 14.75k rows examined per call. That's because
-- the cartographer + flight-control + admin + cartographer-health
-- callsites all use PRIVATE_IP_SQL_FILTER — 11 chained
-- `NOT LIKE '10.%'` predicates that the query planner cannot
-- index. Every Phase 0 selector ends up scanning the table
-- and applying the LIKE patterns row-by-row.
--
-- Fix: materialize the private-IP classification at insert time
-- into a `is_private_ip` boolean column. Existing rows are
-- backfilled here. New rows are stamped by feedRunner.insertThreat
-- via `isPrivateIP()` from lib/geoip.ts (slightly stricter — also
-- catches 169.254/16 link-local + 224.0.0.0+ multicast — but the
-- backfill uses the LIKE-equivalent set so existing classifications
-- are unchanged).
--
-- A single partial index on (created_at DESC) WHERE the canonical
-- Phase 0 predicates hold then turns the selector into a small
-- range scan over the index.
--
-- Order of operations matters: add column → backfill → add index.
-- Building the index last means the backfill UPDATE doesn't have
-- to maintain index entries as it rewrites them.

ALTER TABLE threats ADD COLUMN is_private_ip INTEGER NOT NULL DEFAULT 0;

-- Backfill using the exact predicate set from PRIVATE_IP_SQL_FILTER
-- in lib/geoip.ts. Bounded by ip_address IS NOT NULL so the bulk
-- of the table (rows without IPs) skips the LIKE evaluation.
UPDATE threats
   SET is_private_ip = 1
 WHERE ip_address IS NOT NULL
   AND (   ip_address LIKE '10.%'
        OR ip_address LIKE '192.168.%'
        OR ip_address LIKE '172.16.%'
        OR ip_address LIKE '172.17.%'
        OR ip_address LIKE '172.18.%'
        OR ip_address LIKE '172.19.%'
        OR ip_address LIKE '172.2_.%'
        OR ip_address LIKE '172.3_.%'
        OR ip_address LIKE '127.%'
        OR ip_address LIKE '0.%'
        OR ip_address LIKE '100.64.%'
       );

-- Partial index for the cartographer Phase 0 + flight-control
-- backlog selectors. Once the codepaths switch to
-- `is_private_ip = 0`, the planner walks created_at DESC over
-- only the rows that are still candidates for geo enrichment.
CREATE INDEX IF NOT EXISTS idx_threats_phase0_public
  ON threats(created_at DESC)
  WHERE enriched_at IS NULL
    AND is_private_ip = 0
    AND ip_address IS NOT NULL
    AND ip_address != '';
