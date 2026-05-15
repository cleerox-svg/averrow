-- Wave 2.1 PR-AF — seed_domains config table.
--
-- The audit recommended expanding the seed-domain footprint from 3 to
-- 20 throwaway domains (Project Honey Pot's distributed-bait pattern).
-- The auto-seeder's TARGETS list was hardcoded in src/agents/auto-seeder.ts
-- to averrow.com:/admin-portal and averrow.com:/internal-staff only —
-- a 2-entry list — even though Wave 2 PR-AC extended page-serving to
-- all four production domains × four bait paths.
--
-- This table makes the seeding plan operator-editable without code
-- changes. New domain? INSERT a row. Want to pause seeding to a
-- specific domain? UPDATE status='paused'. The auto-seeder reads
-- WHERE status='active' on every tick.
--
-- pages: comma-separated list of bait-page paths to seed on this
--        domain. Keep in sync with src/index.ts's HONEYPOT_HOSTNAMES +
--        per-path handlers + robots-sitemap.ts Disallow list. The
--        four default paths below match what src/index.ts serves on
--        every production domain as of PR-AC.

CREATE TABLE IF NOT EXISTS seed_domains (
  domain         TEXT PRIMARY KEY,
  status         TEXT NOT NULL DEFAULT 'active',
  added_at       TEXT NOT NULL DEFAULT (datetime('now')),
  added_by       TEXT,
  notes          TEXT,
  pages          TEXT NOT NULL DEFAULT '/admin-portal,/internal-staff,/team-directory,/staff-contacts',
  seeds_per_page INTEGER NOT NULL DEFAULT 6
);

CREATE INDEX IF NOT EXISTS idx_seed_domains_status
  ON seed_domains(status);

-- Seed the four production domains we already serve bait pages on
-- (PR-AC widened src/index.ts's hostname check to all four). Backfills
-- the auto-seeder so its next tick iterates the full set instead of
-- just averrow.com.
INSERT OR IGNORE INTO seed_domains (domain, status, added_by, notes)
VALUES
  ('averrow.com',     'active', 'migration_0181',
   'Primary marketing domain. Already serving /admin-portal + /internal-staff + /team-directory + /staff-contacts.'),
  ('averrow.ca',      'active', 'migration_0181',
   'Canadian-market mirror. Bait pages widened to this domain in PR-AC.'),
  ('trustradar.ca',   'active', 'migration_0181',
   'Trust-Radar brand domain. Bait pages widened in PR-AC.'),
  ('lrxradar.com',    'active', 'migration_0181',
   'Parent (LRX Enterprises) domain. Bait pages widened in PR-AC.');
