-- Averrow — account-synced appearance preferences (facelift P3-5)
--
-- Accent and background follow the user across devices, next to
-- theme_preference (0119) for light/dark.
--
--   accent_preference  'indigo' | 'violet' | 'mono' | 'lime'
--   base_preference    'graphite' | 'navy'
--
-- NULL = "use the platform default" (today the legacy look; after the
-- P3-6 flip, indigo / graphite).
--
-- Deliberately NO CHECK constraint: the accent list may grow, and widening
-- a CHECK on `users` needs a table rebuild, which is unsafe under D1's
-- enforced foreign keys. PATCH /api/profile validates against the exact
-- allowed lists (handlers/profile.ts) and is the only writer.
--
-- Additive only: two nullable columns, no backfill.

ALTER TABLE users ADD COLUMN accent_preference TEXT;
ALTER TABLE users ADD COLUMN base_preference   TEXT;
