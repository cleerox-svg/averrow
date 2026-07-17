-- Takedown automation — Sparrow Phase G prerequisites.
--
-- Adds the columns + audit table needed for the dispatcher
-- (lib/takedown-submitters/) to run takedowns end-to-end without
-- a human in the loop.
--
-- Three additive changes:
--
--   1. takedown_requests.module_key — which module a takedown
--      came from (domain | social | app_store | dark_web |
--      abuse_mailbox | trademark | threat_actor). Required for
--      the takedown_authorizations scope check at submit time.
--      NULL on legacy rows — Phase G refuses to auto-submit
--      until a key is set, so legacy rows fall through to manual.
--
--   2. takedown_providers.auto_submit_enabled — operator gate.
--      Default 0 (off). Operator flips to 1 after wiring the
--      provider's submitter (lib/takedown-submitters/<provider>.ts)
--      and verifying it produces a usable submission.
--
--   3. takedown_submissions — one row per submission attempt.
--      Audit trail for what was sent, where, when, and what
--      response came back. Lets us measure auto-submit success
--      rate per provider and surface that to averrow-ops.
--
-- Phase C sprint 1.

-- ─── 1. takedown_requests.module_key ────────────────────────────
ALTER TABLE takedown_requests ADD COLUMN module_key TEXT;

CREATE INDEX IF NOT EXISTS idx_takedown_requests_module_status
  ON takedown_requests (module_key, status);

-- ─── 2. takedown_providers.auto_submit_enabled + last_verified_at ─
ALTER TABLE takedown_providers ADD COLUMN auto_submit_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE takedown_providers ADD COLUMN last_verified_at    TEXT;

-- ─── 3. takedown_submissions ────────────────────────────────────
CREATE TABLE IF NOT EXISTS takedown_submissions (
  id TEXT PRIMARY KEY,
  takedown_id TEXT NOT NULL REFERENCES takedown_requests(id) ON DELETE CASCADE,
  provider_id INTEGER REFERENCES takedown_providers(id) ON DELETE SET NULL,

  -- What was submitted
  submitter_kind   TEXT NOT NULL,                  -- 'email_draft' | 'email' | 'api_<provider>' | 'form'
  submitter_target TEXT,                            -- email recipient / API endpoint / form URL
  request_summary  TEXT,                            -- preview of body (<=500 chars)
  request_payload  TEXT,                            -- JSON if API; raw email body if email

  -- What came back
  outcome          TEXT NOT NULL,                   -- 'submitted' | 'queued' | 'failed' | 'rejected'
  response_status  INTEGER,                         -- HTTP status if API/form; NULL for email
  response_body    TEXT,                            -- truncated <=500 chars
  ticket_id        TEXT,                            -- provider-issued ticket / case ID
  error_message    TEXT,

  -- Lifecycle
  attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
  duration_ms  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_takedown_submissions_takedown
  ON takedown_submissions (takedown_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_takedown_submissions_provider_outcome
  ON takedown_submissions (provider_id, outcome, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_takedown_submissions_attempted
  ON takedown_submissions (attempted_at DESC);
