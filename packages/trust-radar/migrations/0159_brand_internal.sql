-- 0159_brand_internal.sql
-- STAFF-ONLY brand metadata. Sibling table so the privacy boundary is
-- enforced at the SCHEMA level, not just at the API layer — a future
-- naive `SELECT * FROM brands` for a tenant cannot accidentally pull
-- this in.
--
-- Privacy rules:
--   1. NO endpoint accepting a tenant JWT may JOIN this table or
--      surface its columns. Operator endpoints (`requireStaff`) only.
--   2. The `fit_score` and `sales_notes` are sales-intel data — they
--      describe how good a CUSTOMER this brand would be. Showing this
--      to the brand-as-customer would be reputationally severe (per
--      v3 research finding: "no DRP vendor surfaces operator-visible
--      fit-scoring on a non-customer brand catalog inside the DRP UI"
--      — this is a deliberate differentiator that requires deliberate
--      privacy hygiene).
--   3. Code review discipline: every reference to `brand_internal` in
--      handlers/lib/ must be examined for whether it can leak across
--      the staff/tenant boundary. `grep brand_internal` should return
--      only staff-gated code paths.
--
-- Populated by:
--   - Customer-fit scoring agent (PR3 of Phase 2) — writes fit_score
--     + breakdown
--   - Sales team via Prospects tab UI (PR10) — writes lead_stage,
--     contacted_at, follow_up_at, sales_notes
--
-- The fit_score_band buckets the score into the four review groups
-- the Prospects tab renders (Hot / Warm / Worth-a-look / Long-tail)
-- so we don't bucket on every read.

CREATE TABLE IF NOT EXISTS brand_internal (
  brand_id              TEXT PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE,
  fit_score             INTEGER,                  -- 0-100, customer-fit
  fit_score_band        TEXT
                          CHECK (fit_score_band IS NULL OR fit_score_band IN (
                            'hot', 'warm', 'worth_a_look', 'long_tail'
                          )),
  fit_inputs_json       TEXT,                     -- {"tranco_rank_score":35,"threat_pressure_score":42,"email_grade_score":18,"footprint_depth_score":5,...}
  fit_updated_at        TEXT,
  lead_stage            TEXT
                          CHECK (lead_stage IS NULL OR lead_stage IN (
                            'unqualified','researching','contacted','qualified',
                            'opp','closed_won','closed_lost','not_a_fit'
                          )),
  lead_owner            TEXT,                     -- user_id of sales rep
  contacted_at          TEXT,
  follow_up_at          TEXT,
  sales_notes           TEXT,                     -- free-text, staff-only
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_brand_internal_fit_score  ON brand_internal(fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_brand_internal_fit_band   ON brand_internal(fit_score_band);
CREATE INDEX IF NOT EXISTS idx_brand_internal_lead_stage ON brand_internal(lead_stage);
CREATE INDEX IF NOT EXISTS idx_brand_internal_follow_up  ON brand_internal(follow_up_at);
