-- Fix idx_threats_vt_pending — reindex on created_at, not first_seen.
--
-- Background: migration 0095 added idx_threats_vt_pending with
-- `ON threats(first_seen DESC)`. EXPLAIN QUERY PLAN on production
-- confirmed SQLite ignored it and used idx_threats_created_brand
-- instead, because the VT production query
-- (src/feeds/virustotal.ts:108-119) filters on created_at, not
-- first_seen:
--
--    WHERE vt_checked = 0
--      AND severity IN ('critical', 'high')
--      AND malicious_domain IS NOT NULL
--      AND malicious_domain != ''
--      AND created_at > datetime('now', '-7 days')        <-- created_at
--    ORDER BY severity_rank, created_at DESC              <-- created_at
--
-- first_seen and created_at are usually close but not identical: the
-- other three enrichment queries (pdns, greynoise, abuseipdb) all
-- filter on first_seen and their partial indexes ARE being used
-- correctly. Only VT diverged.
--
-- Fix: re-index on created_at DESC so the indexed column matches both
-- the WHERE range and the ORDER BY. Queries should now show:
--    SEARCH threats USING INDEX idx_threats_vt_pending (created_at>?)
-- instead of falling through to idx_threats_created_brand.
--
-- Partial predicate unchanged — vt_checked=0 + severity critical/high
-- + malicious_domain IS NOT NULL is still a strict subset of the VT
-- query's WHERE clause.

DROP INDEX IF EXISTS idx_threats_vt_pending;

CREATE INDEX IF NOT EXISTS idx_threats_vt_pending
  ON threats(created_at DESC)
  WHERE vt_checked = 0
    AND severity IN ('critical', 'high')
    AND malicious_domain IS NOT NULL;
