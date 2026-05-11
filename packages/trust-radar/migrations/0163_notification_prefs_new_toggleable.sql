-- 0163_notification_prefs_new_toggleable.sql
-- PR-B: promote three system events to user-toggleable so users can
-- silence them individually.
--
-- Background: notification-events.ts had 3 events flagged
-- `userToggleable: false` (system-only). That meant users who got
-- DMARC notifications (firing as 'brand_threat' for years) had no
-- way to disable just DMARC without losing all brand-threat alerts.
--
-- This migration adds the columns these events need in the legacy
-- notification_preferences table so the prefs handler (which
-- derives column names from USER_TOGGLEABLE_EVENTS) auto-picks
-- them up. The settings UI also auto-renders new rows since it
-- iterates USER_TOGGLEABLE_EVENTS too.
--
-- Companion code changes:
--   - packages/shared/src/notification-events.ts: flip the 3 events
--     to userToggleable: true
--   - packages/trust-radar/src/dmarc-receiver.ts: fire DMARC alerts
--     as 'email_security_change' (not 'brand_threat') so the new
--     toggle actually controls it
--
-- Defaults: all 3 stay ON so existing users keep getting these
-- notifications by default. The user can flip them off in
-- /notifications/preferences.

ALTER TABLE notification_preferences ADD COLUMN email_security_change INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notification_preferences ADD COLUMN platform_feed_at_risk  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notification_preferences ADD COLUMN platform_agent_stalled INTEGER NOT NULL DEFAULT 1;
