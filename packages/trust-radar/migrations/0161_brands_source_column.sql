-- 0161_brands_source_column.sql
-- Add brands.source column. Already used in 6+ places in code:
--
--   handlers/admin.ts:1876   INSERT … 'ai_attributed'   (Pathfinder)
--   handlers/admin.ts:2043   INSERT … 'tranco'          (Tranco import)
--   handlers/admin.ts:2056   DELETE … WHERE source = 'tranco' AND ...  (cleanup)
--   handlers/admin.ts:2060   DELETE … WHERE source = 'tranco' AND ...  (cleanup)
--   handlers/admin.ts:2066   DELETE … WHERE source = 'tranco' AND ...  (cleanup)
--   handlers/admin.ts:2187   SELECT COALESCE(source, 'manual'), ...    (audit)
--   migrations/0024_seed_global_brands.sql                              (seed)
--
-- Column was excluded from the 0042 brands rebuild — likely an
-- oversight at the time. The handler INSERTs since then have been
-- silently failing inside the try/catch wrapping handleImportTranco
-- and the AI-attribution path. PR2 fixes that.
--
-- Default NULL (back-compat). Existing rows have unknown origin;
-- the audit handler at 2187 already coalesces to 'manual'.

ALTER TABLE brands ADD COLUMN source TEXT;

CREATE INDEX IF NOT EXISTS idx_brands_source ON brands(source);
