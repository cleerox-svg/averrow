-- Wave 2.1 follow-up — extend averrow.ca abuse aliases.
--
-- Migration 0180 seeded abuse@/phishing@/report@/security@ for
-- averrow.com but only abuse@/phishing@ for averrow.ca. Now that
-- averrow.ca is the chosen CF Email Routing relay (averrow.com
-- stays on Google Workspace; averrow.ca catches the forwarded
-- copies and routes to the Worker), add the remaining two so
-- forwarded mail to report@ and security@ also lands.
--
-- See docs/EMAIL_ROUTING_RUNBOOK.md for the full Path B setup.

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'report@averrow.ca',   'averrow.ca relay for report@averrow.com forwarded from Google Workspace.'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'security@averrow.ca', 'averrow.ca relay for security@averrow.com forwarded from Google Workspace.'
FROM organizations WHERE slug = '_averrow_platform';
