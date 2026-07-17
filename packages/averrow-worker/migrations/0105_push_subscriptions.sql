-- ─── Web Push subscriptions (per device) ────────────────────────────
-- One row per browser/device a user has installed the PWA on.
--
-- The endpoint URL is the push service's identifier for this subscription
-- (e.g. https://fcm.googleapis.com/fcm/send/abcd... for Chrome on Android,
-- https://web.push.apple.com/Q... for Safari/iOS PWAs). Two devices on the
-- same user → two rows.
--
-- p256dh + auth are the keys the dispatcher needs to encrypt payloads
-- per RFC 8291 (aes128gcm). They're tied to the device, not the user —
-- if the user uninstalls and re-installs the PWA, a new endpoint + new
-- keys are issued, and the old row should be deleted. The dispatcher
-- handles the latter automatically: any 404/410 from the push service
-- on a delivery attempt deletes the row (subscription expired).

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,    -- base64url-encoded P-256 public key (subscriber)
  auth          TEXT NOT NULL,    -- base64url-encoded 16-byte auth secret
  device_label  TEXT,             -- heuristic from User-Agent at subscribe time
  user_agent    TEXT,             -- captured for diagnostics / device list UI
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT              -- bumped on every successful push send
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);
