-- ─── Recreate notifications with extended CHECK constraint ───────────
-- SQLite can't ALTER a CHECK constraint in place — the only way to add
-- new event keys to the type column's whitelist is to recreate the table.
--
-- This migration closes the FIXME from PR 2 (the registry refactor):
-- two system events — `email_security_change` (cartographer.ts:475) and
-- `circuit_breaker_tripped` (flightControl.ts:1182, agentRunner.ts:312) —
-- have been failing the schema CHECK and silently dropping in production
-- since they were added. Their dispatcher calls were wrapped in try/catch
-- so the agents themselves never failed; the notifications just never
-- reached anyone.
--
-- After this migration, all 7 event keys from
-- `src/lib/notification-events.ts` (the canonical registry) are valid:
--   user-toggleable: brand_threat, campaign_escalation, feed_health,
--                    intelligence_digest, agent_milestone
--   system:          email_security_change, circuit_breaker_tripped
--
-- Existing rows are migrated verbatim (no `type` values currently in the
-- table can violate the new wider CHECK). Indexes recreated unchanged.
-- The temp-table-swap pattern is the only safe way to do this in SQLite
-- without losing data.

-- 1. Build the replacement.
CREATE TABLE notifications_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN (
    'brand_threat', 'campaign_escalation', 'feed_health',
    'intelligence_digest', 'agent_milestone',
    'email_security_change', 'circuit_breaker_tripped'
  )),
  severity   TEXT NOT NULL DEFAULT 'info'
             CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata   TEXT
);

-- 2. Copy rows. The original table has the same column set + ordering.
INSERT INTO notifications_new (id, user_id, type, severity, title, message, link, read_at, created_at, metadata)
SELECT id, user_id, type, severity, title, message, link, read_at, created_at, metadata
  FROM notifications;

-- 3. Drop the old, rename the new.
DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

-- 4. Recreate the indexes from migration 0018.
CREATE INDEX IF NOT EXISTS idx_notifications_user
  ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created
  ON notifications(created_at);
