-- 0194_lower_default_push_severity_floor_for_staff.sql
--
-- The default `push_severity_floor='high'` (set in migration 0127's
-- column DEFAULT and PREF_V2_DEFAULTS in handlers/notifications.ts)
-- filters out ~95% of operator notifications. Production audit on
-- 2026-05-16 showed 262 medium-severity / 9 high / 1 critical in 12h
-- — staff using the default never see anything below 'high'.
--
-- Industry standard for operator tooling (Linear, PagerDuty, GitHub)
-- is default-low or default-info: users opt OUT of noisy types via
-- per-event toggles, they don't opt IN to seeing anything at all.
--
-- This migration:
--   1. Backfills staff rows (role != 'client') where push_severity_floor
--      is still 'high' AND the row was auto-seeded (no explicit user
--      action — heuristic: critical_bypasses_quiet still at default 1
--      AND no quiet_hours_start set) → set to 'low'.
--   2. App-side PREF_V2_DEFAULTS + the auto-seed INSERT change in
--      handlers/notifications.ts to 'low' so new rows start there too.
--      (Column DEFAULT stays 'high' for migration-history fidelity;
--      every new row goes through the auto-seed explicit INSERT.)
--
-- Tenant client users keep their existing setting — they may
-- intentionally want only high+critical pushes for their brand
-- signals. This change is scoped to staff (the ones whose UX
-- audit revealed the issue).

UPDATE notification_preferences_v2
   SET push_severity_floor = 'low',
       updated_at = datetime('now')
 WHERE push_severity_floor = 'high'
   AND user_id IN (
     SELECT id FROM users
      WHERE role IN ('super_admin','admin','analyst','sales','support','billing')
        AND status = 'active'
   )
   -- Heuristic for "never customized": critical_bypasses_quiet still at
   -- its default (1) AND no quiet_hours configured. A user who explicitly
   -- set push_severity_floor='high' also likely tuned at least one of
   -- those — skip them so we don't undo intentional config.
   AND COALESCE(critical_bypasses_quiet, 1) = 1
   AND COALESCE(quiet_hours_start, '') = '';
