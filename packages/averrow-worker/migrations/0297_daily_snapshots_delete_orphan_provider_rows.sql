-- Migration 0297: delete orphaned provider snapshots with no mappable owner
--
-- Follow-up to 0294 / 0296. Prod held 34,875 daily_snapshots provider rows
-- (2026-03-14 … 2026-04-22) whose entity_id matches no hosting_providers
-- row. They are keyed by legacy id forms from before the hp_AS<N>
-- convention — name-derived ('hp_03ai_ltd', ~25.4K rows / 2,602 ids) and
-- UUIDs (~9.4K rows / 1,233 ids) — whose provider rows were deleted long
-- ago. Unlike the spaced 'hp_AS<N> <name>' rows merged by 0296 they carry
-- no ASN. A normalised-name match would map ~19.2K rows (2,042 ids) to
-- exactly one current provider (~3.1K rows ambiguous, ~12.5K incl. all
-- UUIDs unmatched), but nothing reads provider history older than
-- yesterday (src readers only touch today's / yesterday's rows), so the
-- owner chose on 2026-10-14 to delete all of them rather than merge by a
-- name heuristic.
--
-- Prod audit 2026-10-14 (read-only): the predicate below matches exactly
-- 34,875 rows; 0 orphaned provider rows exist on or after 2026-05-01.
-- The date bound keeps this one-off from ever removing history for a
-- provider deleted in future. Brand rows are untouched.
--
-- Idempotent (a second run deletes nothing). No BEGIN/COMMIT (D1 runner).

DELETE FROM daily_snapshots
WHERE entity_type = 'provider'
  AND date < '2026-05-01'
  AND NOT EXISTS (
    SELECT 1 FROM hosting_providers h WHERE h.id = daily_snapshots.entity_id
  );
