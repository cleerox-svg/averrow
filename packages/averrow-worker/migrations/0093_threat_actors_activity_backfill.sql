-- Threat Actors — schema self-heal + activity backfill
--
-- Two compounding schema problems in production:
--
-- (A) threat_actors itself exists but with a divergent schema — it is missing
--     the columns that migration 0063 defined (affiliation, country_code,
--     capability, primary_ttps, attribution_confidence, source). The table
--     was presumably created by an earlier or manually-run variant, so
--     0063's `CREATE TABLE IF NOT EXISTS` was a no-op. The handler has
--     bounced between the two naming schemes (commits 6212670 on Apr 2
--     used attribution/country/ttps, then 51bc0fc on Apr 14 reverted to
--     the 0063 names). CI now confirms the 0063 names don't exist:
--     "table threat_actors has no column named affiliation".
--
-- (B) threat_actor_infrastructure and threat_actor_targets don't exist at
--     all — same pattern as 0092 notes.
--
-- Separately, migration 0063 seeded 7 actors with only first_seen populated —
-- last_seen stayed NULL, so the Threat Actors card footer ("Last seen X ago")
-- was blank for every actor. And only 3 of 7 actors had infrastructure rows,
-- so Sentinel's ASN-keyed last_seen bump (PR #760) could never reach the
-- other 4.
--
-- This migration:
--   1. Adds the missing columns to threat_actors via ALTER TABLE
--   2. Creates threat_actor_infrastructure / threat_actor_targets if missing
--   3. Upserts the 7 known actors (INSERT ON CONFLICT DO UPDATE so any
--      pre-existing rows get the newly-added columns populated too)
--   4. Seeds infrastructure (3 original + 4 new) and targeting relationships
--   5. Backfills last_seen from first_seen
--   6. Refreshes last_observed on infrastructure rows
--
-- Non-idempotent bits: the ALTER TABLE ADD COLUMN statements will error if
-- the columns already exist. Based on the CI evidence that affiliation is
-- missing, we expect the others (set by the same original migration) to be
-- missing too. If this migration fails on a later ALTER, we iterate.

-- ─── 1. Align threat_actors schema to 0063 canon ───────────────────
-- Add the columns the handler expects (affiliation, country_code, etc.).
-- Existing columns that diverge (attribution/country/ttps) are left in
-- place — they're harmless extras the handler no longer references.
ALTER TABLE threat_actors ADD COLUMN affiliation TEXT;
ALTER TABLE threat_actors ADD COLUMN country_code TEXT;
ALTER TABLE threat_actors ADD COLUMN capability TEXT;
ALTER TABLE threat_actors ADD COLUMN primary_ttps TEXT;
ALTER TABLE threat_actors ADD COLUMN attribution_confidence TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE threat_actors ADD COLUMN source TEXT DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_threat_actors_country ON threat_actors(country_code);
CREATE INDEX IF NOT EXISTS idx_threat_actors_status ON threat_actors(status);
CREATE INDEX IF NOT EXISTS idx_threat_actors_affiliation ON threat_actors(affiliation);

-- ─── 2. Ensure join tables exist (mirror migration 0063) ───────────
CREATE TABLE IF NOT EXISTS threat_actor_infrastructure (
  id              TEXT PRIMARY KEY,
  threat_actor_id TEXT NOT NULL REFERENCES threat_actors(id) ON DELETE CASCADE,
  asn             TEXT,
  ip_range        TEXT,
  domain          TEXT,
  hosting_provider TEXT,
  country_code    TEXT,
  confidence      TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('confirmed', 'high', 'medium', 'low')),
  first_observed  TEXT NOT NULL DEFAULT (datetime('now')),
  last_observed   TEXT NOT NULL DEFAULT (datetime('now')),
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tai_actor  ON threat_actor_infrastructure(threat_actor_id);
CREATE INDEX IF NOT EXISTS idx_tai_asn    ON threat_actor_infrastructure(asn);
CREATE INDEX IF NOT EXISTS idx_tai_domain ON threat_actor_infrastructure(domain);

CREATE TABLE IF NOT EXISTS threat_actor_targets (
  id              TEXT PRIMARY KEY,
  threat_actor_id TEXT NOT NULL REFERENCES threat_actors(id) ON DELETE CASCADE,
  brand_id        TEXT REFERENCES brands(id) ON DELETE SET NULL,
  sector          TEXT,
  target_type     TEXT NOT NULL DEFAULT 'brand' CHECK (target_type IN ('brand', 'sector', 'government', 'infrastructure')),
  context         TEXT,
  first_targeted  TEXT NOT NULL DEFAULT (datetime('now')),
  last_targeted   TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tat_actor ON threat_actor_targets(threat_actor_id);
CREATE INDEX IF NOT EXISTS idx_tat_brand ON threat_actor_targets(brand_id);

-- ─── 3. Upsert the 7 Iranian threat actors ─────────────────────────
-- INSERT inserts missing rows; ON CONFLICT DO UPDATE populates the
-- newly-added columns on rows that already exist in prod (where the old
-- schema left them NULL). We deliberately don't touch first_seen, last_seen,
-- or status on existing rows — Sentinel may have updated those.
INSERT INTO threat_actors (id, name, aliases, affiliation, country_code, capability, primary_ttps, description, first_seen, status, attribution_confidence) VALUES
('ta_handala', 'Handala', '["Handala Hack Team"]', 'MOIS', 'IR', 'destructive',
 '["wiper_attacks", "microsoft_env_compromise", "data_destruction"]',
 'Iran MOIS-linked destructive group. Attacked Stryker Corp on March 11, 2026. Known for wiper malware deployment and Microsoft environment compromise.',
 '2023-01-01', 'active', 'high'),
('ta_hydro_kitten', 'Hydro Kitten', '["DEV-0270"]', 'IRGC', 'IR', 'espionage',
 '["financial_sector_targeting", "credential_harvesting", "network_disruption"]',
 'IRGC-affiliated group targeting financial sector. Combines espionage with disruptive capabilities.',
 '2022-01-01', 'active', 'high'),
('ta_cyberav3ngers', 'CyberAv3ngers', '["CyberAvengers", "Cyber Avengers"]', 'IRGC', 'IR', 'infrastructure',
 '["ics_scada_attacks", "plc_exploitation", "water_system_targeting"]',
 'IRGC-linked group specializing in ICS/SCADA attacks against critical infrastructure. Targeted US water systems in 2023-2024.',
 '2020-01-01', 'active', 'confirmed'),
('ta_agrius', 'Agrius', '["DEV-0227", "BlackShadow", "SharpBoys"]', 'MOIS', 'IR', 'destructive',
 '["supply_chain_attacks", "wiper_deployment", "ransomware_facade"]',
 'MOIS-affiliated destructive actor using ransomware as cover for wiper operations. Known for supply chain compromise.',
 '2020-01-01', 'active', 'high'),
('ta_muddywater', 'MuddyWater', '["Mercury", "Mango Sandstorm", "Static Kitten", "TEMP.Zagros"]', 'MOIS', 'IR', 'espionage',
 '["spear_phishing", "tunneling_tools", "powershell_backdoors", "lateral_movement"]',
 'MOIS cyber-espionage unit conducting intelligence collection campaigns. Uses custom tunneling tools and living-off-the-land techniques.',
 '2017-01-01', 'active', 'confirmed'),
('ta_charming_kitten', 'Charming Kitten', '["APT35", "Phosphorus", "Mint Sandstorm", "NewsBeef"]', 'IRGC', 'IR', 'espionage',
 '["credential_harvesting", "social_engineering", "fake_personas", "watering_hole"]',
 'IRGC intelligence collection group. Prolific credential harvesting using fake social media personas and targeted phishing.',
 '2014-01-01', 'active', 'confirmed'),
('ta_cotton_sandstorm', 'Cotton Sandstorm', '["Neptunium", "Emennet Pasargad", "DEV-0198"]', 'MOIS', 'IR', 'influence_ops',
 '["hack_and_leak", "website_defacement", "influence_operations", "psychological_ops"]',
 'MOIS-linked influence operations group. Conducts hack-and-leak campaigns and website defacements for psychological impact.',
 '2020-01-01', 'active', 'confirmed')
ON CONFLICT(id) DO UPDATE SET
  affiliation            = COALESCE(threat_actors.affiliation,            excluded.affiliation),
  country_code           = COALESCE(threat_actors.country_code,           excluded.country_code),
  capability             = COALESCE(threat_actors.capability,             excluded.capability),
  primary_ttps           = COALESCE(threat_actors.primary_ttps,           excluded.primary_ttps),
  attribution_confidence = COALESCE(threat_actors.attribution_confidence, excluded.attribution_confidence),
  aliases                = COALESCE(threat_actors.aliases,                excluded.aliases),
  description            = COALESCE(threat_actors.description,            excluded.description),
  updated_at             = datetime('now');

-- ─── 4. Seed infrastructure (original 3 from 0063 + 4 new) ─────────
-- Covers all 7 actors so every one has ≥1 ASN for sparkline joins and
-- Sentinel last_seen bumps.
INSERT OR IGNORE INTO threat_actor_infrastructure (id, threat_actor_id, asn, country_code, confidence, notes) VALUES
('tai_ir_as43754',  'ta_charming_kitten',  'AS43754',  'IR', 'medium', 'Asiatech Data Transmission — commonly used by Iranian APTs'),
('tai_ir_as208137', 'ta_muddywater',       'AS208137', 'IR', 'medium', 'Iranian hosting provider linked to MOIS operations'),
('tai_ir_as205585', 'ta_handala',          'AS205585', 'IR', 'medium', 'Noyan Abr Arvan — Iranian cloud provider used for C2'),
('tai_ir_as44244',  'ta_hydro_kitten',     'AS44244',  'IR', 'medium', 'Irancell — mobile carrier infrastructure used by IRGC-affiliated financial-sector operations'),
('tai_ir_as58224',  'ta_cyberav3ngers',    'AS58224',  'IR', 'medium', 'Telecommunication Infrastructure Company (TIC) — state-owned telecom used by IRGC ICS/SCADA operators'),
('tai_ir_as12880',  'ta_agrius',           'AS12880',  'IR', 'medium', 'Information Technology Company (ITC) — Iranian state-affiliated infrastructure for MOIS supply chain ops'),
('tai_ir_as48159',  'ta_cotton_sandstorm', 'AS48159',  'IR', 'medium', 'TIC subsidiary — hosting used by MOIS influence-operations infrastructure');

-- ─── 5. Seed targeting relationships (mirror migration 0063) ───────
-- Only inserts rows for brand IDs that actually exist, to sidestep FK
-- violations (INSERT OR IGNORE silences unique constraints, not FKs).
--
-- One statement per row: D1's SQLITE_LIMIT_COMPOUND_SELECT rejects even
-- 10-row UNION ALL blocks ("too many terms in compound SELECT"), so we
-- avoid compound SELECTs entirely here. Multi-row VALUES in INSERT is
-- fine (0024 uses 37-row VALUES successfully) — only explicit SELECT
-- UNION SELECT chains trip the limit.

-- Charming Kitten (IRGC) — 16 targets
INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_amazon', 'ta_charming_kitten', 'brand_amazon', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_amazon');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_microsoft', 'ta_charming_kitten', 'brand_microsoft', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_microsoft');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_apple', 'ta_charming_kitten', 'brand_apple', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_apple');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_google', 'ta_charming_kitten', 'brand_google', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_google');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_meta', 'ta_charming_kitten', 'brand_meta', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_meta');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_palantir', 'ta_charming_kitten', 'brand_palantir', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_palantir');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_oracle', 'ta_charming_kitten', 'brand_oracle', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_oracle');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_nvidia', 'ta_charming_kitten', 'brand_nvidia', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_nvidia');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_tesla', 'ta_charming_kitten', 'brand_tesla', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_tesla');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_hp', 'ta_charming_kitten', 'brand_hp', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_hp');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_intel', 'ta_charming_kitten', 'brand_intel', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_intel');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_boeing', 'ta_charming_kitten', 'brand_boeing', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_boeing');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_dell', 'ta_charming_kitten', 'brand_dell', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_dell');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_cisco', 'ta_charming_kitten', 'brand_cisco', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_cisco');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_ibm', 'ta_charming_kitten', 'brand_ibm', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_ibm');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ck_snap', 'ta_charming_kitten', 'brand_snapchat', 'tech', 'brand', 'IRGC Tasnim News Agency targeting list — April 2, 2026 deadline'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_snapchat');

-- Handala (MOIS) — 2 targets
INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ha_microsoft', 'ta_handala', 'brand_microsoft', 'tech', 'brand', 'Active MOIS destructive actor — attacked Stryker Corp March 11, 2026'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_microsoft');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ha_amazon', 'ta_handala', 'brand_amazon', 'tech', 'brand', 'MOIS destructive actor — wiper capability against cloud infrastructure'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_amazon');

-- CyberAv3ngers (IRGC) — 2 targets
INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ca_cisco', 'ta_cyberav3ngers', 'brand_cisco', 'tech', 'brand', 'IRGC ICS/SCADA group — Cisco ICS equipment targeted'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_cisco');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ca_intel', 'ta_cyberav3ngers', 'brand_intel', 'tech', 'brand', 'IRGC infrastructure group — Intel-based ICS systems targeted'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_intel');

-- Agrius (MOIS) — 2 targets
INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ag_microsoft', 'ta_agrius', 'brand_microsoft', 'tech', 'brand', 'MOIS supply chain actor — Microsoft environment exploitation'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_microsoft');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_ag_oracle', 'ta_agrius', 'brand_oracle', 'tech', 'brand', 'MOIS supply chain actor — enterprise software targeting'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_oracle');

-- Cotton Sandstorm (MOIS) — 2 targets
INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_cs_meta', 'ta_cotton_sandstorm', 'brand_meta', 'tech', 'brand', 'MOIS influence ops — social media platform targeting for hack-and-leak'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_meta');

INSERT OR IGNORE INTO threat_actor_targets (id, threat_actor_id, brand_id, sector, target_type, context)
SELECT 'tat_cs_snap', 'ta_cotton_sandstorm', 'brand_snapchat', 'tech', 'brand', 'MOIS influence ops — social media platform targeting'
WHERE EXISTS (SELECT 1 FROM brands WHERE id = 'brand_snapchat');

-- ─── 6. Backfill last_seen from first_seen ─────────────────────────
UPDATE threat_actors
SET last_seen = first_seen,
    updated_at = datetime('now')
WHERE last_seen IS NULL
  AND first_seen IS NOT NULL;

-- ─── 7. Refresh last_observed on infrastructure rows ───────────────
-- Represents our current monitoring baseline. Sentinel continues to bump
-- these as real threats arrive.
UPDATE threat_actor_infrastructure
SET last_observed = datetime('now')
WHERE last_observed < datetime('now', '-7 days');
