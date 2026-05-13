-- Create the provider_threat_stats table that the cartographer
-- agent's aggregateProviderStats() writes to every cron tick, and
-- that GET /api/providers/stats reads from.
--
-- The table was never created. cartographer.ts has been emitting
-- "no such table: provider_threat_stats" on every orchestrator tick
-- since the code was added, but the error was swallowed by the
-- try/catch around db.batch() and only surfaced once the parent
-- cron started hitting exceededCpu (worker logs 2026-05-13).
--
-- Schema reverse-engineered from:
--   - INSERT…ON CONFLICT block in agents/cartographer.ts ~L1124
--   - SELECT in handlers/providers.ts handleProviderStats
--
-- ON CONFLICT(provider_name, period) DO UPDATE => unique pair.

CREATE TABLE IF NOT EXISTS provider_threat_stats (
  id              TEXT PRIMARY KEY,
  provider_name   TEXT NOT NULL,
  period          TEXT NOT NULL,
  threat_count    INTEGER NOT NULL DEFAULT 0,
  critical_count  INTEGER NOT NULL DEFAULT 0,
  high_count      INTEGER NOT NULL DEFAULT 0,
  phishing_count  INTEGER NOT NULL DEFAULT 0,
  malware_count   INTEGER NOT NULL DEFAULT 0,
  top_countries   TEXT,
  trend_direction TEXT,
  trend_pct       REAL,
  computed_at     TEXT NOT NULL,
  UNIQUE(provider_name, period)
);

CREATE INDEX IF NOT EXISTS idx_provider_threat_stats_period
  ON provider_threat_stats(period, threat_count DESC);
