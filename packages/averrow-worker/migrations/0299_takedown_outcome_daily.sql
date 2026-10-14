-- 0299 — Observatory Phase B (B2): takedown outcome rollup.
--
-- Additive only. New table + one partial index on takedown_requests; no
-- existing column is dropped, altered or rewritten.
--
-- takedown_outcome_daily
--   One row per (submission day, dimension, key). Written ONLY by
--   lib/takedown-outcome-rollup.ts (runTakedownOutcomeRollup), dispatched
--   from the cube_healer agent's UTC hour-0 tick (the 00:12 cold heal).
--   Rolling 90-day window; rows for days outside the window, or for keys
--   that no longer have data, are deleted by the same writer.
--
--   day          'YYYY-MM-DD' (UTC) of takedown_requests.submitted_at — the
--                submission cohort, not the resolution day.
--   dim          'country' | 'provider'.
--   key          dim='country'  → ISO-2 country of the source threat
--                dim='provider' → hosting_providers.id of the source threat
--                'unknown' when the takedown is not threat-sourced
--                (source_type != 'threat') or the threat lacks the field.
--   submitted    every takedown submitted that day.
--   taken_down / refused / expired   by `resolution` (status fallback for
--                taken_down / expired); pending = status submitted /
--                pending_response. Withdrawn, dispatch-failed (status
--                'failed' with no resolution) and re-opened drafts count in
--                `submitted` only, so the outcome columns need not sum to it.
--   median_hours median (resolved_at − submitted_at) over that cell's
--                taken_down rows; NULL when none.
CREATE TABLE IF NOT EXISTS takedown_outcome_daily (
  day          TEXT    NOT NULL,
  dim          TEXT    NOT NULL CHECK (dim IN ('country', 'provider')),
  key          TEXT    NOT NULL,
  submitted    INTEGER NOT NULL DEFAULT 0,
  taken_down   INTEGER NOT NULL DEFAULT 0,
  refused      INTEGER NOT NULL DEFAULT 0,
  expired      INTEGER NOT NULL DEFAULT 0,
  pending      INTEGER NOT NULL DEFAULT 0,
  median_hours REAL,
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, dim, key)
);

-- Endpoint reads are `WHERE dim = ? AND day >= ?` — (dim, day) makes that a
-- range seek instead of a PK walk over both dims.
CREATE INDEX IF NOT EXISTS idx_takedown_outcome_dim_day
  ON takedown_outcome_daily(dim, day);

-- The writer reads `WHERE submitted_at >= ?` (90-day window). No index on
-- submitted_at existed, so that was a full scan of takedown_requests. Partial
-- on NOT NULL: drafts (never submitted) are most rows and never qualify.
CREATE INDEX IF NOT EXISTS idx_takedown_submitted_at
  ON takedown_requests(submitted_at)
  WHERE submitted_at IS NOT NULL;
