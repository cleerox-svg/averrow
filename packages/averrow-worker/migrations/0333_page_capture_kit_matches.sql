-- Migration 0333: phishing-kit rule matches on page captures (IOK ruleset).
--
-- Additive only: one new table + two new nullable columns on page_captures.
--
-- After a successful capture (status captured|blocked, not an off-site decoy)
-- the page_capture agent evaluates the vendored IOK ruleset
-- (src/data/iok/rules.json, "Rules: IOK by phish.report (ODbL)") against the
-- evidence the capture already stores — rendered HTML, title, final URL,
-- redirect chain; no new fetching (lib/iok-engine.ts, lib/iok-kit-matches.ts).
--
-- Matches are CONTEXT ONLY: they never create alerts, never change severity
-- or triage, and are never returned by a tenant-facing API. The only reader
-- is the staff detection detail (GET /api/intel/identity-threats/detections/
-- :threatId → captures[].kit_matching).
--
-- page_capture_kit_matches — one row per (capture, rule) that matched.
--   rule_title / rule_tags_json are copied from the ruleset at match time so
--   a later refresh that renames or removes a rule does not orphan the row;
--   ruleset_commit records which IOK commit produced the match.
--   approx_fields_json lists the non-exact evidence fields the rule reads
--   (html, requests, title, js, css — see lib/iok-engine.ts); '[]' = the
--   match rests on exact fields only.
--   PK (capture_id, rule_id) serves the per-capture read. A re-evaluation
--   deletes the capture's rows and inserts the new set in one batch
--   (ON CONFLICT DO UPDATE backstops a concurrent run). Rows are deleted
--   when the capture's evidence expires (180-day sweep).
CREATE TABLE IF NOT EXISTS page_capture_kit_matches (
  capture_id      TEXT NOT NULL,
  rule_id         TEXT NOT NULL,
  rule_title      TEXT NOT NULL,
  rule_tags_json  TEXT,
  approx_fields_json TEXT,
  ruleset_commit  TEXT NOT NULL,
  matched_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (capture_id, rule_id)
);

-- Which ruleset commit evaluated the capture, when, and how completely.
-- kit_ruleset_commit NULL = never evaluated (captures stored before this
-- migration, decoys, or an evaluation that failed).
-- kit_eval_status: 'complete'  every rule saw all the evidence;
--                  'truncated' every rule ran but input was clipped to a cap
--                              (1M chars of HTML, 256K per regex, list caps)
--                              — "no match" is not conclusive;
--                  'partial'   the work budget ended the run early — only
--                              some rules were evaluated.
ALTER TABLE page_captures ADD COLUMN kit_ruleset_commit TEXT;
ALTER TABLE page_captures ADD COLUMN kit_evaluated_at TEXT;
ALTER TABLE page_captures ADD COLUMN kit_eval_status TEXT;
