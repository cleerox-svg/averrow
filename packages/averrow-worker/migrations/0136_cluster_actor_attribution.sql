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
--
-- Fresh-bootstrap fix: the `infrastructure_clusters` table itself exists in
-- production OUT-OF-BAND — the NEXUS agent (src/agents/nexus.ts) writes it but
-- no migration ever CREATEs it, so this ALTER (the first migration to touch
-- the table) hit "no such table" on a fresh `d1 migrations apply`. Reproduce
-- the authoritative base schema from the agent's INSERT column list so fresh
-- DBs match prod. CREATE TABLE IF NOT EXISTS is a no-op in prod (table already
-- present) and 0136 never re-runs there (D1 tracks migrations by filename).
-- The base deliberately EXCLUDES columns added by later ALTERs: actor_id +
-- attribution_attempted_at (this migration, below), attribution_dismissed_at
-- (0232), component_id (0240), infra_fingerprint/_at + last_movement_pivot_at
-- (0241) — so each of those ADD COLUMNs still succeeds on a fresh DB.
CREATE TABLE IF NOT EXISTS infrastructure_clusters (
  id                   TEXT PRIMARY KEY,
  cluster_name         TEXT,
  asns                 TEXT DEFAULT '[]',   -- JSON array
  countries            TEXT DEFAULT '[]',   -- JSON array
  attack_types         TEXT DEFAULT '[]',   -- JSON array
  brand_ids            TEXT DEFAULT '[]',   -- JSON array
  campaign_ids         TEXT DEFAULT '[]',   -- JSON array
  hosting_provider_ids TEXT DEFAULT '[]',   -- JSON array
  threat_count         INTEGER NOT NULL DEFAULT 0,
  confidence_score     INTEGER,
  first_detected       TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen            TEXT NOT NULL DEFAULT (datetime('now')),
  status               TEXT NOT NULL DEFAULT 'active',
  agent_notes          TEXT
);

CREATE INDEX IF NOT EXISTS idx_clusters_status   ON infrastructure_clusters(status);
CREATE INDEX IF NOT EXISTS idx_clusters_last_seen ON infrastructure_clusters(last_seen DESC);

ALTER TABLE infrastructure_clusters
  ADD COLUMN actor_id TEXT REFERENCES threat_actors(id) ON DELETE SET NULL;

ALTER TABLE infrastructure_clusters
  ADD COLUMN attribution_attempted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_clusters_actor
  ON infrastructure_clusters(actor_id);

CREATE INDEX IF NOT EXISTS idx_clusters_attribution_attempted
  ON infrastructure_clusters(attribution_attempted_at);
