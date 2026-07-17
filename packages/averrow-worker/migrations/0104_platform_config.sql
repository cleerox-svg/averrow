-- ─── Platform-wide config (key/value store) ─────────────────────────
-- Holds runtime-configurable platform flags that don't fit cleanly into
-- env vars or wrangler secrets:
--   - push_enabled        : '0' | '1'  — global Web Push kill switch
--   - vapid_public_key    : base64url-encoded P-256 public key (read by
--                           the SPA at subscribe time; not a secret)
--   - vapid_subject       : 'mailto:ops@averrow.com' or similar (RFC 8292)
--
-- Rationale for a table (vs. env var):
--   - VAPID public key is read by the SPA, so it must be in a place
--     accessible without a secret. Env vars in wrangler.toml end up in
--     bundled output but are awkward to update without redeploying.
--   - push_enabled is a hot kill switch — needs DB so any admin can flip
--     it without a redeploy.
--   - Per-event push toggles (`push_rule_<event>`) can be added later
--     by inserting more rows, no schema migration required.
--
-- VAPID PRIVATE KEY stays in `wrangler secret put VAPID_PRIVATE_KEY`,
-- never in this table.

CREATE TABLE IF NOT EXISTS platform_config (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Initial rows. Push starts DISABLED — operator runs the bootstrap to
-- generate VAPID keys, sets the wrangler secret, then flips push_enabled.
INSERT OR IGNORE INTO platform_config (key, value) VALUES ('push_enabled', '0');
INSERT OR IGNORE INTO platform_config (key, value) VALUES ('vapid_public_key', '');
INSERT OR IGNORE INTO platform_config (key, value) VALUES ('vapid_subject', '');
