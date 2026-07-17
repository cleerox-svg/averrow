-- Re-shape idx_threats_carto_phase0 so it covers the new ORDER BY created_at DESC.
--
-- Before: index on (id) WHERE enriched_at IS NULL AND ip_address IS NOT NULL ...
--   Worked when the Cartographer queue query had no ORDER BY. With the new
--   ORDER BY created_at DESC, SQLite has to fetch all ~58K candidate rows,
--   look up created_at via rowid for each, and sort them — slow and memory-heavy.
--
-- After: index on (created_at DESC) with the same partial WHERE.
--   The planner walks the index in created_at-DESC order, applies LIMIT 500
--   immediately, and stops. No row-level lookups for sorting.
--
-- The (id) ordering had no semantic value — it was just whatever rowid happened
-- to be, which conveniently put oldest threats first. That's exactly the bug
-- this fix addresses (oldest dead-IP threats spinning at the front of the queue
-- forever, blocking newer threats from ever being reached).

DROP INDEX IF EXISTS idx_threats_carto_phase0;

CREATE INDEX IF NOT EXISTS idx_threats_carto_phase0
  ON threats(created_at DESC)
  WHERE enriched_at IS NULL
    AND ip_address IS NOT NULL
    AND ip_address != '';
