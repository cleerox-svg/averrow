-- 0001_initial.sql — DNS resolution work queue
--
-- Side D1 (`trust-radar-dns-queue`) that holds the "needs DNS
-- resolution" working set extracted from the main threats table.
-- Goal: isolate the ~17K-row drainable set into its own 25B-row/month
-- read budget so the heavy dns-backfill SELECT + UPDATE cycle stops
-- competing with the main trust-radar-v2 budget.
--
-- Pre-stage pattern (PR-1 of the DNS-queue split):
--   - DB exists, binding active, schema stamped
--   - No code reads/writes yet (PR-2 adds dual-write, PR-3 flips reads,
--     PR-4 removes the threats-table fallback path)
--
-- Shape mirrors what `lib/dns-backfill.ts` already reads from threats:
--   malicious_domain      — resolution key (PK; the dns-backfill SELECT
--                           returns DISTINCT malicious_domain so PK is
--                           the natural shape)
--   enrichment_attempts   — retry counter, capped at 8 by dns-backfill
--   attempted_resolve_at  — 6h cooldown gate
--   last_outcome          — null | 'resolved' | 'dead' | 'transient'
--                           (for diagnostics & per-outcome reaping)
--   enqueued_at           — age-in-queue metric for FC backlog views
--   source_feed           — for per-feed exhausted-pile attribution
--                           (mirrors threats.source_feed)
--
-- Lifecycle (target state after PR-3):
--   ENQUEUE — feed ingestion creates a threats row with
--             malicious_domain NOT NULL AND ip_address IS NULL → also
--             INSERT INTO dns_queue ON CONFLICT DO NOTHING
--   DRAIN   — Navigator's dns-backfill reads here (not threats), claims
--             via UPDATE, resolves via DoH, writes resolved IP back to
--             the main DB's threats row, then DELETEs the queue row
--   GRADUATE — when enrichment_attempts hits 8 (dead) or resolution
--              succeeds, the row leaves the queue. Dead rows can stay
--              for a short audit window stamped last_outcome='dead'
--              before a daily reaper purges.

CREATE TABLE IF NOT EXISTS dns_queue (
  malicious_domain TEXT PRIMARY KEY,
  enrichment_attempts INTEGER NOT NULL DEFAULT 0,
  attempted_resolve_at TEXT,
  last_outcome TEXT,
  enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_feed TEXT
);

-- Partial index for the drainable subset (attempts < cap). The SELECT
-- filters attempted_resolve_at IS NULL OR older than 6h as a residual
-- against this compact index. Mirrors the pattern that worked for
-- idx_threats_dns_pending_strict on the main DB.
CREATE INDEX IF NOT EXISTS idx_dns_queue_drainable
  ON dns_queue(attempted_resolve_at)
  WHERE enrichment_attempts < 8;

-- Per-feed exhausted-pile breakdown (last_outcome='dead' rows) drives
-- the cartographer_exhausted_by_feed section in platform-diagnostics
-- after the cutover.
CREATE INDEX IF NOT EXISTS idx_dns_queue_outcome_feed
  ON dns_queue(last_outcome, source_feed)
  WHERE last_outcome IS NOT NULL;

-- ANALYZE so the planner has stats for both indexes immediately.
-- Same omission cost migration 0197 fixed for the main DB — bake it
-- in from day one here.
ANALYZE;
