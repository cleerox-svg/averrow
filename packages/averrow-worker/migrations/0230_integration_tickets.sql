-- Tier 2b (compliance ticketing): map a platform object (a takedown) to the
-- external ticket it opened in a customer's Jira / ServiceNow, so we can
-- open-on-detection and close-on-resolution and keep an auditable record.
CREATE TABLE IF NOT EXISTS integration_tickets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  integration_id TEXT NOT NULL REFERENCES org_integrations(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL,
  source_type TEXT NOT NULL,          -- 'takedown'
  source_id TEXT NOT NULL,
  external_key TEXT NOT NULL,         -- Jira issue key / ServiceNow sys_id
  external_url TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'closed'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (integration_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_integration_tickets_org
  ON integration_tickets(org_id, created_at);
