-- Trust Radar v2 — User profile fields
--
-- Adds the columns needed for the FarmTrack ↔ Averrow login
-- standardization. Background:
--
--   display_name      User-editable label that overrides the Google
--                     `name` claim. Drives the avatar initials rule
--                     ("Claude Leroux" → "CL"). Falls back to `name`
--                     for users who haven't set one.
--
--   timezone          IANA timezone (e.g. "America/Toronto"). Used by
--                     Quiet Hours and morning-briefing scheduling.
--                     NULL means "auto-detect from browser."
--
--   theme_preference  'dark' | 'light'. Persists the theme toggle so
--                     it survives a fresh install. NULL means
--                     "follow the OS / app default."
--
-- All three are optional from the user's perspective; the UI provides
-- sensible defaults when NULL. We intentionally don't seed timezone
-- or theme_preference — the client will populate them on first use.
--
-- We DO seed display_name from the existing `name` column so the
-- avatar rule has something to parse for users who signed up before
-- this migration shipped.

ALTER TABLE users ADD COLUMN display_name      TEXT;
ALTER TABLE users ADD COLUMN timezone          TEXT;
ALTER TABLE users ADD COLUMN theme_preference  TEXT
  CHECK (theme_preference IS NULL OR theme_preference IN ('dark', 'light'));

-- Seed display_name from name. Future signups will set both fields
-- on insert (Google name → both columns) so this only runs once.
UPDATE users SET display_name = name WHERE display_name IS NULL AND name IS NOT NULL;
