-- 0281_notification_prefs_v2_quiet_hours_backfill.sql
--
-- Account redesign, Phase 3 (owner decision D4): notification preferences
-- consolidate on notification_preferences_v2. The settings UI now reads and
-- writes quiet hours (start, end, timezone, critical breakthrough) on v2 only.
-- Until now the ops page wrote the window to the legacy notification_preferences
-- columns (migration 0106), so users who configured quiet hours there would
-- see an empty window in the new UI and — worse — lose it the first time they
-- saved a v2 window. This copies the legacy window across once.
--
-- Rules (see lib/notifications.ts resolveQuietHours, which keeps the legacy
-- columns as a read fallback for one release):
--   1. A "complete" window = non-empty start AND non-empty end.
--   2. Only users with a complete legacy window AND no complete v2 window are
--      touched. An existing complete v2 window is never overwritten.
--   3. critical_bypasses_quiet is never changed on an existing v2 row. The
--      effective flag today is "v2 if a v2 row exists, else legacy", so:
--        - existing v2 row  -> flag untouched
--        - new v2 row       -> seeded from the legacy critical_breakthrough,
--                              which is exactly what the user had before.
--   4. A missing v2 row is inserted with the PREF_V2_DEFAULTS values from
--      handlers/notifications.ts, with two deliberate carry-overs so delivery
--      does not change for that user: push_severity_floor mirrors their legacy
--      push_notifications toggle ('low' when on, 'off' when off — the delivery
--      gate falls back to that toggle only while no v2 row exists), and the
--      flag in rule 3. (0127 seeded every active user and GET /preferences/v2
--      auto-seeds, so this branch is rare.)
--   5. Timezone: the legacy tz when it is non-empty, else the v2 value (the
--      NOT NULL default 'UTC' for a new row).
--
-- Idempotent: a second run finds every window complete and changes nothing.
-- Set-based statements only (NOT EXISTS / ON CONFLICT DO NOTHING), no
-- application-side SELECT-then-INSERT.

-- 1. Users with a complete legacy window and no v2 row at all.
INSERT INTO notification_preferences_v2 (
  user_id,
  inapp_severity_floor, push_severity_floor, email_severity_floor,
  digest_mode, digest_severity_floor,
  quiet_hours_start, quiet_hours_end, quiet_hours_timezone,
  critical_bypasses_quiet, show_tenant_notifications,
  cadence_intel, cadence_platform
)
SELECT
  p.user_id,
  'info',
  CASE WHEN p.push_notifications = 1 THEN 'low' ELSE 'off' END,
  'high',
  'daily', 'medium',
  p.quiet_hours_start, p.quiet_hours_end,
  COALESCE(NULLIF(p.quiet_hours_tz, ''), 'UTC'),
  CASE WHEN p.critical_breakthrough = 1 THEN 1 ELSE 0 END,
  0,
  'realtime', 'realtime'
FROM notification_preferences p
WHERE COALESCE(p.quiet_hours_start, '') <> ''
  AND COALESCE(p.quiet_hours_end, '') <> ''
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id)
  AND NOT EXISTS (SELECT 1 FROM notification_preferences_v2 v WHERE v.user_id = p.user_id)
ON CONFLICT(user_id) DO NOTHING;

-- 2. Users whose v2 row exists but has no complete window.
UPDATE notification_preferences_v2
   SET quiet_hours_start = (
         SELECT p.quiet_hours_start FROM notification_preferences p
          WHERE p.user_id = notification_preferences_v2.user_id),
       quiet_hours_end = (
         SELECT p.quiet_hours_end FROM notification_preferences p
          WHERE p.user_id = notification_preferences_v2.user_id),
       quiet_hours_timezone = COALESCE(
         (SELECT NULLIF(p.quiet_hours_tz, '') FROM notification_preferences p
           WHERE p.user_id = notification_preferences_v2.user_id),
         quiet_hours_timezone),
       updated_at = datetime('now')
 WHERE (COALESCE(quiet_hours_start, '') = '' OR COALESCE(quiet_hours_end, '') = '')
   AND EXISTS (
     SELECT 1 FROM notification_preferences p
      WHERE p.user_id = notification_preferences_v2.user_id
        AND COALESCE(p.quiet_hours_start, '') <> ''
        AND COALESCE(p.quiet_hours_end, '') <> ''
   );
