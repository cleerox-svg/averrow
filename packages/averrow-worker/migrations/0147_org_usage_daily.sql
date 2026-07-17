-- 0147_org_usage_daily.sql
-- Per-tenant per-module usage rollup. v3 Phase A foundation.
--
-- Append-on-write isn't viable here (cost of SUM scans on hot path).
-- Pattern mirrors `agent_budget_rollups`: single composite-PK row per
-- (org, module, metric, day). UPSERT on each recordUsage() call.
-- KV-cached read for hot dashboard queries (60s TTL).

CREATE TABLE org_usage_daily (
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  module_key  TEXT NOT NULL,
  metric_key  TEXT NOT NULL,
  day         TEXT NOT NULL,             -- 'YYYY-MM-DD' UTC
  value       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, module_key, metric_key, day)
);

-- Two read patterns drive the indexes:
--   1) "show this org's usage for this module this month"
--      → covered by the PK (composite prefix scan)
--   2) "show this org's total usage across all modules this month"
--      → composite index on (org_id, day) keeps the scan local
CREATE INDEX idx_org_usage_daily_org_day ON org_usage_daily(org_id, day);
