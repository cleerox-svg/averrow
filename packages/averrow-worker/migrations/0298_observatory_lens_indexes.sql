-- 0298 — Observatory Phase B lens endpoints: supporting indexes.
--
-- Additive only. No column is dropped, altered or rewritten.
--
-- 1. agent_events(event_type, created_at)
--    GET /api/observatory/movements reads
--      WHERE event_type = 'pivot_detected' AND created_at >= ?
--      ORDER BY created_at DESC LIMIT ?
--    The only existing index is idx_agent_events_pending
--    (status, priority, created_at), so that read was a full table scan
--    (~27.6K rows read on 2026-10-14 for a 4-row LIMIT). This index makes
--    it a bounded range seek in created_at order.
--
--    agent_events exists in production OUT-OF-BAND (created before the
--    tracked migrations dir; no file here creates it), so on a fresh
--    `d1 migrations apply` (staging/dev) the CREATE INDEX would fail with
--    "no such table". The CREATE TABLE IF NOT EXISTS below reproduces the
--    production DDL exactly (read from sqlite_master 2026-10-14) — a no-op
--    in production, and it gives fresh databases the table every agent
--    already writes to. Same fresh-bootstrap pattern as 0064.
--
-- 2. infrastructure_clusters(threat_count DESC, id)
--    GET /api/observatory/operations-geo reads the top-N clusters
--      [WHERE status = 'active'] ORDER BY threat_count DESC, id LIMIT ?
--    over ~77K rows. Without an index on the sort key every cache miss
--    sorted the whole table; with it the read walks the index and stops at
--    LIMIT (status filter applied on the walk — ~92% of rows are active).

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  source_agent TEXT NOT NULL,
  target_agent TEXT,
  payload_json TEXT,
  priority INTEGER DEFAULT 5,
  created_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','failed'))
);

CREATE INDEX IF NOT EXISTS idx_agent_events_pending
  ON agent_events(status, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_events_type_created
  ON agent_events(event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_clusters_threat_count
  ON infrastructure_clusters(threat_count DESC, id);
