-- Add recency tracking columns to hosting_providers so cartographer
-- can skip re-scoring providers whose data hasn't changed materially.

ALTER TABLE hosting_providers ADD COLUMN last_scored_at TEXT;
ALTER TABLE hosting_providers ADD COLUMN last_score INTEGER;
ALTER TABLE hosting_providers ADD COLUMN last_score_threat_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_hosting_providers_score_recency
  ON hosting_providers(last_scored_at)
  WHERE total_threat_count > 0;

-- Fresh-bootstrap fix (same pattern as 0053): hosting_providers.is_bulletproof
-- is read by GET /api/providers/v2 (src/handlers/providers.ts) but was only
-- ever added OUT-OF-BAND in prod (docs/archive/AVERROW_MASTER_PLAN_2026-03.md)
-- — no migration defined it, so a migration-built DB (staging, dev, the
-- derived-schema test harness) 500'd on that route. Added here, additively,
-- matching prod's shape (INTEGER, nullable, DEFAULT 0).
--
-- Prod-invisible: 0078 has been applied in prod since 2026-04-10 (which
-- already has the column) and never re-runs — D1 tracks migrations by
-- filename. A new 0276 could not do this: SQLite has no ADD COLUMN IF NOT
-- EXISTS, so a plain ALTER would fail prod with "duplicate column name".
-- A DB that applied 0078 BEFORE this edit (e.g. an old `--local` dev DB)
-- needs the one-off ALTER below by hand — see docs/DEPLOYMENT.md.
ALTER TABLE hosting_providers ADD COLUMN is_bulletproof INTEGER DEFAULT 0;
