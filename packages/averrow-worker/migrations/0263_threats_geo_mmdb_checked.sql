-- GeoLite2 (MMDB) consultation marker on threats.
--
-- Companion to the cartographer Phase 0.5 fix. HISTORICAL CONTEXT
-- BELOW — the behavior described in the next four paragraphs is what
-- this migration REMOVED, not what the code does now. As of commit
-- 0ee677e, Phase 0.5 keys on the `geo_mmdb_checked_at` column added
-- here and never reads or writes `enrichment_attempts`.
--
-- Before this migration, Phase 0.5 had no marker of its own, so it
-- borrowed `threats.enrichment_attempts` as its give-up counter
-- (`enrichment_attempts < 8`, +1 on every miss).
-- That column is ALSO cartographer Phase 0's ip-api budget
-- (`enrichment_attempts < 5`, the predicate baked into the partial
-- index `idx_threats_carto_phase0`). Two pipelines, two caps, one
-- counter — so every MMDB miss silently spent ip-api's retry budget:
--
--   run N   : Phase 0 (ip-api, no answer) +1, Phase 0.5 (MMDB miss) +1
--   run N+2 : row is at ~5, Phase 0 stops selecting it forever
--   run N+5 : row is at 8, Phase 0.5 stops too — terminal, no geo
--
-- The 2026-09-11 attempts histogram shows the signature exactly:
-- buckets 2/3/4 empty (rows transit in ~2 h), 71/38/33 rows in the
-- 5..7 band, and 4,740 rows piled at exactly 8 — the absorbing state
-- of Phase 0.5's cap, not Phase 0's. 65% of that pile is
-- dataplane/scanning, a feed that inserts `malicious_domain = NULL`
-- and can therefore never have passed through the DNS pipeline: those
-- attempts were spent by cartographer on itself.
--
-- Re-asking GeoLite2 was also zero-information by construction: the
-- table refreshes weekly, and lib/geoip-mmdb.ts already KV-caches
-- negative answers for 24 h behind a NULL_SENTINEL. Attempts 2..8
-- against the same IP read the same cached miss and learned nothing,
-- while burning a budget that belongs to a provider (ip-api) whose
-- answers ARE worth retrying.
--
-- END HISTORICAL CONTEXT.
--
-- This marker gives Phase 0.5 its own state, mirroring the
-- `dns_exhausted_at` precedent from migration 0209:
--   NULL     = GeoLite2 not yet consulted for this threat's IP
--   <ts>     = consulted, no usable lat/lng — do not ask again
-- and lets the Phase 0.5 selector drop `enrichment_attempts` entirely,
-- so the geo pipeline stops spending the ip-api pipeline's budget.
--
-- DOWNSTREAM CONSEQUENCE for anyone reading `enrichment_attempts`:
-- with Phase 0.5 no longer incrementing it, Phase 0's `< 5` selector
-- makes 5 the maximum value the GEO pipeline can produce. Values 6/7/8
-- now come only from the DNS pipeline (lib/dns-backfill.ts — the
-- hard-coded `= 8` dead-domain sentinel and the legacy transient
-- increments, both for rows with no ip_address). Any "geo exhausted"
-- metric built on a threshold like `>= 8` is therefore unreachable and
-- frozen; terminality is the conjunction `enrichment_attempts >= 5 AND
-- geo_mmdb_checked_at IS NOT NULL`. That predicate lives in
-- src/lib/geo-exhaustion.ts and is shared by every reporting surface.
--
-- To re-try after a GeoLite2 coverage improvement (e.g. following a
-- geoip_refresh that adds ranges), clear the marker:
--   UPDATE threats SET geo_mmdb_checked_at = NULL WHERE lat IS NULL;
--
-- Safe to apply before the cartographer change: until Phase 0.5 reads
-- it, the column is inert and the index is empty-ish but valid.
ALTER TABLE threats ADD COLUMN geo_mmdb_checked_at TEXT;

-- Partial index serving the new Phase 0.5 selector. Unlike the
-- attempts-based predicate it replaces, this index shrinks
-- monotonically as rows are stamped, so Phase 0.5 stops re-reading the
-- same ~500 rows on every run (relevant at 86.8% of the daily D1 read
-- budget). Column order mirrors idx_threats_carto_phase0.
CREATE INDEX IF NOT EXISTS idx_threats_mmdb_pending
  ON threats(created_at DESC)
  WHERE lat IS NULL
    AND ip_address IS NOT NULL
    AND ip_address != ''
    AND geo_mmdb_checked_at IS NULL;
