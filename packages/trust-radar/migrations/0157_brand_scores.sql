-- 0157_brand_scores.sql
-- Two distinct composite scores per brand. Per the v3 architecture
-- research, splitting defensive posture from offensive pressure is a
-- platform differentiator — no major DRP vendor (BrandShield, ZeroFox,
-- Bolster, PhishLabs, Recorded Future, Cyberint) publishes a two-axis
-- decomposition. ThreatNG comes closest. Bitsight + SecurityScorecard
-- in the adjacent security-ratings category publish their formulas;
-- we mirror that transparency with a per-brand inputs snapshot.
--
--   brand_health_score   — defensive posture (0-100, higher = better)
--                          inputs: email_security_grade, DMARC enforcement,
--                                  BIMI presence, DNSSEC / CAA / MTA-STS,
--                                  official social verification coverage,
--                                  official app-store presence
--
--   brand_exposure_score — offensive pressure (0-100, higher = worse)
--                          inputs: 30-day threat volume, takedown velocity,
--                                  dark-web mentions, lookalike count,
--                                  typosquat density per CT volume
--
-- Note: brands.exposure_score (from migration 0036) ALREADY EXISTS as
-- a single composite. We're not removing it — the new brand_exposure_score
-- column is the v3-shaped successor with the formal split. Both coexist
-- during the transition and are kept in sync by the scoring agent.
-- New code should read brand_health_score + brand_exposure_score.

ALTER TABLE brands ADD COLUMN brand_health_score INTEGER;
ALTER TABLE brands ADD COLUMN brand_exposure_score INTEGER;
ALTER TABLE brands ADD COLUMN brand_health_grade TEXT;            -- A+ through F (mirrors email_security_grade)
ALTER TABLE brands ADD COLUMN brand_health_updated_at TEXT;
ALTER TABLE brands ADD COLUMN brand_exposure_updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_brands_health_score   ON brands(brand_health_score);
CREATE INDEX IF NOT EXISTS idx_brands_exposure_score ON brands(brand_exposure_score);
CREATE INDEX IF NOT EXISTS idx_brands_health_grade   ON brands(brand_health_grade);

-- ─── Score snapshots ──────────────────────────────────────────────
-- One row per (brand, day). Snapshotted at the daily 00:00 UTC tick
-- (existing daily_snapshots cron path). Lets BrandDetail Risk tab
-- render score sparklines and supports the /brands-v3 Intel tab's
-- "improving brands" surface (week-over-week health delta).
--
-- inputs_json columns capture the formula's contribution components
-- per snapshot day so weight-tuning is auditable and replayable.

CREATE TABLE IF NOT EXISTS brand_score_snapshots (
  brand_id              TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  snapshot_day          TEXT NOT NULL,            -- YYYY-MM-DD
  brand_health_score    INTEGER,
  brand_exposure_score  INTEGER,
  brand_health_grade    TEXT,
  health_inputs_json    TEXT,                     -- {"email_grade":"A","dmarc_enforced":true,"bimi":false,...}
  exposure_inputs_json  TEXT,                     -- {"threats_30d":12,"darkweb_30d":3,"takedowns_open":5,...}
  PRIMARY KEY (brand_id, snapshot_day)
);

CREATE INDEX IF NOT EXISTS idx_brand_score_snapshots_day ON brand_score_snapshots(snapshot_day DESC);
