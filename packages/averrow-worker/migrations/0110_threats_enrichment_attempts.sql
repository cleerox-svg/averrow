-- Add enrichment_attempts column to threats table.
--
-- Cartographer's Phase 0 queue (WHERE enriched_at IS NULL AND ip_address ...)
-- pulls 500 threats per batch ORDER BY created_at DESC. ip-api.com returns
-- ~20% successful geo lookups per attempt (the rest are rate-limited 429s,
-- silently skipped via `if (!res.ok) continue;` in enrichIpBatch, or
-- status='fail' for IPs not in ip-api's database). Threats with no geo
-- response keep enriched_at = NULL and recycle to the front of the queue
-- forever, starving older threats and capping cartographer at ~4% of
-- theoretical capacity (1,308/day vs 32,500 possible).
--
-- This adds an attempts counter so threats can exit the queue after N tries.
-- Cap is 5 attempts — at 20% success/attempt, cumulative success is ~67%,
-- which clears most enrichable IPs and lets deterministically-dead IPs
-- (genuinely unknown to ip-api) graduate out of the hot set.
--
-- Existing rows backfill to 0 (full attempt budget on next encounter).
-- Active threats are ~204K, so the default is cheap to apply.

ALTER TABLE threats ADD COLUMN enrichment_attempts INTEGER NOT NULL DEFAULT 0;

-- Reshape idx_threats_carto_phase0 to include the attempts filter inline.
-- As threats reach attempts=5 they fall out of the partial index naturally,
-- so the index stays small and cartographer's SELECT keeps O(LIMIT) cost.

DROP INDEX IF EXISTS idx_threats_carto_phase0;

CREATE INDEX IF NOT EXISTS idx_threats_carto_phase0
  ON threats(created_at DESC)
  WHERE enriched_at IS NULL
    AND ip_address IS NOT NULL
    AND ip_address != ''
    AND enrichment_attempts < 5;
