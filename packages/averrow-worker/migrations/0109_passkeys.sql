-- ─── Passkeys (WebAuthn credentials) ────────────────────────────────
-- One row per credential. A user can have many — typically one per device
-- (iCloud Keychain syncs them across the user's Apple devices, Google
-- Password Manager syncs across Android, but each browser/OS still
-- registers its own credential record on first use).
--
-- Storage rules (matches FarmTrack pattern + @simplewebauthn/server v11):
--   - credential_id is the WebAuthn-issued unique identifier, base64url.
--     UNIQUE because the spec guarantees uniqueness across all subscribers
--     of any given relying party.
--   - public_key is the COSE-encoded P-256 / Ed25519 public key, base64url.
--     Used to verify authentication assertions on every sign-in.
--   - sign_count is the authenticator's monotonic counter. If a sign-in
--     ever returns a sign_count <= the stored value, the credential was
--     cloned (or the authenticator is broken) — we reject the auth.
--   - transports is a JSON array of hints (['internal', 'usb', 'nfc',
--     'ble', 'hybrid']) the browser uses to surface the right UI.
--   - device_label is a heuristic from the User-Agent at registration
--     time so the user can tell their devices apart in the management UI.
--
-- Cascading delete on user_id mirrors the sessions table — if an admin
-- deactivates a user, their passkeys go with the row.

CREATE TABLE IF NOT EXISTS passkeys (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id   TEXT NOT NULL UNIQUE,         -- base64url
  public_key      TEXT NOT NULL,                -- base64url COSE
  sign_count      INTEGER NOT NULL DEFAULT 0,
  transports      TEXT,                         -- JSON array
  device_label    TEXT,                         -- 'iPhone', 'Mac (Touch ID)', etc.
  user_agent      TEXT,                         -- captured at registration
  backed_up       INTEGER NOT NULL DEFAULT 0,   -- 1 if synced via iCloud Keychain / Google PM
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_passkeys_user
  ON passkeys(user_id);
CREATE INDEX IF NOT EXISTS idx_passkeys_credential
  ON passkeys(credential_id);
