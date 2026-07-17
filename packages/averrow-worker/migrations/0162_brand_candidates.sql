-- 0162_brand_candidates.sql
-- Brand candidate queue. CT-driven (and later, threat-driven) signals
-- propose apex domains as potential new brands without immediately
-- promoting them into the canonical `brands` table.
--
-- Two-stage promotion model:
--   1. Aggregator (lib/brand-candidates.ts) writes into this table
--      based on CT log activity — apex domains seen ≥3x across ≥2
--      distinct issuers in last 30d, not already in `brands` and
--      not already a candidate.
--   2. Operator review (averrow-ops, future PR) promotes candidates
--      into `brands` (sets tier='monitored') or rejects them
--      (status='rejected'). Rejected candidates stay here as a
--      negative training set.
--
-- This keeps the brand catalog focused — 100K Tranco-imported brands
-- already pushes the catalog wide. CT-driven candidates are typically
-- higher signal (someone actually issued certs for this domain) but
-- include lots of dev/staging/internal subdomains that aren't real
-- "brands." Operator filter via the review step.

CREATE TABLE IF NOT EXISTS brand_candidates (
  id              TEXT PRIMARY KEY,
  apex_domain     TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('ct_log', 'threat_target', 'manual')),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'promoted', 'rejected', 'duplicate')),
  cert_count      INTEGER NOT NULL DEFAULT 0,
  distinct_issuers INTEGER NOT NULL DEFAULT 0,
  first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen       TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at     TEXT,
  reviewed_by     TEXT,                 -- user_id of operator
  promoted_brand_id TEXT REFERENCES brands(id),
  notes           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_candidates_apex_source ON brand_candidates(apex_domain, source);
CREATE INDEX IF NOT EXISTS idx_brand_candidates_status ON brand_candidates(status);
CREATE INDEX IF NOT EXISTS idx_brand_candidates_first_seen ON brand_candidates(first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_brand_candidates_cert_count ON brand_candidates(cert_count DESC);
