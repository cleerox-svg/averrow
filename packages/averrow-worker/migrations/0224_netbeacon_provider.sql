-- 0224_netbeacon_provider.sql
-- NetBeacon (DNS Abuse Institute) registrar-routed abuse-report submitter.
--
-- NetBeacon is an aggregator: one API normalizes the report to X-ARF,
-- enriches it, and routes it to the correct participating registrar/registry.
-- It's the channel for domain takedowns. The netbeaconSubmitter
-- (lib/takedown-submitters/netbeacon.ts) selects on abuse_api_type='netbeacon'.
--
-- provider_type='reporting' (like Google Safe Browsing / APWG): NetBeacon is
-- a clearinghouse, not the registrar/host itself. abuse_api_url is the default
-- base, overridable at runtime via the NETBEACON_API_BASE env var once the
-- exact onboarded endpoint is known.
--
-- auto_submit_enabled stays 0: an operator flips it to 1 only after the
-- NETBEACON_API_KEY secret is set, the reporter account is approved by the DNS
-- Abuse Institute, and a verification report succeeds in
-- TAKEDOWN_SEND_MODE='live'. Until then the dispatcher falls back to email.

INSERT OR IGNORE INTO takedown_providers
  (provider_name, provider_type, abuse_email, abuse_url, abuse_api_url, abuse_api_type)
VALUES
  ('NetBeacon', 'reporting', NULL, 'https://netbeacon.org/reporting/',
   'https://api.netbeacon.org', 'netbeacon');
