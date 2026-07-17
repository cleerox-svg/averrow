-- ─── Quiet hours + critical breakthrough on notification_preferences ──
-- Additive columns on the existing per-user prefs table. The legacy flat
-- event toggles (brand_threat / campaign_escalation / etc.) and channel
-- toggles (browser_notifications / push_notifications) stay exactly as
-- they are — this PR does NOT migrate to a matrix table. That work is
-- folded into PR 3b alongside the UI rebuild.
--
-- New columns (all nullable / default-OFF):
--   quiet_hours_start      'HH:MM' (24-hour) or NULL = no DND configured
--   quiet_hours_end        'HH:MM' or NULL
--   quiet_hours_tz         IANA timezone, e.g. 'America/Toronto'
--                          falls back to UTC if NULL or invalid
--   critical_breakthrough  0/1 — when 1, severity=critical events break
--                          through quiet hours; when 0 (default) they
--                          respect DND like everything else
--
-- Suppression policy implemented in the dispatcher:
--   - Quiet hours suppress PUSH only — the in-app row always writes,
--     so the bell icon still surfaces the event when the user opens the
--     app. This matches FarmTrack's pattern + the iOS UX expectation
--     (DND silences the phone, doesn't drop the message).

ALTER TABLE notification_preferences ADD COLUMN quiet_hours_start    TEXT;
ALTER TABLE notification_preferences ADD COLUMN quiet_hours_end      TEXT;
ALTER TABLE notification_preferences ADD COLUMN quiet_hours_tz       TEXT;
ALTER TABLE notification_preferences ADD COLUMN critical_breakthrough INTEGER NOT NULL DEFAULT 0;
