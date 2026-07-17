-- Phase B: Partial composite index for analyst's unlinked-threat lookup (Query A)
-- See docs/runbooks/analyst-d1-diagnosis.md for EXPLAIN plans and rationale.
--
-- Query A (analyst.ts:64):
--   SELECT id, malicious_url, malicious_domain, source_feed, threat_type
--   FROM threats
--   WHERE target_brand_id IS NULL AND malicious_domain IS NOT NULL
--   ORDER BY created_at DESC LIMIT 30
--
-- Without this index, the planner uses idx_threats_brand_created(target_brand_id, created_at DESC)
-- which finds all NULL-brand rows but requires table lookups to check malicious_domain IS NOT NULL.
-- On 140K rows with ~30K NULL-brand threats, this wastes CPU on every analyst run.
--
-- This partial index contains ONLY rows matching both filter conditions, pre-sorted by created_at DESC.
-- With LIMIT 30, the query reads exactly 30 index entries — zero wasted lookups.

CREATE INDEX IF NOT EXISTS idx_threats_unlinked_recent
  ON threats(created_at DESC)
  WHERE target_brand_id IS NULL AND malicious_domain IS NOT NULL;
