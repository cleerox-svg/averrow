-- Migration 0134 — Drop fake/inert seed data from threat_actors,
-- threat_actor_targets, brands, and geopolitical_campaigns.
--
-- Problem
-- The Threat Actors page surfaced data that looked active but was
-- almost entirely hardcoded seed:
--   * 25 actors total — 18 had NULL country_code AND NULL first_seen
--     (orphan rows); 7 IR actors had last_seen ∈ 2014–2023 (the
--     migration 0093 backfill from first_seen).
--   * Narrative descriptions contained fabricated event dates like
--     "Attacked Stryker Corp on March 11, 2026" that read as live
--     intel but were not.
--   * threat_actor_targets carried 25 hardcoded "IRGC Tasnim News
--     Agency targeting list — April 2, 2026 deadline" assertions.
--   * 1 geopolitical campaign ("IRGC Retaliation — Operation Epic
--     Fury Response") was a single static row that the Home Module
--     Hub surfaced as a live campaign card.
--   * brands had ~100 ghosts from migration 0024 (HSBC, Barclays,
--     etc.) seeded with threat_count=0 and never picked up activity.
--
-- This migration nukes the inert/fake portions and clears the cosmetic
-- last_seen + description narrative on the 7 IR reference actors so
-- the UI honestly says "never observed" until real attribution
-- starts populating it.
--
-- What this migration does NOT delete
--   * The 7 reference IR actors themselves — real APT names, real
--     attribution metadata (MOIS / IRGC), real ASNs in
--     threat_actor_infrastructure. They remain as taxonomy.
--   * threat_actor_infrastructure rows — real ASN attribution from
--     OSINT, useful for Sentinel.
--   * Brands that were ever targeted by a threat or are user-monitored.
--   * The 89 source='manual' brands that DO have threat activity
--     (real user-added monitoring).
--
-- Pairs with subsequent phases (B, C, D) that auto-create actors and
-- campaigns from real signals (OTX pulse tags, NEXUS cluster
-- attribution, news/RSS ingest).

-- ─── 1. Drop orphan threat actors (NULL country, NULL first_seen) ─────
-- These were partially-seeded entries that Sentinel can never reach
-- (no country for fallback, no infra ASNs). 18 rows expected.
-- threat_actor_infrastructure and threat_actor_targets have
-- ON DELETE CASCADE on threat_actor_id, so children auto-drop.
DELETE FROM threat_actors
 WHERE country_code IS NULL
   AND first_seen IS NULL;

-- ─── 2. Null misleading last_seen on remaining actors ────────────────
-- The 7 IR actors had last_seen backfilled from first_seen by 0093,
-- producing values like 2014-01-01. The UI rendered "Last seen 12y
-- ago", which read as live intel. Setting NULL flips the UI to
-- "never observed" until Phase B (OTX) writes a real timestamp on
-- the next attributed threat.
UPDATE threat_actors
   SET last_seen = NULL;

-- ─── 3. Strip narrative descriptions with fabricated event dates ─────
-- Migration 0093 wrote descriptions containing fake-looking specific
-- claims ("Attacked Stryker Corp on March 11, 2026"). Phase D
-- (news/RSS ingest) will populate descriptions from real advisories
-- and reports.
UPDATE threat_actors
   SET description = NULL
 WHERE description IS NOT NULL;

-- ─── 4. Drop hardcoded actor → brand targeting assertions ───────────
-- 0093 seeded ~25 rows tagged "IRGC Tasnim News Agency targeting list
-- — April 2, 2026 deadline" — fabricated. Phase C (NEXUS attributor)
-- will rebuild this table from real cluster → actor → target chains.
DELETE FROM threat_actor_targets;

-- ─── 5. Drop the seeded geopolitical campaign ───────────────────────
-- One static row. Phase D (news/RSS ingest) will auto-create real
-- campaigns from current geopolitical reporting.
DELETE FROM geopolitical_campaigns
 WHERE id = 'iran-irgc-2026';

-- ─── 6. Ghost manual brands deferred ───────────────────────────────
-- The original draft of this migration also dropped ~75 inert manual
-- brands (HSBC, Barclays, etc. seeded by 0024 with threat_count=0).
-- That delete tripped a FOREIGN KEY constraint — many tables created
-- after 0024 added non-cascading FKs to brands.id (email_security_*,
-- dmarc_reports, takedown_requests, sales_leads, threat_signals,
-- social_mentions, ...) and at least one of the seeded brands has a
-- row in one of those tables.
--
-- The DELETE is wrapped in a transaction by wrangler, so the FK
-- failure rolled back the entire migration on the first deploy
-- attempt. Splitting brands into its own subsequent migration so
-- this one applies cleanly. That follow-up will enumerate the
-- non-cascading reference tables and exclude any brand referenced
-- by them.
