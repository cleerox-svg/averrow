-- Migration: 0049_org_integrations.sql
-- Org-scoped third-party integrations (SIEM, ticketing, inbound feeds)

CREATE TABLE IF NOT EXISTS org_integrations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  config_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  last_sync_at TEXT,
  last_error TEXT,
  events_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_org_integrations_org
  ON org_integrations(org_id);
