-- SaaS Attack Techniques taxonomy
-- Source: github.com/pushsecurity/saas-attacks (CC-BY-4.0)
-- Attribution: PushSecurity (pushsecurity.com)
--
-- Adds the saas_techniques reference table + saas_technique_id FK on threats.
-- Seeds the taxonomy with techniques across 6 phases:
--   reconnaissance, initial_access, persistence,
--   credential_access, lateral_movement, exfiltration

CREATE TABLE IF NOT EXISTS saas_techniques (
  id              TEXT PRIMARY KEY,   -- e.g. "consent_phishing"
  name            TEXT NOT NULL,      -- e.g. "Consent Phishing"
  phase           TEXT NOT NULL,      -- e.g. "initial_access"
  phase_label     TEXT NOT NULL,      -- e.g. "Initial Access"
  description     TEXT,
  mitre_ttps      TEXT,               -- JSON array of T-codes, e.g. ["T1566.002"]
  detection_hints TEXT,               -- JSON array of Averrow signal types
  severity        TEXT DEFAULT 'medium', -- critical / high / medium / low
  source          TEXT DEFAULT 'pushsecurity/saas-attacks',
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_saas_techniques_phase ON saas_techniques(phase);

-- Add saas_technique_id to threats table
ALTER TABLE threats ADD COLUMN saas_technique_id TEXT REFERENCES saas_techniques(id);
CREATE INDEX IF NOT EXISTS idx_threats_saas_technique ON threats(saas_technique_id);

-- ─── Seed: Reconnaissance ─────────────────────────────────────────
INSERT OR IGNORE INTO saas_techniques
  (id, name, phase, phase_label, description, mitre_ttps, detection_hints, severity)
VALUES
  ('saml_enumeration', 'SAML Enumeration', 'reconnaissance', 'Reconnaissance',
   'Attackers enumerate SAML configurations to identify IdP providers, tenant names, and authentication flows before launching targeted attacks.',
   '["T1589","T1590"]', '["dns_lookup","subdomain_scan"]', 'low'),
  ('subdomain_tenant_discovery', 'Subdomain Tenant Discovery', 'reconnaissance', 'Reconnaissance',
   'Discovering cloud tenant names and subdomains to identify attack targets, often via DNS enumeration or brute-force of known subdomain patterns.',
   '["T1590.001"]', '["typosquat","subdomain_scan","lookalike_domain"]', 'medium'),
  ('slug_tenant_enumeration', 'Slug Tenant Enumeration', 'reconnaissance', 'Reconnaissance',
   'Enumerating SaaS tenant slugs (e.g., company.slack.com) to discover target organizations and their SaaS footprint.',
   '["T1590"]', '["typosquat","lookalike_domain"]', 'low'),
  ('dns_reconnaissance', 'DNS Reconnaissance', 'reconnaissance', 'Reconnaissance',
   'Using DNS records (MX, SPF, DKIM, TXT) to map a target organization''s SaaS stack and email infrastructure.',
   '["T1590.002"]', '["dns_lookup","mx_record","spf_record"]', 'low'),
  ('username_enumeration', 'Username Enumeration', 'reconnaissance', 'Reconnaissance',
   'Enumerating valid usernames/email addresses in SaaS applications through login error messages or account recovery flows.',
   '["T1589.003"]', '["phishing","email_harvest"]', 'medium');

-- ─── Seed: Initial Access ─────────────────────────────────────────
INSERT OR IGNORE INTO saas_techniques
  (id, name, phase, phase_label, description, mitre_ttps, detection_hints, severity)
VALUES
  ('consent_phishing', 'Consent Phishing', 'initial_access', 'Initial Access',
   'Tricking users into granting OAuth permissions to malicious applications, giving attackers persistent access without stealing credentials.',
   '["T1566.002","T1550.001"]', '["oauth_abuse","phishing","malicious_url"]', 'high'),
  ('poisoned_tenants', 'Poisoned Tenants', 'initial_access', 'Initial Access',
   'Creating malicious SaaS tenants that share collaboration features with target organizations to gain initial access.',
   '["T1566","T1199"]', '["typosquat","lookalike_domain","brand_impersonation"]', 'high'),
  ('samljacking', 'SAMLjacking', 'initial_access', 'Initial Access',
   'Exploiting SAML misconfigurations to impersonate users or gain unauthorized access to Service Providers.',
   '["T1606.002"]', '["saml_abuse","authentication_anomaly"]', 'critical'),
  ('account_ambushing', 'Account Ambushing', 'initial_access', 'Initial Access',
   'Pre-registering accounts on SaaS platforms using target email addresses before the victim signs up, enabling takeover when they do.',
   '["T1586"]', '["brand_impersonation","social_impersonation"]', 'high'),
  ('credential_stuffing', 'Credential Stuffing', 'initial_access', 'Initial Access',
   'Using breached credential databases to attempt login to SaaS applications at scale.',
   '["T1110.004"]', '["credential_abuse","login_anomaly"]', 'high'),
  ('app_spraying', 'App Spraying', 'initial_access', 'Initial Access',
   'Testing a single commonly-used password against many accounts across SaaS applications to avoid lockout detection.',
   '["T1110.003"]', '["password_spray","login_anomaly"]', 'high'),
  ('email_phishing', 'Email Phishing', 'initial_access', 'Initial Access',
   'Sending deceptive emails impersonating legitimate SaaS services to steal credentials or deliver malicious links.',
   '["T1566.001"]', '["phishing","email_threat","malicious_url","typosquat"]', 'high'),
  ('im_phishing', 'IM Phishing', 'initial_access', 'Initial Access',
   'Phishing via instant messaging platforms (Slack, Teams, Discord) — harder to detect than email, often bypasses email security controls.',
   '["T1566"]', '["social_impersonation","brand_impersonation"]', 'high'),
  ('im_user_spoofing', 'IM User Spoofing', 'initial_access', 'Initial Access',
   'Creating fake accounts on IM platforms that impersonate real people within or associated with the target organization.',
   '["T1656","T1566"]', '["social_impersonation","brand_impersonation"]', 'high'),
  ('aitm_phishing', 'AiTM Phishing', 'initial_access', 'Initial Access',
   'Adversary-in-the-Middle phishing that intercepts authentication traffic in real-time to steal session cookies, bypassing MFA.',
   '["T1557","T1539"]', '["malicious_url","phishing","reverse_proxy"]', 'critical'),
  ('device_code_phishing', 'Device Code Phishing', 'initial_access', 'Initial Access',
   'Abusing OAuth device authorization flows to trick users into authenticating attacker-controlled devices.',
   '["T1528","T1566"]', '["oauth_abuse","phishing"]', 'critical'),
  ('mfa_fatigue', 'MFA Fatigue', 'initial_access', 'Initial Access',
   'Bombarding users with MFA push notifications until they approve one out of frustration, granting the attacker access.',
   '["T1621"]', '["mfa_abuse","authentication_anomaly"]', 'high'),
  ('mfa_downgrade', 'MFA Downgrade', 'initial_access', 'Initial Access',
   'Exploiting SaaS application recovery flows to bypass MFA and access accounts with weaker authentication.',
   '["T1556","T1621"]', '["authentication_anomaly","mfa_abuse"]', 'critical'),
  ('verification_phishing', 'Verification Phishing', 'initial_access', 'Initial Access',
   'Impersonating platform verification processes (blue check, identity verification) to steal credentials or personal data.',
   '["T1566","T1656"]', '["social_impersonation","brand_impersonation","phishing"]', 'high'),
  ('noauth', 'nOAuth', 'initial_access', 'Initial Access',
   'Exploiting OAuth implementation flaws where email is used as a trusted identifier, enabling account takeover across platforms.',
   '["T1550.001","T1528"]', '["oauth_abuse","authentication_anomaly"]', 'critical'),
  ('hijack_oauth_flows', 'Hijack OAuth Flows', 'initial_access', 'Initial Access',
   'Intercepting OAuth authorization codes or tokens during the authentication flow to gain unauthorized access.',
   '["T1528","T1550.001"]', '["oauth_abuse","malicious_url"]', 'critical'),
  ('guest_access_abuse', 'Guest Access Abuse', 'initial_access', 'Initial Access',
   'Exploiting guest/external user features in collaboration platforms to gain unauthorized access to internal resources.',
   '["T1078","T1199"]', '["authentication_anomaly"]', 'medium'),
  ('cross_idp_impersonation', 'Cross-IdP Impersonation', 'initial_access', 'Initial Access',
   'Exploiting trust relationships between identity providers to impersonate users across federated systems.',
   '["T1606","T1656"]', '["authentication_anomaly","saml_abuse"]', 'critical'),
  ('ui_redressing', 'UI Redressing', 'initial_access', 'Initial Access',
   'Overlaying fake UI elements (clickjacking) on legitimate SaaS pages to trick users into performing unintended actions.',
   '["T1656"]', '["malicious_url","phishing"]', 'medium');

-- ─── Seed: Persistence ────────────────────────────────────────────
INSERT OR IGNORE INTO saas_techniques
  (id, name, phase, phase_label, description, mitre_ttps, detection_hints, severity)
VALUES
  ('oauth_tokens', 'OAuth Tokens', 'persistence', 'Persistence',
   'Using OAuth tokens (especially refresh tokens) as persistent backdoors that survive password changes.',
   '["T1550.001"]', '["oauth_abuse"]', 'high'),
  ('api_keys', 'API Keys', 'persistence', 'Persistence',
   'Creating or stealing API keys to maintain persistent access to SaaS platforms independent of user credentials.',
   '["T1528","T1552"]', '["api_key_abuse","credential_abuse"]', 'high'),
  ('evil_twin_integrations', 'Evil Twin Integrations', 'persistence', 'Persistence',
   'Installing malicious OAuth integrations that mimic legitimate ones to maintain persistent access to SaaS data.',
   '["T1550.001","T1199"]', '["oauth_abuse","malicious_url"]', 'high'),
  ('malicious_mail_rules', 'Malicious Mail Rules', 'persistence', 'Persistence',
   'Creating inbox rules that silently forward, delete, or redirect emails to maintain access and hide attacker activity.',
   '["T1114.003"]', '["email_threat"]', 'high'),
  ('ghost_logins', 'Ghost Logins', 'persistence', 'Persistence',
   'Using dormant or unmonitored accounts (former employees, service accounts) to maintain stealthy persistent access.',
   '["T1078"]', '["authentication_anomaly"]', 'medium'),
  ('inbound_federation', 'Inbound Federation', 'persistence', 'Persistence',
   'Configuring a malicious IdP as a trusted federation partner to gain persistent access via SAML or OIDC.',
   '["T1606","T1199"]', '["saml_abuse","authentication_anomaly"]', 'critical');

-- ─── Seed: Credential Access ──────────────────────────────────────
INSERT OR IGNORE INTO saas_techniques
  (id, name, phase, phase_label, description, mitre_ttps, detection_hints, severity)
VALUES
  ('password_scraping', 'Password Scraping', 'credential_access', 'Credential Access',
   'Extracting passwords from SaaS applications like password managers, wikis, or collaboration tools.',
   '["T1555","T1552"]', '["credential_abuse","data_exfiltration"]', 'critical'),
  ('api_secret_theft', 'API Secret Theft', 'credential_access', 'Credential Access',
   'Stealing API keys and secrets from code repositories, documentation, or SaaS configuration panels.',
   '["T1552.001"]', '["credential_abuse","api_key_abuse"]', 'critical'),
  ('session_cookie_theft', 'Session Cookie Theft', 'credential_access', 'Credential Access',
   'Stealing authenticated session tokens to bypass credentials and MFA entirely.',
   '["T1539"]', '["session_hijack","malicious_url"]', 'critical');

-- ─── Seed: Lateral Movement ───────────────────────────────────────
INSERT OR IGNORE INTO saas_techniques
  (id, name, phase, phase_label, description, mitre_ttps, detection_hints, severity)
VALUES
  ('in_app_phishing', 'In-App Phishing', 'lateral_movement', 'Lateral Movement',
   'Using trusted SaaS messaging features (Slack DMs, Teams messages) to send phishing links that bypass email security.',
   '["T1566"]', '["social_impersonation","brand_impersonation"]', 'high'),
  ('passwordless_logins', 'Passwordless Logins', 'lateral_movement', 'Lateral Movement',
   'Abusing magic link or one-time password flows to move laterally between SaaS accounts without knowing passwords.',
   '["T1078","T1550"]', '["authentication_anomaly"]', 'medium'),
  ('automation_workflow_sharing', 'Automation Workflow Sharing', 'lateral_movement', 'Lateral Movement',
   'Sharing malicious automation workflows (Zapier, Make, Power Automate) that execute in the target''s context.',
   '["T1072"]', '["oauth_abuse"]', 'high');

-- ─── Seed: Exfiltration ───────────────────────────────────────────
INSERT OR IGNORE INTO saas_techniques
  (id, name, phase, phase_label, description, mitre_ttps, detection_hints, severity)
VALUES
  ('takeout_services', 'Takeout Services', 'exfiltration', 'Exfiltration',
   'Using legitimate data export features (Google Takeout, Slack export) to exfiltrate large volumes of data.',
   '["T1567"]', '["data_exfiltration"]', 'critical'),
  ('webhooks_exfil', 'Webhooks', 'exfiltration', 'Exfiltration',
   'Configuring SaaS webhooks to automatically send data to attacker-controlled endpoints.',
   '["T1567","T1020"]', '["data_exfiltration","c2_communication"]', 'high');
