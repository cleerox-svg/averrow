-- Rolling history of Flight Control backlog measurements.
-- Used by FC's stall detection: if a backlog isn't strictly decreasing
-- across the last 4 ticks, FC emits a critical 'backlog_stalled' event
-- so the operator (and the dashboard) can act.
CREATE TABLE IF NOT EXISTS backlog_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  backlog_name  TEXT NOT NULL,
  count         INTEGER NOT NULL,
  recorded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_backlog_history_name_time
  ON backlog_history (backlog_name, recorded_at DESC);
