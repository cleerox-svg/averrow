-- Budget tracking tables for real-time AI cost management
-- Monthly budget config + per-call cost ledger

CREATE TABLE IF NOT EXISTS budget_config (
  id           INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  monthly_limit_usd  REAL NOT NULL DEFAULT 21.33,
  soft_pct     REAL NOT NULL DEFAULT 80,
  hard_pct     REAL NOT NULL DEFAULT 95,
  emergency_pct REAL NOT NULL DEFAULT 99,
  updated_at   TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO budget_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS budget_ledger (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  run_id       TEXT,
  model        TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ledger_month
  ON budget_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_agent
  ON budget_ledger(agent_id, created_at DESC);
