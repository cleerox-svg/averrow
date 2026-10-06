-- G25 (docs/DISCLOSURE_REGISTER.md): the Brand Exposure Score's look-alike
-- input now counts registered, live look-alikes per brand:
--
--   SELECT COUNT(*) FROM lookalike_domains
--   WHERE brand_id = ? AND registered = 1
--     AND status IN ('monitoring', 'confirmed_threat')
--
-- (lib/lookalike-exposure.ts). It runs once per brand in the daily
-- brand_scores batch (the whole catalog) and on every per-brand recompute.
--
-- Without this index the planner picks the partial idx_lookalike_registered
-- (registered = 1) and walks EVERY registered row in the table for each
-- brand. This partial index makes the count a covering seek on
-- (brand_id, status) over registered rows only.
--
-- Additive only.
CREATE INDEX IF NOT EXISTS idx_lookalike_brand_exposure
  ON lookalike_domains(brand_id, status)
  WHERE registered = 1;

-- Refresh planner stats so the new index is chosen over idx_lookalike_registered
-- (earlier migrations ANALYZEd this table before the index existed).
ANALYZE lookalike_domains;
