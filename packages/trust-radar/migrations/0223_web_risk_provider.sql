-- 0223_web_risk_provider.sql
-- First provider-API submitter: Google Web Risk Submission API.
--
-- The 'Google Safe Browsing' provider row (seeded in 0046) carried
-- abuse_api_type='rest' as a placeholder. The webRiskSubmitter
-- (lib/takedown-submitters/web-risk.ts) selects providers by
-- abuse_api_type='web_risk', so flip the marker and set the API base URL.
--
-- auto_submit_enabled stays 0 (the 0152 default): an operator flips it to 1
-- only after (a) the GOOGLE_SERVICE_ACCOUNT_JSON secret is configured, (b)
-- the GCP project is allow-listed by Google for the Web Risk Submission API,
-- and (c) a verification submission succeeds in TAKEDOWN_SEND_MODE='live'.
-- Until then the dispatcher falls back to the email channel.

UPDATE takedown_providers
SET abuse_api_type = 'web_risk',
    abuse_api_url  = 'https://webrisk.googleapis.com',
    updated_at     = datetime('now')
WHERE provider_name = 'Google Safe Browsing';
