-- 0226_enable_takedown_api_providers.sql
-- Go-live: enable auto-submit for the three API submitter providers.
--
-- Paired with the wrangler.toml flip TAKEDOWN_SEND_MODE='live'. With both in
-- place, Sparrow Phase G auto-submits real abuse reports for takedowns whose
-- org has a signed auto-submit authorization policy:
--   * NetBeacon            → api_netbeacon submitter (registrar-routed)
--   * GoDaddy              → api_godaddy submitter (direct registrar)
--   * Google Safe Browsing → api_web_risk submitter (URL blocklist)
--
-- Kill switch: set TAKEDOWN_SEND_MODE back to 'draft' (global), or run
-- `UPDATE takedown_providers SET auto_submit_enabled = 0 WHERE provider_name = ?`
-- for a single provider.
--
-- Prerequisites the operator confirmed are configured (Worker secrets):
--   NETBEACON_API_KEY, GODADDY_API_KEY + GODADDY_API_SECRET,
--   GOOGLE_SERVICE_ACCOUNT_JSON. Each submitter still self-gates on its
--   credential, so an absent secret degrades to the email fallback rather
--   than erroring.

UPDATE takedown_providers
SET auto_submit_enabled = 1,
    updated_at = datetime('now')
WHERE provider_name IN ('NetBeacon', 'GoDaddy', 'Google Safe Browsing');
