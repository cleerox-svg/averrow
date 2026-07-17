-- ─── Magic-link sign-in tokens ──────────────────────────────────────
-- Email-based passwordless sign-in for users without Google accounts
-- (Microsoft 365, Outlook, custom domains).
--
-- Token storage rules (from FarmTrack pattern + the existing invites
-- table): only the SHA-256 hash is stored here; the raw token only
-- ever appears in the email body sent to the legitimate recipient.
-- A DB breach can't be used to mint sessions.
--
-- Single-use: once `used_at` is set, the same token cannot be exchanged
-- again. The verify endpoint sets it transactionally with the session
-- mint so a race against simultaneous clicks can only succeed once.
--
-- 30-minute expiry is short enough to limit replay risk, long enough
-- that a user receiving the email on a different device than the one
-- they ordered it from can still complete the flow.
--
-- Rate limiting (3 requests / email / 15 min) is enforced in the
-- handler via env.CACHE (KV), not here, so legitimate users mistyping
-- their email don't fill the table with abandoned rows.

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,                     -- SHA-256 hex of raw token
  expires_at    TEXT NOT NULL,                            -- ISO8601, 30 min from issue
  used_at       TEXT,                                     -- ISO8601 once consumed; NULL = unused
  ip_address    TEXT,                                     -- captured at request time (audit)
  user_agent    TEXT,                                     -- captured at request time (audit)
  return_to     TEXT,                                     -- optional deep-link path the SPA should land on
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Hash lookup is the hot path on verify. The index on email is for
-- audit queries (admin: "who requested links recently") and the
-- per-email rate-limit cleanup, not the auth flow itself.
CREATE INDEX IF NOT EXISTS idx_magic_link_email
  ON magic_link_tokens(email);
CREATE INDEX IF NOT EXISTS idx_magic_link_expires
  ON magic_link_tokens(expires_at) WHERE used_at IS NULL;
