-- Phase 4 Step 3: Feed auto-pause on consecutive failures.
--
-- Adds a persistent `consecutive_failures` counter to feed_status
-- and a `paused_reason` metadata channel + optional per-feed
-- threshold override to feed_configs. Introduces a tiny
-- `system_config (key, value)` table so the global default
-- threshold lives somewhere queryable — no existing generic
-- key/value config table exists (`budget_config` is a fixed-shape
-- singleton).
--
-- The dispatch gate stays `enabled = 0`. `paused_reason` is just
-- the why; it does not feed into any query that selects feeds to
-- run. `health_status = 'disabled'` is deliberately left alone —
-- it's still the old enum value the feed_status CHECK allows, and
-- we're not re-plumbing it.
--
-- Backfill notes:
-- * consecutive_failures is computed from feed_pull_history using
--   the same semantics ARCHITECT's data-layer collector used (count
--   of failed pulls since the most recent successful pull, epoch
--   fallback if there was never a success). Feeds that are already
--   deep in the failure pit will land at their true N on first
--   deploy, which is the honest read.
-- * paused_reason is backfilled to 'manual' for every currently
--   disabled feed so the admin UI has something to show next to
--   the "Paused" badge instead of a NULL fall-through.

-- ── feed_status: persistent failure counter ─────────────────
ALTER TABLE feed_status ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

-- Backfill consecutive_failures from feed_pull_history so feeds
-- that are already riding a failure streak don't get a fresh
-- start the moment this lands. Uses the exact same subquery
-- shape ARCHITECT's collectors/data-layer.ts was running on
-- every read before this change.
UPDATE feed_status
SET consecutive_failures = COALESCE(
  (
    SELECT COUNT(*)
      FROM feed_pull_history fph
      WHERE fph.feed_name = feed_status.feed_name
        AND fph.status = 'failed'
        AND fph.started_at > COALESCE(
          (
            SELECT MAX(started_at)
              FROM feed_pull_history
              WHERE feed_name = feed_status.feed_name
                AND status = 'success'
          ),
          '1970-01-01 00:00:00'
        )
  ),
  0
);

-- ── feed_configs: paused metadata + per-feed threshold ──────
ALTER TABLE feed_configs ADD COLUMN paused_reason TEXT;
ALTER TABLE feed_configs ADD COLUMN consecutive_failure_threshold INTEGER;

-- Any feed that is currently disabled at deploy time predates
-- the auto-pause system, so by definition it was paused by a
-- human. Mark them as 'manual' so the UI shows a neutral Paused
-- badge rather than a NULL fall-through.
UPDATE feed_configs
  SET paused_reason = 'manual'
  WHERE enabled = 0 AND paused_reason IS NULL;

-- ── system_config: global key/value store ───────────────────
CREATE TABLE IF NOT EXISTS system_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO system_config (key, value)
  VALUES ('feed_consecutive_failure_threshold', '5');
