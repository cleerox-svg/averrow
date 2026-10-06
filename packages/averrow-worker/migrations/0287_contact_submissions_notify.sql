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
-- for rate limiting and not stored. The rate limit lives in KV, so the column
-- is no longer written; clear what is already there. The column itself stays
-- (no DROP) and is always NULL from now on.
UPDATE contact_submissions SET ip_address = NULL WHERE ip_address IS NOT NULL;
