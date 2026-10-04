-- 0279 — nrd_domains: worker-migration definition + created_at index for
-- the 90-day retention purge.
--
-- ── Why ──────────────────────────────────────────────────────────────
-- `nrd_domains` is the reference table every NRD (newly registered domain)
-- lands in (feeds/nrd_hagezi.ts storeNrdReference, INSERT OR IGNORE). It was
-- only ever created lazily by that writer's own CREATE TABLE IF NOT EXISTS
-- (plus the repo-root migrations/0057, which was never applied to the worker
-- DB), so no worker migration defined it and it grew without bound. Prod held
-- ~80K rows on 2026-10-04, nearly all inserted that day after the feed
-- resumed (#1781) — a partial day; a full feed day is ~180K new rows.
--
-- lib/nrd-retention.ts now purges rows older than 90 days on `created_at`
-- (never past the phantom matcher's nrd cursor), via
--   DELETE FROM nrd_domains WHERE rowid IN (
--     SELECT rowid FROM nrd_domains WHERE created_at < ?
--      ORDER BY created_at LIMIT ?)
-- Prod has ONLY the PK autoindex, so without this index every purge chunk
-- would be a full table scan. idx_nrd_domains_created makes the subquery a
-- range seek in created_at order (pinned by test/nrd-retention.test.ts via
-- EXPLAIN QUERY PLAN).
--
-- ── Idempotent vs prod ───────────────────────────────────────────────
-- The CREATE TABLE is the EXACT prod schema (read-only check 2026-10-04) and
-- the writer's own lazy DDL, so on prod it is a no-op; it exists so the
-- table is defined in worker migrations (fresh DBs, the migration-derived
-- test harness). The writer's CREATE TABLE IF NOT EXISTS stays as a guard.
--
-- ── Cost ─────────────────────────────────────────────────────────────
-- One-time index build over ~80K rows (prod, 2026-10-04) — one read pass and
-- ~80K index-entry writes.
-- Steady state:
--   * Insert: one extra index write per newly inserted NRD (INSERT OR IGNORE
--     of an existing domain writes nothing) — ~180K extra row-writes on a
--     full feed day.
--   * Purge: each deleted row also removes its PK-autoindex entry and its
--     idx_nrd_domains_created entry — ~3 row-writes per deleted row, so
--     ~540K row-writes/day once the 90-day window fills at ~180K rows/day.
-- That is the price of bounding the table at ~90 days (~16M rows at full
-- volume) instead of letting it grow forever.

CREATE TABLE IF NOT EXISTS nrd_domains (
  domain TEXT PRIMARY KEY,
  registered_date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  brand_matched INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_nrd_domains_created ON nrd_domains(created_at);
