-- Threat-actor REFERENCE data from the MISP Galaxy threat-actor cluster.
--
-- feeds/actorReference.ts (feed key `actor_reference`) pulls
-- https://raw.githubusercontent.com/MISP/misp-galaxy/main/clusters/threat-actor.json
-- once a day and keeps one row per upstream actor plus its aliases.
-- Licence: MISP Galaxy JSON is dual-licensed CC0 1.0 / BSD-2-Clause; used
-- under CC0 (no obligations; credit shown as a courtesy). Snapshot:
-- docs/licences/misp_galaxy.md.
--
-- Reference data ONLY: nothing reads these tables to name, merge, rename or
-- attribute an actor. threat_actors, threat_attributions and
-- infrastructure_clusters.actor_id are untouched. The single reader is the
-- staff-only threat-actor detail (GET /api/threat-actors/:id -> `reference`,
-- lib/actor-reference.ts lookupActorReference). Wiring it into Attributor is
-- an owner decision.
--
-- actor_reference.id = 'misp:<upstream uuid>' (stable across renames).
-- content_hash = sha256 over every stored field incl. aliases: the feed
-- rewrites a row (and its aliases) only when the hash changes, so an
-- unchanged dataset costs one read and no writes. removed_at is stamped when
-- an actor disappears from a COMPLETE pull and cleared if it comes back.
--
-- actor_reference_aliases: canonical name + upstream synonyms, normalised by
-- normalizeActorName (lib/actor-reference.ts). One alias may belong to
-- several actors (vendor naming collisions); the resolver treats such an
-- alias as ambiguous and resolves it to nothing.
--
-- Additive only: two new tables, their indexes, one feed_configs /
-- feed_status seed.

CREATE TABLE IF NOT EXISTS actor_reference (
  id              TEXT PRIMARY KEY,          -- 'misp:<uuid>'
  source          TEXT NOT NULL,             -- 'misp_galaxy'
  source_uuid     TEXT NOT NULL,
  name            TEXT NOT NULL,
  country_code    TEXT,                      -- ISO 3166-1 alpha-2 (meta.country)
  state_sponsor   TEXT,                      -- meta.cfr-suspected-state-sponsor
  description     TEXT,                      -- capped at 1000 chars
  content_hash    TEXT NOT NULL,
  source_version  TEXT,                      -- galaxy `version` at last write
  first_seen      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  removed_at      TEXT                       -- NULL = present upstream
);

CREATE TABLE IF NOT EXISTS actor_reference_aliases (
  reference_id    TEXT NOT NULL REFERENCES actor_reference(id),
  alias_norm      TEXT NOT NULL,
  alias_original  TEXT NOT NULL,
  position        INTEGER NOT NULL DEFAULT 0, -- 0 = canonical name
  UNIQUE (reference_id, alias_norm)
);

-- Alias -> reference lookup (the resolver's only access path).
CREATE INDEX IF NOT EXISTS idx_actor_reference_aliases_norm
  ON actor_reference_aliases (alias_norm, reference_id);

-- schedule_cron is a poll INTERVAL (parseCronIntervalMs, lib/feedRunner.ts):
-- '0 4 * * *' = every 24h, dispatched from the hourly orchestrator's
-- runAllFeeds. The upstream file changes a few times a month.
INSERT INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('actor_reference', 'MISP Galaxy threat actors',
  'Threat-actor reference list (names, aliases, country, suspected state sponsor) from the MISP Galaxy threat-actor cluster. Reference data only: writes actor_reference, not threats, and never changes actor names or attribution. Source: MISP Project, https://github.com/MISP/misp-galaxy - CC0 1.0.',
  'https://raw.githubusercontent.com/MISP/misp-galaxy/main/clusters/threat-actor.json', 1, '0 4 * * *', 'ingest', 60, 500)
ON CONFLICT(feed_name) DO NOTHING;

INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('actor_reference', 'healthy');
