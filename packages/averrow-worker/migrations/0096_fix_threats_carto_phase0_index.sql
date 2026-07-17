-- Fix idx_threats_carto_phase0 — remove status='active' from partial index WHERE.
--
-- Background: migration 0095 added idx_threats_carto_phase0 with a partial
-- predicate that included `AND status = 'active'`. But the Cartographer
-- Phase 0 query (src/agents/cartographer.ts:148) and the domain-geo
-- backfill query (src/lib/geoip.ts:262) do NOT filter on status. A partial
-- index is only usable when the query's WHERE clause is implied by the
-- index's WHERE — ours is stricter than the queries, so SQLite refuses
-- to use it (using it would miss rows with status != 'active' that
-- match the other predicates).
--
-- Result: Cartographer was falling through to idx_threats_ip and scanning
-- ~157K IP-bearing rows to find the ~58K unenriched ones. Removing the
-- status predicate makes this index match the actual queries, which drops
-- the candidate scan from ~157K rows to ~58K.
--
-- Keeping the (id) leading column unchanged: the production query has no
-- ORDER BY, so the planner just needs a predicate-filtered rowset; (id)
-- is fine and matches the existing migration-0095 shape so the audit
-- trail in 0086 stays accurate.

DROP INDEX IF EXISTS idx_threats_carto_phase0;

CREATE INDEX IF NOT EXISTS idx_threats_carto_phase0
  ON threats(id)
  WHERE enriched_at IS NULL
    AND ip_address IS NOT NULL
    AND ip_address != '';
