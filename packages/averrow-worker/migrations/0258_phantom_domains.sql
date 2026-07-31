-- Migration: 0258_phantom_domains.sql
--
-- Storage for the phantom-squat watchlist (Wave 2). Spec: W2.0
-- phantom-squat enumeration design spec §4 (storage shape) + §6 (hit
-- fields). Doctrine mandate:
-- docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md §3.3 + §6 rec #3
-- ("Phantom-squat watchlist — queued as the Wave 2 follow-up").
--
-- Concept: LLMs deterministically hallucinate plausible-but-nonexistent
-- domains for a brand; attackers register these 18-51 days later
-- (Unit 42, 2026). The phantom_enumerator agent (W2.2) writes one
-- bounded Haiku pass of predicted domains per monitored brand at
-- status='predicted'. A phantom is a PREDICTION, not a threat — the
-- enumerating agent creates NO threats row and NO alerts row. A phantom
-- becomes actionable ONLY when a later independent observation
-- (NRD/CT/lookalike) lands on it (W2.3 matchers), which flips
-- status->'registered' and creates at most one 'low'-severity alert.
--
-- Dedicated table, NOT folded into lookalike_domains (spec §4.1): the
-- provenance columns don't fit, and folding would pull unregistered
-- predictions into the lookalike scanner's active DNS/HEAD probe set —
-- a cost change disguised as a schema change. A phantom stays inert
-- until a matcher flips it.
--
-- brand_id is TEXT to match brands.id (0001_core_tables.sql:
-- `id TEXT PRIMARY KEY`) — FK-in-spirit, no REFERENCES clause, matching
-- the platform's existing brand-linked tables.
--
-- ADDITIVE ONLY (CLAUDE.md §8): CREATE TABLE / CREATE INDEX with
-- IF NOT EXISTS. No DROP, no ALTER of any existing table. No new
-- alert_type and no CHECK migration on alerts — hits reuse the existing
-- lookalike_domain_active / ct_certificate_issued types (spec §6.1).
-- lookalike_domains is left untouched (spec §4.1 rejects folding).
--
-- ------------------------------------------------------------------
-- phantom_domains — per-brand hallucination-surface watchlist
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS phantom_domains (
  id                 TEXT PRIMARY KEY,            -- crypto.randomUUID()
  brand_id           TEXT NOT NULL,               -- FK-in-spirit to brands.id (TEXT)
  domain             TEXT NOT NULL,               -- validated, lowercased, registrable
  enumeration_run_id TEXT,                        -- agent_runs.id of the enumerating run
  source_model       TEXT NOT NULL,               -- e.g. 'claude-haiku-4-5-20251001'
  kind               TEXT,                        -- narrative only: tld_swap|hyphenation|...
  confidence         REAL,                        -- model self-rating 0-1, narrative only
  first_enumerated_at TEXT NOT NULL DEFAULT (datetime('now')),
  status             TEXT NOT NULL DEFAULT 'predicted'
                       CHECK (status IN ('predicted','registered','resolved','dismissed')),
  -- Hit fields (all NULL until a matcher lands — spec §6/§7):
  matched_source     TEXT CHECK (matched_source IN ('nrd','ct','lookalike')),
  matched_at         TEXT,
  threat_id          TEXT,                        -- set only if a matcher creates/links a threat
  alert_id           TEXT,                        -- the single monitoring alert from the hit
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (brand_id, domain)
);

-- Matcher join key (spec §7): the W2.3 post-pass joins
-- phantom.domain = nrd_domains.domain / ct_certificates.domain /
-- lookalike_domains.domain, filtered to status='predicted'. Bare (domain)
-- covers the set-based join; the matcher's WHERE status='predicted' is a
-- cheap residual on the joined rows.
CREATE INDEX IF NOT EXISTS idx_phantom_domain        ON phantom_domains(domain);

-- Per-brand watchlist reads + the "predicted rows for this brand" scan.
CREATE INDEX IF NOT EXISTS idx_phantom_brand_status  ON phantom_domains(brand_id, status);

-- Status-lifecycle scans (e.g. count registered hits, dismissed sweep).
CREATE INDEX IF NOT EXISTS idx_phantom_status        ON phantom_domains(status);
