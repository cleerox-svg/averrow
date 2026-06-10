-- 0214_takedown_reply_aliases.sql
-- S1 (docs/IMPROVEMENT_PLAN_2026-06.md) — dedicated takedown reply inbox.
--
-- The live email-send submitter (lib/takedown-submitters/email-send.ts)
-- sends abuse reports from takedowns@averrow.com with Reply-To the same
-- address. Register the alias on the platform self-org so provider
-- replies flow into the abuse-mailbox pipeline like the other public
-- aliases (migrations 0180/0182 pattern).
--
-- averrow.com mail stays on Google Workspace; averrow.ca is the CF
-- Email Routing relay (docs/EMAIL_ROUTING_RUNBOOK.md Path B). Both
-- aliases are registered so the Worker accepts the mail however it
-- arrives. OWNER ACTION required outside this migration: add the
-- Google Workspace forward takedowns@averrow.com → takedowns@averrow.ca
-- (same as the existing abuse@/report@/security@ forwards).

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'takedowns@averrow.com', 'Takedown reply inbox — Reply-To on outbound abuse reports (S1).'
FROM organizations WHERE slug = '_averrow_platform';

INSERT OR IGNORE INTO org_abuse_aliases (org_id, alias, forwarding_instructions)
SELECT id, 'takedowns@averrow.ca', 'averrow.ca relay for takedowns@averrow.com forwarded from Google Workspace.'
FROM organizations WHERE slug = '_averrow_platform';
