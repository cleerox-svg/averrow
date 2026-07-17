-- Phase D: Index cleanup on threats table after analyst D1 CPU fix.
-- See docs/runbooks/analyst-d1-diagnosis.md § "Index usage map (Phase D)" for full audit.
--
-- Dropped indexes and justification:
--
-- idx_threats_status(status):
--   Strict prefix subset of idx_threats_status_created(status, created_at DESC) from migration 0045.
--   Every query filtering on status can use the composite index instead — status is the leading column.
--   Verified: grep across all code paths shows no query filtering on status alone without other
--   conditions that have better dedicated indexes. The composite serves the same seek behavior.
--   Dropping this saves ~one index worth of write overhead on every INSERT/UPDATE to threats (140K+ rows).

DROP INDEX IF EXISTS idx_threats_status;
