-- 0199_email_optouts.sql
--
-- Recipients who clicked Gmail's one-click unsubscribe (or any
-- equivalent List-Unsubscribe link) for abuse-mailbox responder
-- emails. Once an email lands here, neither the ack nor the
-- determination send paths emit anything to that address.
--
-- Wired by:
--   - src/handlers/abuseMailboxUnsubscribe.ts  (POST endpoint that
--     inserts a row in response to Gmail's List-Unsubscribe-Post)
--   - src/lib/abuse-mailbox-responder.ts       (shouldRespond()
--     reads this table — sends are gated on no row existing)
--
-- The table is intentionally minimal: an opt-out is permanent until
-- an operator manually deletes the row. There's no time window or
-- re-opt-in flow; if a recipient changes their mind they'd need to
-- reach support.

CREATE TABLE IF NOT EXISTS email_optouts (
  email        TEXT PRIMARY KEY,
  opted_out_at TEXT NOT NULL DEFAULT (datetime('now')),
  source       TEXT NOT NULL,         -- 'list_unsubscribe_one_click' | 'manual_admin' | …
  message_id   TEXT,                  -- abuse_inbox_messages.id when triggered by an email link
  notes        TEXT
);
