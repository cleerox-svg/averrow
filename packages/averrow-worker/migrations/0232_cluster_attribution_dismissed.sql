-- Attribution backlog: human dismiss marker.
--
-- The backlog queue (/admin/agents/attribution-backlog) surfaces
-- infrastructure_clusters with actor_id IS NULL. Some of those are
-- genuinely unattributable (commodity kit shared by many operators,
-- burner infrastructure) — a human reviews them and wants them OFF
-- the queue without inventing a fake actor. attribution_dismissed_at
-- records that decision; the backlog list and its "unattributed"
-- totals exclude dismissed rows. Distinct from
-- attribution_attempted_at, which marks an AI attempt that returned
-- "unknown" (those stay in the queue for human review).
ALTER TABLE infrastructure_clusters
  ADD COLUMN attribution_dismissed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_clusters_attribution_dismissed
  ON infrastructure_clusters(attribution_dismissed_at);
