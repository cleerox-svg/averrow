-- ─── Notifications N7 — per-channel delivery audit ────────────────
--
-- Background: during the Apr 30 - May 2 ingest blackout (50cb1e4),
-- platform_feed_silent never reached operators. The orchestrator's
-- catch path called emitPlatformNotification, but no one had eyes on
-- the resulting in-app row, push delivery is silently swallowed on
-- failure, and there is no email path for platform_* notifications at
-- all. We had no way to answer "did the alert leave the building?".
--
-- This table records each delivery attempt per notification, per user,
-- per channel. Read by /api/admin/notification-delivery-audit so we
-- can surface platform_* notifications whose delivery never landed in
-- a channel a human reads.
--
-- One row per (notification_id, user_id, channel) — push retries
-- update the same row rather than appending. If we add a true email
-- path for platform notifications in Phase 2, the same row will
-- capture that channel without schema churn.

CREATE TABLE notification_deliveries (
  id              TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL
                  CHECK (channel IN ('in_app','push','email')),
  status          TEXT NOT NULL
                  CHECK (status IN ('attempted','succeeded','failed','skipped')),
  -- Why the attempt was skipped (DND, opt-out, no device) or failed
  -- (push 404, network). Null for the in_app row which always succeeds.
  reason          TEXT,
  attempted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,

  UNIQUE (notification_id, user_id, channel)
);

-- Audit endpoint reads by (channel, status) over the last N days.
CREATE INDEX idx_notification_deliveries_status
  ON notification_deliveries (channel, status, attempted_at DESC);

-- Look up all channels for a single notification (used when an operator
-- clicks a row in the audit UI). Composite ordering keeps the row layout
-- stable when we add the email channel later.
CREATE INDEX idx_notification_deliveries_lookup
  ON notification_deliveries (notification_id, user_id, channel);
