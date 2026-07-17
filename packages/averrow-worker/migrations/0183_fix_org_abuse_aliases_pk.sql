-- Fix org_abuse_aliases PK — alias should be PK, not org_id.
--
-- Bug introduced in 0150_abuse_mailbox.sql:
--   CREATE TABLE org_abuse_aliases (
--     org_id INTEGER PRIMARY KEY REFERENCES organizations(id) ...,
--     alias  TEXT NOT NULL UNIQUE,
--     ...
--   );
--
-- `org_id INTEGER PRIMARY KEY` collapses org_id to the SQLite ROWID,
-- meaning physically only ONE row per org_id is allowed. Every INSERT
-- after the first for a given org hits the PK conflict and is silently
-- swallowed by INSERT OR IGNORE. This was invisible for tenants (each
-- tenant only needs one alias — verify-acme@...) but broke the Averrow
-- self-org case (12 public mailboxes for the same self-org).
--
-- Symptom in production:
--   - 0180 + 0182 both recorded as applied in d1_migrations
--   - But only the FIRST alias from 0180 actually landed (abuse@averrow.com)
--   - Mail to phishing@/report@/security@ silently dropped because
--     the alias-lookup found no row
--
-- This migration recreates the table with `alias` as PRIMARY KEY and
-- preserves all existing rows. Composite (org_id, alias) would also
-- work but `alias` alone is sufficient since aliases are globally
-- unique (one alias address = one org).
--
-- Operator note: today's prod environment was fixed manually via the
-- D1 Console before this migration shipped. Running this migration
-- against an already-fixed environment is a no-op (the CREATE TABLE
-- _new succeeds, the swap happens cleanly because rows match).
-- Running against an unfixed staging/dev environment performs the
-- fix.
--
-- Migration is *destructive in the swap* (DROP TABLE) but data-
-- preserving — every row is copied to the new table before the old
-- one is dropped. Verified via the same recreate-pattern Wrangler
-- uses for its own table migrations.

CREATE TABLE IF NOT EXISTS org_abuse_aliases_new (
  alias                   TEXT PRIMARY KEY,
  org_id                  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  forwarding_instructions TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_org_abuse_aliases_new_org
  ON org_abuse_aliases_new(org_id);

INSERT OR IGNORE INTO org_abuse_aliases_new (alias, org_id, forwarding_instructions, created_at, updated_at)
SELECT alias, org_id, forwarding_instructions, created_at, updated_at
FROM org_abuse_aliases;

DROP TABLE org_abuse_aliases;
ALTER TABLE org_abuse_aliases_new RENAME TO org_abuse_aliases;

-- Re-create index under the canonical name now that the table has been renamed.
-- The index from the _new table renames automatically with the table in SQLite,
-- but we also want the canonical name so subsequent migrations / queries can
-- reason about it.
DROP INDEX IF EXISTS idx_org_abuse_aliases_new_org;
CREATE INDEX IF NOT EXISTS idx_org_abuse_aliases_org
  ON org_abuse_aliases(org_id);

-- Re-seed the 12 expected Averrow self-org aliases. INSERT OR IGNORE
-- so this is idempotent — running it against the already-fixed prod
-- where the 12 rows exist is a no-op.
INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'abuse@averrow.com',     'Public abuse mailbox on averrow.com.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'phishing@averrow.com',  'Public phishing-report mailbox on averrow.com.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'report@averrow.com',    'Public general-report mailbox on averrow.com.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'security@averrow.com',  'Public security-disclosure mailbox on averrow.com.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'abuse@averrow.ca',      'averrow.ca relay for abuse@ — public-facing on this domain.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'phishing@averrow.ca',   'averrow.ca relay for phishing@ — public-facing on this domain.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'report@averrow.ca',     'averrow.ca relay for report@ — public-facing on this domain.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'security@averrow.ca',   'averrow.ca relay for security@ — public-facing on this domain.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'abuse@trustradar.ca',    'trustradar.ca mirror — available for future use.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'phishing@trustradar.ca', 'trustradar.ca mirror — available for future use.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'abuse@lrxradar.com',     'lrxradar.com mirror — available for future use.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'phishing@lrxradar.com',  'lrxradar.com mirror — available for future use.'
FROM organizations WHERE slug = '_averrow_platform';
