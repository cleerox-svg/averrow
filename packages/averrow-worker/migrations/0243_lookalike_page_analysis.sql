-- 0243_lookalike_page_analysis.sql
-- Deterministic page-content phishing analysis (S2.4 / D6 increment 1).
--
-- The SSRF-safe fetcher (lib/page-fetch.ts) pulls the LIVE HTML of
-- registered + resolving + has_web lookalike domains for org-monitored
-- brands, extracts deterministic phishing signals via HTMLRewriter (no
-- AI), and scores them (lib/page-phishing-scorer.ts). These columns
-- persist the per-domain result so the throttled re-analysis pass can
-- skip freshly-scanned rows (page_fetched_at 24h cadence) and so the
-- tenant lookalike UI can surface the page verdict.
--
-- ZERO AI in this increment — vision/screenshot analysis is deferred to
-- increment 2 (needs a Browser Rendering binding).
--
-- Additive only — ADD COLUMN, never DROP/ALTER (CLAUDE.md §8). NULL for
-- every existing row until the page-analysis pass first touches it.
--   page_fetched_at      ISO-8601 timestamp of the last successful (or
--                        attempted) page fetch. Drives the 24h throttle.
--   page_http_status     final HTTP status of the fetched page (after
--                        <=2 manually-followed, re-validated redirects).
--   page_phishing_score  0-100 deterministic score from the pure scorer.
--   page_signals         JSON array of fired signal keys (e.g.
--                        ["credential_form","offdomain_form_exfil"]).
--   page_content_hash    SHA-256 (hex) of the fetched HTML (size-capped
--                        body) — change detection across scans.

ALTER TABLE lookalike_domains ADD COLUMN page_fetched_at TEXT;
ALTER TABLE lookalike_domains ADD COLUMN page_http_status INTEGER;
ALTER TABLE lookalike_domains ADD COLUMN page_phishing_score INTEGER;
ALTER TABLE lookalike_domains ADD COLUMN page_signals TEXT;
ALTER TABLE lookalike_domains ADD COLUMN page_content_hash TEXT;
