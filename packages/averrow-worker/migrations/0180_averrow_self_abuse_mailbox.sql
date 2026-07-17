-- PR-AA: Averrow self abuse mailbox.
--
-- The marketing site already advertises `phishing@averrow.com` and
-- `abuse@averrow.com` on the report-abuse.astro page, but the email
-- worker (src/index.ts) only routed dashed prefixes (`verify-<t>`,
-- `abuse-<t>`, `report-<t>`) to the abuse-mailbox handler. Bare
-- `abuse@`/`phishing@`/`report@` were falling through to the spam-trap
-- pipeline — captures landing but not appearing in the abuse-mailbox
-- surface.
--
-- This migration:
--   1. Creates a synthetic "Averrow Platform" organization with the
--      reserved slug `_averrow_platform`. The leading underscore is
--      the convention for system-reserved orgs (cannot collide with
--      customer slugs since slug regex forbids leading underscore).
--   2. Seeds `org_abuse_aliases` rows binding the marketing-advertised
--      mailbox addresses (abuse@, phishing@, report@, security@) on
--      all four production domains to that self-org.
--
-- The existing handleAbuseMailboxEmail handler looks up aliases by
-- exact string match against org_abuse_aliases — once the rows exist,
-- inbound mail to abuse@averrow.com is handled identically to a
-- tenant's verify-<tenant>@ alias. No handler code change required.
--
-- The companion code change in src/index.ts widens the routing
-- predicate to also match these well-known bare mailbox names.

-- ─── 1. Self-org row ──────────────────────────────────────────────
INSERT OR IGNORE INTO organizations
  (name, slug, plan, status, max_brands, max_members)
VALUES
  ('Averrow Platform', '_averrow_platform', 'enterprise', 'active', 999, 999);

-- ─── 2. Alias rows (one per mailbox × production domain) ──────────
-- INSERT OR IGNORE because org_abuse_aliases.alias has a UNIQUE
-- constraint and we want this migration to be re-runnable. The
-- forwarding_instructions field carries the operator-facing copy
-- shown in the admin UI.

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id,
       'abuse@averrow.com',
       'Public abuse mailbox — receives reports from the report-abuse.astro marketing page. Every submission is classified by Haiku, severity-scored, and visible on /admin/abuse-mailbox. Treat as an open-channel spam trap as well as a customer-service channel.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'phishing@averrow.com', 'Public phishing-report mailbox — same pipeline as abuse@, used by the report-abuse marketing page for phishing-specific reports.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'report@averrow.com', 'Public general-report mailbox — same pipeline as abuse@/phishing@.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'security@averrow.com', 'Public security-disclosure mailbox — receives vulnerability reports + general security inquiries. Same classification pipeline.'
FROM organizations WHERE slug = '_averrow_platform';

-- Mirror on averrow.ca (Canadian-market domain).
INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'abuse@averrow.ca',    'averrow.ca mirror of abuse@averrow.com — same pipeline.'    FROM organizations WHERE slug = '_averrow_platform';
INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'phishing@averrow.ca', 'averrow.ca mirror of phishing@averrow.com — same pipeline.' FROM organizations WHERE slug = '_averrow_platform';

-- Mirror on trustradar.ca + lrxradar.com (additional production routes).
INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'abuse@trustradar.ca',    'trustradar.ca mirror of abuse@averrow.com.'    FROM organizations WHERE slug = '_averrow_platform';
INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'phishing@trustradar.ca', 'trustradar.ca mirror of phishing@averrow.com.' FROM organizations WHERE slug = '_averrow_platform';
INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'abuse@lrxradar.com',     'lrxradar.com mirror of abuse@averrow.com.'     FROM organizations WHERE slug = '_averrow_platform';
INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'phishing@lrxradar.com',  'lrxradar.com mirror of phishing@averrow.com.'  FROM organizations WHERE slug = '_averrow_platform';
