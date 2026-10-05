-- 0282_lookalike_registration_evidence.sql
--
-- NRD <-> lookalike matching: how a lookalike row's registration became
-- KNOWN, and whether its new-registration alert has already been filed.
--
-- ── Why ─────────────────────────────────────────────────────────────
--
-- `lookalike_domains.first_seen` ("when the domain appeared") was stamped
-- ONLY by the DNS checker's observed `registered 0 -> 1` transition. With a
-- ~35K-row first-contact queue drained at 30 rows/hour, a permutation that
-- was registered while it sat in that queue was classified as a
-- first-contact BASELINE on its first check (baseline_established_at set,
-- first_seen NULL) and never produced a "newly registered" signal. Live
-- example: tp-ink.com (a Tp Link typosquat), registered 2026-10-03 and in
-- our own `nrd_domains` from 2026-10-04, never checked.
--
-- `lib/lookalike-nrd-matcher.ts` now joins every newly ingested
-- `nrd_domains` row to `lookalike_domains` by domain. A hit is a REGISTRY
-- fact ("this permutation was newly registered on <date>"), independent of
-- when our DNS checker gets to the row.
--
-- ── Columns ─────────────────────────────────────────────────────────
--
--   registration_evidence   TEXT  NULL | 'nrd' | 'observed'
--       How first_seen was learned. 'nrd' = the NRD matcher stamped it
--       from nrd_domains.registered_date; 'observed' = the DNS checker
--       saw registered 0 -> 1 on a baselined row. NULL = no confirmed
--       registration (incl. the legacy first_seen rows from before this
--       migration, which are deliberately NOT backfilled: 45 rows, all
--       2026-05-25 artifacts of pre-0267 first checks).
--
--   registration_alerted_at TEXT  NULL | datetime
--       Guarded claim for the new-registration alert. Set (WHERE ... IS
--       NULL) BEFORE createAlert runs, so a registration event files at
--       most one new-registration alert. Cleared only on an ANSWERED
--       registered 1 -> 0 lapse, so a later re-registration is a new event.
--
-- ── Indexes ─────────────────────────────────────────────────────────
--
--   idx_lookalike_domain  (domain)
--       The NRD join probes lookalike_domains by bare `domain`; the only
--       existing domain index is the UNIQUE (brand_id, domain), whose
--       leading column the join cannot constrain. Without this every
--       probe would be a full scan of ~56K rows. Not UNIQUE: the same
--       permutation can belong to several brands.
--
--   idx_lookalike_first_seen  (first_seen) WHERE first_seen IS NOT NULL
--       Serves the public-proof `new_registrations_30d` range count
--       (lib/public-proof.ts). Partial: almost every row has a NULL
--       first_seen, so the index holds only confirmed registrations and
--       stays tiny. `first_seen >= ?` implies `first_seen IS NOT NULL`,
--       which SQLite proves, so the partial index is usable (pinned by
--       test/lookalike-nrd-matcher.test.ts via EXPLAIN QUERY PLAN).
--
-- ── Cost ────────────────────────────────────────────────────────────
-- One-time build of idx_lookalike_domain over ~56K rows (one read pass,
-- ~56K index writes) and of the partial first_seen index (45 entries).
-- Steady state: one extra index write per seeded permutation; the partial
-- index only changes on a confirmed registration.
--
-- Additive only — ADD COLUMN / CREATE INDEX, never DROP/ALTER and never a
-- table rebuild (D1 enforces foreign keys).

ALTER TABLE lookalike_domains ADD COLUMN registration_evidence TEXT;
ALTER TABLE lookalike_domains ADD COLUMN registration_alerted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_lookalike_domain
  ON lookalike_domains(domain);

CREATE INDEX IF NOT EXISTS idx_lookalike_first_seen
  ON lookalike_domains(first_seen)
  WHERE first_seen IS NOT NULL;
