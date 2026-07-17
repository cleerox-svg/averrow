-- Phase 2 cube rollout — provider cube for provider analytics and future
-- heuristic-first scoring inputs.
--
-- Narrow by design: only hosting_provider_id (+ threat_type, severity, source_feed
-- and hour bucket) are stored. Name, ASN, and country are NOT denormalized here —
-- queries join hosting_providers at read time so provider metadata stays canonical.
--
-- Refresh is via INSERT OR REPLACE keyed on the full 5-tuple PK, which makes
-- hour-by-hour rebuilds idempotent and re-runnable without cleanup.
--
-- Rows in threats with NULL hosting_provider_id do NOT appear in this cube.
--
-- NOTE: hosting_provider_id is TEXT here (not INTEGER) to match the existing
-- hosting_providers.id TEXT PRIMARY KEY and threats.hosting_provider_id TEXT
-- column types. Changing those upstream would be a separate breaking migration.
--
-- This migration only creates the table + indexes. Population happens via
-- POST /api/admin/cube-backfill. Automatic refresh lands in Phase 3.

CREATE TABLE IF NOT EXISTS threat_cube_provider (
  hour_bucket          TEXT    NOT NULL,
  hosting_provider_id  TEXT    NOT NULL,
  threat_type          TEXT    NOT NULL,
  severity             TEXT    NOT NULL,
  source_feed          TEXT    NOT NULL,
  threat_count         INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (hour_bucket, hosting_provider_id, threat_type, severity, source_feed)
);

CREATE INDEX IF NOT EXISTS idx_cube_provider_hour
  ON threat_cube_provider(hour_bucket DESC);

CREATE INDEX IF NOT EXISTS idx_cube_provider_id_hour
  ON threat_cube_provider(hosting_provider_id, hour_bucket DESC);
