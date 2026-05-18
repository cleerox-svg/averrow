-- 0200_drop_threats_dns_indexes.sql
--
-- PR-4 cleanup of the DNS-queue split.
--
-- After PR-3 flipped dns-backfill's reads to dns_queue and PR-4
-- removed the threats-side dual-writes, the threats-side DNS
-- indexes are dead weight:
--
--   - idx_threats_dns_pending_strict  (migration 0195): partial
--     index keyed by malicious_domain WHERE ip_address IS NULL
--     AND status='active' AND attempts < 8. The reconciler no
--     longer filters on attempts < 8 (state lives in dns_queue
--     now), so the partial predicate isn't satisfied by current
--     SELECTs. The admin endpoint's totalPending preflight query
--     also moved to dns_queue.
--
--   - idx_threats_dns_backfill (migration 0099): the legacy
--     partial index keyed by malicious_domain WHERE ip_address
--     IS NULL OR ''. The dns-backfill's threats SELECT was its
--     only consumer; PR-3 retired that read path.
--
--   - idx_threats_dns_backfill_select (migration 0100): the
--     covering variant of the above with attempted_resolve_at
--     as the secondary column. Same story — read path retired.
--
-- Dropping these saves:
--   1. Write amplification on threats INSERTs (~150K threats added
--      per day each touch ~3 partial-index branches)
--   2. Index storage in the threats table page
--   3. Planner stat overhead (ANALYZE has to maintain stats for
--      each index)
--
-- Reversal: if PR-4 needs to be rolled back, re-creating these
-- indexes is a one-step `CREATE INDEX ... ON threats(...)` per
-- index using the original migration files (0099, 0100, 0195) as
-- references. The threats column data (`enrichment_attempts`,
-- `attempted_resolve_at`) is preserved — we just stopped writing
-- new values to those columns in PR-4. Old data stays correct as
-- a forensic record up to the PR-4 deploy time.

DROP INDEX IF EXISTS idx_threats_dns_pending_strict;
DROP INDEX IF EXISTS idx_threats_dns_backfill;
DROP INDEX IF EXISTS idx_threats_dns_backfill_select;

-- ANALYZE so the planner stops carrying stale stats for the
-- dropped indexes and picks new plans for any residual queries
-- that hit threats.malicious_domain.
ANALYZE threats;
