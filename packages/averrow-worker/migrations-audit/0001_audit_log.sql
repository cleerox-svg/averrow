-- Averrow — Audit Log Table
-- Stored in separate D1 database (trust-radar-v2-audit)
-- This table is APPEND-ONLY: no deletes or updates allowed

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
  user_id       TEXT,           -- null for system-initiated actions
  action        TEXT NOT NULL,  -- login, logout, role_change, invitation, feed_config, data_export, etc.
  resource_type TEXT,           -- user, brand, threat, campaign, feed, etc.
  resource_id   TEXT,
  details       TEXT,           -- JSON, before/after state for changes
  ip_address    TEXT,
  user_agent    TEXT,
  outcome       TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure', 'denied'))
);

CREATE INDEX idx_audit_user ON audit_log(user_id, timestamp DESC);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_outcome ON audit_log(outcome);
