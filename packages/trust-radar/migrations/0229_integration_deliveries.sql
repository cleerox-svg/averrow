-- Tier 2 (data-out): per-event delivery log for org_integrations. Turns the
-- credential-shell org_integrations into an auditable delivery engine —
-- every push to a customer SIEM/SOAR/ticketing destination records an
-- outcome row. This is the compliance/audit trail AND the foundation for
-- retry/DLQ hardening.
CREATE TABLE IF NOT EXISTS integration_deliveries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  integration_id TEXT NOT NULL REFERENCES org_integrations(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,            -- 'delivered' | 'failed'
  http_status INTEGER,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  payload_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_integration_deliveries_integration
  ON integration_deliveries(integration_id, created_at);
CREATE INDEX IF NOT EXISTS idx_integration_deliveries_org
  ON integration_deliveries(org_id, created_at);
