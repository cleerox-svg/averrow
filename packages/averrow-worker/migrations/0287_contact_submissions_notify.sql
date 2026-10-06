-- Contact/demo submissions reach a person (DISCLOSURE_REGISTER G33) and stop
-- storing the sender's IP address (G38).
--
-- Additive columns only (CLAUDE.md §8: never DROP/ALTER existing columns):
--   domain         optional company domain the demo form sends, normalised
--                  with normalizePublicHostname before it is stored.
--   notified_at    when the staff notification email was accepted by Resend;
--                  NULL = not sent.
--   notify_status  outcome of that email: 'sent' | 'failed' | 'capped' |
--                  'cap_error'. NULL on rows written before this migration.
--   handled_at     when a staff member marked the submission handled
--                  (PATCH /api/admin/contact-submissions/:id); NULL = open.
--   handled_by     users.id of that staff member.
ALTER TABLE contact_submissions ADD COLUMN domain TEXT;
ALTER TABLE contact_submissions ADD COLUMN notified_at TEXT;
ALTER TABLE contact_submissions ADD COLUMN notify_status TEXT;
ALTER TABLE contact_submissions ADD COLUMN handled_at TEXT;
ALTER TABLE contact_submissions ADD COLUMN handled_by TEXT;

-- G38 (owner-approved): the privacy policy says the IP is used only briefly
-- for rate limiting and not stored. The rate limit keys on the IP transiently
-- (contact_rate below holds only a window-scoped key), so the column
-- is no longer written; clear what is already there. The column itself stays
-- (no DROP) and is always NULL from now on.
UPDATE contact_submissions SET ip_address = NULL WHERE ip_address IS NOT NULL;

-- Atomic counters for the public contact form (PR #1808 review M1/M2).
-- Replaces two KV read-check-write counters, which raced and, at KV's ~1
-- write/sec/key limit, made a second submission in the same second fail
-- closed and lose its email. One statement per bump:
--   INSERT ... ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n
-- Keys are window-scoped, so a key is never reused after it expires:
--   contact:ip:<ip or IPv6 /64>:<unix hour>  per-IP submission limit (1h)
--   contact:notify:<YYYY-MM-DD>              staff emails sent that UTC day
--   contact:notify-cap-notice:<YYYY-MM-DD>   "daily cap reached" notice sent
-- expires_at is `YYYY-MM-DD HH:MM:SS` UTC (SQLite datetime() format) so the
-- purge compares it to datetime('now'). Expired rows are deleted in bounded
-- batches from Navigator's hour-0 block (lib/contact-rate.ts).
CREATE TABLE IF NOT EXISTS contact_rate (
  key        TEXT PRIMARY KEY,
  n          INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_rate_expires_at ON contact_rate(expires_at);
