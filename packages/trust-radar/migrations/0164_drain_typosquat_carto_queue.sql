-- 0164_drain_typosquat_carto_queue.sql
-- Background: Cartographer was being reaped by Navigator after 105+ min
-- on 2026-05-12 because the per-tick batch (2,500 threats) frequently
-- overshot the per-agent ceiling. ~116 of 169 exhausted items were from
-- the typosquat_scanner feed, which emits hypothetical lookalike domains
-- that almost never have a resolving IP. Companion code change adds
-- `AND source_feed != 'typosquat_scanner'` to the Phase 0 SELECT.
--
-- This migration drains the items already enqueued so they stop being
-- retried and the queue depth falls within a few ticks. Stamps them as
-- exhausted (enrichment_attempts = 5) rather than enriched, so the
-- existing eligibility partial index (idx_threats_carto_phase0)
-- naturally excludes them without altering schema.
--
-- Idempotent. Re-running has no effect once typosquats are drained.

UPDATE threats
   SET enrichment_attempts = 5
 WHERE source_feed = 'typosquat_scanner'
   AND enriched_at IS NULL
   AND enrichment_attempts < 5;
