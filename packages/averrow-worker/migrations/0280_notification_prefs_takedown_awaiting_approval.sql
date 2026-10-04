-- 0280_notification_prefs_takedown_awaiting_approval.sql
-- Add the missing per-event toggle column for `takedown_awaiting_approval`.
--
-- Background: the event was registered in
-- packages/shared/src/notification-events.ts with `userToggleable: true`,
-- but no migration added its column to the legacy
-- notification_preferences table. The prefs handler derives its SELECT
-- and upsert column lists from USER_TOGGLEABLE_EVENTS, so both
-- GET and PATCH /api/notifications/preferences failed with
-- "no such column: takedown_awaiting_approval" (500) — the settings page
-- showed "Couldn't load your notification preferences" for every user.
--
-- Default ON, matching the registry's defaultEnabled: true (same pattern
-- as migration 0163). Pinned by test/notification-prefs-columns.test.ts.

ALTER TABLE notification_preferences ADD COLUMN takedown_awaiting_approval INTEGER NOT NULL DEFAULT 1;
