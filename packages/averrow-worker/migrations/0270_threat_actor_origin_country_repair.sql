-- 0270_threat_actor_origin_country_repair.sql
-- Data repair only — no schema change.
--
-- threat_actors.country_code is the actor's attributed ORIGIN (ISO-2;
-- see 0063). Two auto-create paths wrote the VICTIM country instead:
--   * OTX feed  (lib/otx-attribution.ts upsertActorFromPulse) used
--     pulse.targeted_countries[0] — full names ("Ukraine", "United States
--     of America"), so Star Blizzard (Russian) rendered as "Ukraine".
--   * news-watcher used extraction.target_countries[0] (ISO-2 victims).
-- Both writers are fixed in the same change; origin now comes only from
-- the canonical registry (originCountryFor). This clears the bad values
-- on rows those two writers created, then backfills the known origins.
-- Reference / manual / nexus rows are untouched.

UPDATE threat_actors
SET country_code = NULL
WHERE source IN ('otx', 'news') AND country_code IS NOT NULL;

-- Mirrors CANONICAL_ORIGIN in lib/otx-attribution.ts (ids via actorIdFor).
UPDATE threat_actors SET country_code = 'RU'
WHERE source IN ('otx', 'news') AND country_code IS NULL
  AND id IN ('ta_apt28', 'ta_apt29', 'ta_turla', 'ta_sandworm', 'ta_star_blizzard');

UPDATE threat_actors SET country_code = 'KP'
WHERE source IN ('otx', 'news') AND country_code IS NULL
  AND id IN ('ta_lazarus_group', 'ta_kimsuky', 'ta_andariel');

UPDATE threat_actors SET country_code = 'CN'
WHERE source IN ('otx', 'news') AND country_code IS NULL
  AND id IN ('ta_apt1', 'ta_apt10', 'ta_apt40', 'ta_apt41', 'ta_mustang_panda');

UPDATE threat_actors SET country_code = 'IR'
WHERE source IN ('otx', 'news') AND country_code IS NULL
  AND id IN ('ta_charming_kitten', 'ta_muddywater', 'ta_apt33', 'ta_oilrig',
             'ta_agrius', 'ta_cyberav3ngers', 'ta_handala', 'ta_hydro_kitten',
             'ta_cotton_sandstorm');
