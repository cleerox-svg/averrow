-- Agent activity log for durable workflow progress tracking and Flight Control decisions
CREATE TABLE IF NOT EXISTS agent_activity_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  event_type TEXT NOT NULL,
  message TEXT,
  metadata_json TEXT,
  severity TEXT DEFAULT 'info'
    CHECK (severity IN ('info','warning','critical')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_agent
  ON agent_activity_log(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_recent
  ON agent_activity_log(created_at DESC);
