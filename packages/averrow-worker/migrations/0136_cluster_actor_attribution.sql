-- Migration 0136 — Cluster → threat actor attribution columns.
--
-- Phase C of the Threat Actors rebuild. Adds two columns to
-- infrastructure_clusters so the new attributor agent can:
--   1. Persist the cluster → actor mapping after a successful Haiku
--      classification, so subsequent runs don't re-pay the AI cost
--      to reclassify the same cluster.
--   2. Throttle retries for clusters Haiku could not classify
--      ("unknown") via attribution_attempted_at — the agent skips
--      any cluster it tried in the last 7 days and didn't resolve.
--
-- The attribution_attempted_at column is also useful for diagnostics:
-- "how many clusters has the attributor processed today / how many
-- are still pending classification".
--
-- threat_attributions (migration 0135) remains the source of truth
-- for which threats are linked to which actor. This column on
-- infrastructure_clusters is just a cache of the cluster-level
-- decision so we don't re-call Haiku.

ALTER TABLE infrastructure_clusters
  ADD COLUMN actor_id TEXT REFERENCES threat_actors(id) ON DELETE SET NULL;

ALTER TABLE infrastructure_clusters
  ADD COLUMN attribution_attempted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_clusters_actor
  ON infrastructure_clusters(actor_id);

CREATE INDEX IF NOT EXISTS idx_clusters_attribution_attempted
  ON infrastructure_clusters(attribution_attempted_at);
