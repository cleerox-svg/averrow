-- Migration: 0257_phishing_pattern_signals_phase1.sql
--
-- Schema for the AI-phishing phase-1 deterministic measurement writer
-- (W1.x). Spec: W1.0 phase-1 measurement spec §7 (campaign grouping key /
-- storage) + §8 (campaign-grain rollup table). Doctrine mandate:
-- docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md §3.2 + §6 item 2 —
-- "deterministic first (normalize -> SimHash/MinHash -> template_hash +
-- lexical-variance stats per campaign, pure SQL + code, zero AI spend)".
--
-- ADDITIVE ONLY (CLAUDE.md §8): no DROP, no ALTER of any existing column.
-- Columns are added via ADD COLUMN; tables/indexes via IF NOT EXISTS.
--
-- ------------------------------------------------------------------
-- 1. UNIQUE index on phishing_pattern_signals(capture_id)
-- ------------------------------------------------------------------
-- The per-capture writer is idempotent: one signals row per capture,
-- upserted via `INSERT ... ON CONFLICT(capture_id) DO UPDATE` so a
-- re-run over the same captures is a byte-identical no-op (spec §11)
-- and satisfies the CLAUDE.md §8 ban on SELECT-then-INSERT.
--
-- ON CONFLICT(capture_id) needs a UNIQUE index on capture_id; the
-- existing idx_pattern_capture (migration 0023) is non-unique and does
-- not qualify. Promoting to a UNIQUE index is safe because the table
-- has NEVER been written — dormant since 0023 created it, verified
-- against src/ (no INSERT into phishing_pattern_signals exists yet).
-- With zero rows there are no duplicate capture_ids to collide with.
-- The old non-unique index is left in place (additive rule; dropping it
-- would be a column/index alter and the unique index supersedes it for
-- planning anyway).

CREATE UNIQUE INDEX IF NOT EXISTS idx_pattern_capture_uniq
  ON phishing_pattern_signals(capture_id);

-- ------------------------------------------------------------------
-- 2. Index on phishing_pattern_signals(template_hash)
-- ------------------------------------------------------------------
-- The campaign rollup (spec §8) and template_detected re-stamp (§3.6)
-- group and self-join members by template_hash within a campaign
-- group. Rows below the 12-token shingle floor carry template_hash
-- NULL and drop out of the partial index, so it only carries the
-- hashed (comparable) subset — the exact set the rollup scans.

CREATE INDEX IF NOT EXISTS idx_pattern_template_hash
  ON phishing_pattern_signals(template_hash)
  WHERE template_hash IS NOT NULL;

-- ------------------------------------------------------------------
-- 3. Campaign key storage on phishing_pattern_signals (spec §7.3)
-- ------------------------------------------------------------------
-- The tumbling-window campaign grouping key (spec §7.2) and its kind
-- discriminator are stored per signals row, NOT on spam_trap_captures.
-- Spec §7.3 is explicit: the key lives here, and spam_trap_captures.
-- campaign_id must NOT be written with synthetic b:/i:/d: keys (it
-- reads as a campaigns.id FK and would poison every consumer). §10's
-- writer contract lists both columns as new phishing_pattern_signals
-- columns.
--   campaign_key       e.g. 'c:<campaign_id>|<bucket>',
--                           'b:<brand_id>|<regdomain>|<bucket>',
--                           'i:<sending_ip>|<bucket>',
--                           'd:<regdomain>|<bucket>'; NULL when no rule
--                           applies (row still written, joins no rollup).
--   campaign_key_kind  'campaign' | 'brand_domain' | 'sending_ip' |
--                           'from_domain'; NULL alongside a NULL key.

ALTER TABLE phishing_pattern_signals ADD COLUMN campaign_key TEXT;
ALTER TABLE phishing_pattern_signals ADD COLUMN campaign_key_kind TEXT;

-- Partial index: only rows that participate in a rollup carry a key,
-- so index only the non-NULL set the rollup's GROUP BY campaign_key
-- scans.
CREATE INDEX IF NOT EXISTS idx_pattern_campaign_key
  ON phishing_pattern_signals(campaign_key)
  WHERE campaign_key IS NOT NULL;

-- ------------------------------------------------------------------
-- 4. Campaign-grain rollup table (spec §8.1)
-- ------------------------------------------------------------------
-- One row per (campaign_key) — the key body already embeds the UTC
-- day bucket (spec §7.2), so UNIQUE(campaign_key) IS the (key, window)
-- grain. Written by the rollup pass (spec §8.6); descriptive lexical +
-- infrastructure + time statistics only.
--
-- HARD PROHIBITION (spec §0.2 rule 1, §8.1): this table has NO
-- ai_generated_probability / ai_score / ai_likelihood column, and no
-- phase-1 statistic may be arithmetically converted into one. Adding
-- such a column is a spec violation, not an enhancement. A per-message
-- perplexity/fluency-shaped AI-likelihood score is functionally a
-- non-native-English-speaker detector (Liang et al. 2023, Patterns);
-- Averrow will not ship one nor launder one through a column name.
--
-- polymorphism_regime interpretation (spec §8.5) — these labels
-- describe LEXICAL STRUCTURE ONLY, computed from SimHash distances over
-- slotted word 4-grams. They are not verdicts, not confidence scores,
-- and above all not an AI-generation estimate:
--   kit_reuse     — most member pairs are near-duplicates: one template
--                   sent repeatedly. Evidence AGAINST a polymorphic-
--                   generation hypothesis, not for one.
--   mail_merge    — partial near-duplication: fixed skeleton, variable
--                   slots. Co-occurs with low distinct_subject_hashes /
--                   high largest_template_share.
--   high_variance — few/no near-duplicate pairs, mean pairwise distance
--                   approaching the random-text null model (E=32 bits,
--                   sd=4 for unrelated 64-bit SimHashes). NOT evidence of
--                   AI generation: the discriminating combination is low
--                   lexical similarity + HIGH SEMANTIC similarity + shared
--                   infra + tight time window, and the SEMANTIC leg is
--                   UNMEASURED in phase 1 (no embeddings, no model).
--                   Equally consistent with unrelated senders bucketed by
--                   a coarse sending_ip/from_domain fallback key. Treat as
--                   a queue for investigation, never an attribute. No
--                   customer-facing surface may render it as
--                   "AI-generated" / "AI-polymorphic" in phase 1.
--   mixed         — low near-duplicate rate but mean distance well below
--                   the null model: shared structure without enough
--                   shared 4-grams to cross the near-duplicate threshold.
--   insufficient  — hashed_member_count < 2; pairwise columns NULL.

CREATE TABLE IF NOT EXISTS campaign_pattern_stats (
  id                        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  campaign_key              TEXT NOT NULL,
  campaign_key_kind         TEXT NOT NULL,   -- campaign|brand_domain|sending_ip|from_domain
  window_bucket             TEXT NOT NULL,   -- 'YYYY-MM-DD' UTC
  window_start              TEXT,            -- MIN(captured_at) of members
  window_end                TEXT,            -- MAX(captured_at) of members
  time_window_seconds       INTEGER,         -- window_end - window_start

  member_count              INTEGER NOT NULL,
  hashed_member_count       INTEGER NOT NULL, -- members with non-NULL template_hash
  stats_member_count        INTEGER NOT NULL, -- members with non-NULL vocabulary_complexity

  distinct_template_hashes  INTEGER,
  distinct_template_ratio   REAL,            -- distinct / hashed_member_count
  largest_template_share    REAL,            -- largest exact-hash group / hashed_member_count
  mean_pairwise_hamming     REAL,
  sd_pairwise_hamming       REAL,
  near_dup_pair_rate        REAL,            -- pairs with distance <= 3 / total pairs
  pairwise_sample_size      INTEGER,         -- members actually used (<= 60)

  distinct_sending_ips      INTEGER,
  distinct_from_domains     INTEGER,
  distinct_asns             INTEGER,
  distinct_mail_fingerprints INTEGER,
  distinct_subject_hashes   INTEGER,

  mean_vocabulary_complexity     REAL,
  mean_sentence_structure_variance REAL,
  mean_fluency_score             REAL,

  polymorphism_regime       TEXT,            -- kit_reuse|mail_merge|mixed|high_variance|insufficient
  computed_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cps_key ON campaign_pattern_stats(campaign_key);
CREATE INDEX IF NOT EXISTS idx_cps_bucket ON campaign_pattern_stats(window_bucket);
CREATE INDEX IF NOT EXISTS idx_cps_regime ON campaign_pattern_stats(polymorphism_regime);
