-- Migration 0135 — threat_attributions: links threats to threat_actors
-- with provenance (source, confidence, when observed).
--
-- Phase B of the Threat Actors rebuild. The first writer is the OTX
-- AlienVault feed: each OTX pulse may carry an `adversary` field or
-- well-known APT tags (apt28, lazarus, charming-kitten, etc.) that
-- name the threat actor responsible for the indicators in the pulse.
-- We persist that link here so the Threat Actors page can show "who
-- attacked whom, when, via what" instead of static seed data.
--
-- Subsequent phases write to the same table:
--   * Phase C (NEXUS attributor) writes source='nexus' attributions
--     when a cluster's TTP fingerprint matches a known actor profile.
--   * Phase D (news/RSS ingest) writes source='news' attributions
--     when a CISA / Mandiant / CrowdStrike advisory names an actor.
--
-- Source-of-truth columns:
--   * threat_id        — FK to the threat row
--   * actor_id         — FK to threat_actors (NULL = unresolved mention)
--   * source           — 'otx' | 'nexus' | 'manual' | 'news'
--   * confidence       — 'confirmed' | 'high' | 'medium' | 'low'
--   * source_pulse_id  — OTX pulse UUID (or other source's record id)
--   * source_pulse_name — human-readable label of the source record
--   * actor_name_raw   — original actor string from source, before
--                        canonicalization. Useful for forensics when
--                        we change ALIAS_TO_CANONICAL mappings later.
--   * observed_at      — when we made the attribution
--   * metadata         — JSON blob: tags, attack_ids, targeted_countries,
--                        industries — kept loose so we can refine the
--                        schema later without another migration.

CREATE TABLE IF NOT EXISTS threat_attributions (
  id                 TEXT PRIMARY KEY,
  threat_id          TEXT NOT NULL REFERENCES threats(id) ON DELETE CASCADE,
  actor_id           TEXT REFERENCES threat_actors(id) ON DELETE SET NULL,
  source             TEXT NOT NULL
                        CHECK (source IN ('otx', 'nexus', 'manual', 'news')),
  source_pulse_id    TEXT,
  source_pulse_name  TEXT,
  actor_name_raw     TEXT,
  confidence         TEXT NOT NULL DEFAULT 'medium'
                        CHECK (confidence IN ('confirmed', 'high', 'medium', 'low')),
  observed_at        TEXT NOT NULL DEFAULT (datetime('now')),
  metadata           TEXT
);

-- Per-threat lookup (e.g. "show all attribution rows for threat X")
CREATE INDEX IF NOT EXISTS idx_attribution_threat
  ON threat_attributions(threat_id);

-- Per-actor recent activity timeline ("show this actor's most recent
-- attributions sorted by when we observed them")
CREATE INDEX IF NOT EXISTS idx_attribution_actor
  ON threat_attributions(actor_id, observed_at DESC);

-- Per-source backfill / debug ("how many OTX attributions in last 24h")
CREATE INDEX IF NOT EXISTS idx_attribution_source
  ON threat_attributions(source, observed_at DESC);

-- Per-pulse lookup (for OTX dedup — same pulse can fan out to many threats)
CREATE INDEX IF NOT EXISTS idx_attribution_pulse
  ON threat_attributions(source_pulse_id);
