-- 0193_notification_preferences_cadence_and_mutes.sql
--
-- NX5 (RESTRUCTURE_SPEC.md § NOTIFICATIONS RESTRUCTURE).
--
-- Two additions to support the rebuilt preferences UI:
--
-- 1. **Per-group cadence** on notification_preferences_v2. The existing
--    `digest_mode` column is a single global cadence — applies to all
--    digestable events. NX5's three-section model wants distinct
--    cadences per audience group:
--
--      cadence_intel    — intel_*, abuse_mailbox_*, news_watcher
--      cadence_platform — platform_* (mandatory; the cadence here only
--                         affects whether they batch into a digest, NOT
--                         whether they fire — they always do)
--
--    Tenant-targeted brand events (brand_threat, email_security_change,
--    lookalike_*, etc.) keep using digest_mode + digest_severity_floor
--    since tenants control those independently.
--
-- 2. **Per-type mutes** via a new `notification_type_mutes` table.
--    Lets a super admin silence a specific notification type for N hours
--    during an incident (e.g. "shut up about feed_health while we
--    rebuild the upstream feed"). Producers continue firing; the mute
--    is checked at recipient resolution time so deliveries are
--    suppressed without dropping the underlying audit row.

-- ── Cadence columns ──────────────────────────────────────────────────
ALTER TABLE notification_preferences_v2 ADD COLUMN cadence_intel TEXT
  NOT NULL DEFAULT 'realtime'
  CHECK (cadence_intel IN ('realtime', 'daily_digest', 'weekly_digest'));

ALTER TABLE notification_preferences_v2 ADD COLUMN cadence_platform TEXT
  NOT NULL DEFAULT 'realtime'
  CHECK (cadence_platform IN ('realtime', 'daily_digest', 'weekly_digest'));

-- ── Per-type mutes ───────────────────────────────────────────────────
-- One row per (user_id, type) combination. user_id NULL = system-wide
-- mute (super admin can silence a type for everyone). muted_until is a
-- hard expiry — the mute self-clears, no cron needed.
CREATE TABLE IF NOT EXISTS notification_type_mutes (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,                      -- NULL = system-wide (super_admin only)
  type         TEXT NOT NULL,             -- NotificationEventKey
  muted_until  TEXT NOT NULL,             -- ISO-8601, expires past this
  reason       TEXT,                      -- optional human note for the audit
  created_by   TEXT NOT NULL,             -- user_id of the muter
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_type_mutes_user_type
  ON notification_type_mutes(COALESCE(user_id, ''), type);

CREATE INDEX IF NOT EXISTS idx_notif_type_mutes_active
  ON notification_type_mutes(muted_until)
  WHERE muted_until > datetime('now');
