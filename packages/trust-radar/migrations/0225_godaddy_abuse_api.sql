-- 0225_godaddy_abuse_api.sql
-- GoDaddy Abuse API submitter — the one major registrar with a real
-- authenticated abuse-reporting REST API.
--
-- The 'GoDaddy' provider row (seeded in 0046) was abuse_api_type='form'.
-- Flip it to 'godaddy' so the godaddySubmitter (lib/takedown-submitters/
-- godaddy.ts) selects it, and set the API base URL. abuse_email
-- ('abuse@godaddy.com') is intentionally LEFT in place: when the API
-- credentials aren't configured the dispatcher falls back to that email,
-- so a GoDaddy-registered domain is never stranded.
--
-- auto_submit_enabled stays 0: an operator flips it to 1 only after the
-- GODADDY_API_KEY + GODADDY_API_SECRET secrets are set and a verification
-- ticket succeeds (against the OTE sandbox via GODADDY_API_BASE, then prod).

UPDATE takedown_providers
SET abuse_api_type = 'godaddy',
    abuse_api_url  = 'https://api.godaddy.com',
    updated_at     = datetime('now')
WHERE provider_name = 'GoDaddy';
