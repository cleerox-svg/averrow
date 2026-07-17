// SaaS Attack Techniques — seed data + runtime mapping tables.
// Source:      github.com/pushsecurity/saas-attacks (CC-BY-4.0)
// Attribution: PushSecurity (pushsecurity.com)
//
// The canonical seed lives in migration 0065_saas_techniques.sql; this file
// mirrors it as typed constants so the classifier + UI scaffolding can reason
// about techniques without a DB round-trip.

export interface SaasTechnique {
  id:              string;
  name:            string;
  phase:           string;
  phase_label:     string;
  description:     string;
  mitre_ttps:      string[];
  detection_hints: string[]; // Averrow signal types that indicate this technique
  severity:        "critical" | "high" | "medium" | "low";
}

export const SAAS_TECHNIQUES: SaasTechnique[] = [
  // ── RECONNAISSANCE ──────────────────────────────────────────────
  {
    id: "saml_enumeration",
    name: "SAML Enumeration",
    phase: "reconnaissance", phase_label: "Reconnaissance",
    description: "Attackers enumerate SAML configurations to identify IdP providers, tenant names, and authentication flows before launching targeted attacks.",
    mitre_ttps: ["T1589", "T1590"],
    detection_hints: ["dns_lookup", "subdomain_scan"],
    severity: "low",
  },
  {
    id: "subdomain_tenant_discovery",
    name: "Subdomain Tenant Discovery",
    phase: "reconnaissance", phase_label: "Reconnaissance",
    description: "Discovering cloud tenant names and subdomains to identify attack targets, often via DNS enumeration or brute-force of known subdomain patterns.",
    mitre_ttps: ["T1590.001"],
    detection_hints: ["typosquat", "subdomain_scan", "lookalike_domain"],
    severity: "medium",
  },
  {
    id: "slug_tenant_enumeration",
    name: "Slug Tenant Enumeration",
    phase: "reconnaissance", phase_label: "Reconnaissance",
    description: "Enumerating SaaS tenant slugs (e.g., company.slack.com) to discover target organizations and their SaaS footprint.",
    mitre_ttps: ["T1590"],
    detection_hints: ["typosquat", "lookalike_domain"],
    severity: "low",
  },
  {
    id: "dns_reconnaissance",
    name: "DNS Reconnaissance",
    phase: "reconnaissance", phase_label: "Reconnaissance",
    description: "Using DNS records (MX, SPF, DKIM, TXT) to map a target organization's SaaS stack and email infrastructure.",
    mitre_ttps: ["T1590.002"],
    detection_hints: ["dns_lookup", "mx_record", "spf_record"],
    severity: "low",
  },
  {
    id: "username_enumeration",
    name: "Username Enumeration",
    phase: "reconnaissance", phase_label: "Reconnaissance",
    description: "Enumerating valid usernames/email addresses in SaaS applications through login error messages or account recovery flows.",
    mitre_ttps: ["T1589.003"],
    detection_hints: ["phishing", "email_harvest"],
    severity: "medium",
  },

  // ── INITIAL ACCESS ───────────────────────────────────────────────
  {
    id: "consent_phishing",
    name: "Consent Phishing",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Tricking users into granting OAuth permissions to malicious applications, giving attackers persistent access without stealing credentials.",
    mitre_ttps: ["T1566.002", "T1550.001"],
    detection_hints: ["oauth_abuse", "phishing", "malicious_url"],
    severity: "high",
  },
  {
    id: "poisoned_tenants",
    name: "Poisoned Tenants",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Creating malicious SaaS tenants that share collaboration features with target organizations to gain initial access.",
    mitre_ttps: ["T1566", "T1199"],
    detection_hints: ["typosquat", "lookalike_domain", "brand_impersonation"],
    severity: "high",
  },
  {
    id: "samljacking",
    name: "SAMLjacking",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Exploiting SAML misconfigurations to impersonate users or gain unauthorized access to Service Providers.",
    mitre_ttps: ["T1606.002"],
    detection_hints: ["saml_abuse", "authentication_anomaly"],
    severity: "critical",
  },
  {
    id: "account_ambushing",
    name: "Account Ambushing",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Pre-registering accounts on SaaS platforms using target email addresses before the victim signs up, enabling takeover when they do.",
    mitre_ttps: ["T1586"],
    detection_hints: ["brand_impersonation", "social_impersonation"],
    severity: "high",
  },
  {
    id: "credential_stuffing",
    name: "Credential Stuffing",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Using breached credential databases to attempt login to SaaS applications at scale.",
    mitre_ttps: ["T1110.004"],
    detection_hints: ["credential_abuse", "login_anomaly"],
    severity: "high",
  },
  {
    id: "app_spraying",
    name: "App Spraying",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Testing a single commonly-used password against many accounts across SaaS applications to avoid lockout detection.",
    mitre_ttps: ["T1110.003"],
    detection_hints: ["password_spray", "login_anomaly"],
    severity: "high",
  },
  {
    id: "email_phishing",
    name: "Email Phishing",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Sending deceptive emails impersonating legitimate SaaS services to steal credentials or deliver malicious links.",
    mitre_ttps: ["T1566.001"],
    detection_hints: ["phishing", "email_threat", "malicious_url", "typosquat"],
    severity: "high",
  },
  {
    id: "im_phishing",
    name: "IM Phishing",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Phishing via instant messaging platforms (Slack, Teams, Discord) — harder to detect than email, often bypasses email security controls.",
    mitre_ttps: ["T1566"],
    detection_hints: ["social_impersonation", "brand_impersonation"],
    severity: "high",
  },
  {
    id: "im_user_spoofing",
    name: "IM User Spoofing",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Creating fake accounts on IM platforms that impersonate real people within or associated with the target organization.",
    mitre_ttps: ["T1656", "T1566"],
    detection_hints: ["social_impersonation", "brand_impersonation"],
    severity: "high",
  },
  {
    id: "aitm_phishing",
    name: "AiTM Phishing",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Adversary-in-the-Middle phishing that intercepts authentication traffic in real-time to steal session cookies, bypassing MFA.",
    mitre_ttps: ["T1557", "T1539"],
    detection_hints: ["malicious_url", "phishing", "reverse_proxy"],
    severity: "critical",
  },
  {
    id: "device_code_phishing",
    name: "Device Code Phishing",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Abusing OAuth device authorization flows to trick users into authenticating attacker-controlled devices.",
    mitre_ttps: ["T1528", "T1566"],
    detection_hints: ["oauth_abuse", "phishing"],
    severity: "critical",
  },
  {
    id: "mfa_fatigue",
    name: "MFA Fatigue",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Bombarding users with MFA push notifications until they approve one out of frustration, granting the attacker access.",
    mitre_ttps: ["T1621"],
    detection_hints: ["mfa_abuse", "authentication_anomaly"],
    severity: "high",
  },
  {
    id: "mfa_downgrade",
    name: "MFA Downgrade",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Exploiting SaaS application recovery flows to bypass MFA and access accounts with weaker authentication.",
    mitre_ttps: ["T1556", "T1621"],
    detection_hints: ["authentication_anomaly", "mfa_abuse"],
    severity: "critical",
  },
  {
    id: "verification_phishing",
    name: "Verification Phishing",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Impersonating platform verification processes (blue check, identity verification) to steal credentials or personal data.",
    mitre_ttps: ["T1566", "T1656"],
    detection_hints: ["social_impersonation", "brand_impersonation", "phishing"],
    severity: "high",
  },
  {
    id: "noauth",
    name: "nOAuth",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Exploiting OAuth implementation flaws where email is used as a trusted identifier, enabling account takeover across platforms.",
    mitre_ttps: ["T1550.001", "T1528"],
    detection_hints: ["oauth_abuse", "authentication_anomaly"],
    severity: "critical",
  },
  {
    id: "hijack_oauth_flows",
    name: "Hijack OAuth Flows",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Intercepting OAuth authorization codes or tokens during the authentication flow to gain unauthorized access.",
    mitre_ttps: ["T1528", "T1550.001"],
    detection_hints: ["oauth_abuse", "malicious_url"],
    severity: "critical",
  },
  {
    id: "guest_access_abuse",
    name: "Guest Access Abuse",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Exploiting guest/external user features in collaboration platforms to gain unauthorized access to internal resources.",
    mitre_ttps: ["T1078", "T1199"],
    detection_hints: ["authentication_anomaly"],
    severity: "medium",
  },
  {
    id: "cross_idp_impersonation",
    name: "Cross-IdP Impersonation",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Exploiting trust relationships between identity providers to impersonate users across federated systems.",
    mitre_ttps: ["T1606", "T1656"],
    detection_hints: ["authentication_anomaly", "saml_abuse"],
    severity: "critical",
  },
  {
    id: "ui_redressing",
    name: "UI Redressing",
    phase: "initial_access", phase_label: "Initial Access",
    description: "Overlaying fake UI elements (clickjacking) on legitimate SaaS pages to trick users into performing unintended actions.",
    mitre_ttps: ["T1656"],
    detection_hints: ["malicious_url", "phishing"],
    severity: "medium",
  },

  // ── PERSISTENCE ──────────────────────────────────────────────────
  {
    id: "oauth_tokens",
    name: "OAuth Tokens",
    phase: "persistence", phase_label: "Persistence",
    description: "Using OAuth tokens (especially refresh tokens) as persistent backdoors that survive password changes.",
    mitre_ttps: ["T1550.001"],
    detection_hints: ["oauth_abuse"],
    severity: "high",
  },
  {
    id: "api_keys",
    name: "API Keys",
    phase: "persistence", phase_label: "Persistence",
    description: "Creating or stealing API keys to maintain persistent access to SaaS platforms independent of user credentials.",
    mitre_ttps: ["T1528", "T1552"],
    detection_hints: ["api_key_abuse", "credential_abuse"],
    severity: "high",
  },
  {
    id: "evil_twin_integrations",
    name: "Evil Twin Integrations",
    phase: "persistence", phase_label: "Persistence",
    description: "Installing malicious OAuth integrations that mimic legitimate ones to maintain persistent access to SaaS data.",
    mitre_ttps: ["T1550.001", "T1199"],
    detection_hints: ["oauth_abuse", "malicious_url"],
    severity: "high",
  },
  {
    id: "malicious_mail_rules",
    name: "Malicious Mail Rules",
    phase: "persistence", phase_label: "Persistence",
    description: "Creating inbox rules that silently forward, delete, or redirect emails to maintain access and hide attacker activity.",
    mitre_ttps: ["T1114.003"],
    detection_hints: ["email_threat"],
    severity: "high",
  },
  {
    id: "ghost_logins",
    name: "Ghost Logins",
    phase: "persistence", phase_label: "Persistence",
    description: "Using dormant or unmonitored accounts (former employees, service accounts) to maintain stealthy persistent access.",
    mitre_ttps: ["T1078"],
    detection_hints: ["authentication_anomaly"],
    severity: "medium",
  },
  {
    id: "inbound_federation",
    name: "Inbound Federation",
    phase: "persistence", phase_label: "Persistence",
    description: "Configuring a malicious IdP as a trusted federation partner to gain persistent access via SAML or OIDC.",
    mitre_ttps: ["T1606", "T1199"],
    detection_hints: ["saml_abuse", "authentication_anomaly"],
    severity: "critical",
  },

  // ── CREDENTIAL ACCESS ────────────────────────────────────────────
  {
    id: "password_scraping",
    name: "Password Scraping",
    phase: "credential_access", phase_label: "Credential Access",
    description: "Extracting passwords from SaaS applications like password managers, wikis, or collaboration tools.",
    mitre_ttps: ["T1555", "T1552"],
    detection_hints: ["credential_abuse", "data_exfiltration"],
    severity: "critical",
  },
  {
    id: "api_secret_theft",
    name: "API Secret Theft",
    phase: "credential_access", phase_label: "Credential Access",
    description: "Stealing API keys and secrets from code repositories, documentation, or SaaS configuration panels.",
    mitre_ttps: ["T1552.001"],
    detection_hints: ["credential_abuse", "api_key_abuse"],
    severity: "critical",
  },
  {
    id: "session_cookie_theft",
    name: "Session Cookie Theft",
    phase: "credential_access", phase_label: "Credential Access",
    description: "Stealing authenticated session tokens to bypass credentials and MFA entirely.",
    mitre_ttps: ["T1539"],
    detection_hints: ["session_hijack", "malicious_url"],
    severity: "critical",
  },

  // ── LATERAL MOVEMENT ─────────────────────────────────────────────
  {
    id: "in_app_phishing",
    name: "In-App Phishing",
    phase: "lateral_movement", phase_label: "Lateral Movement",
    description: "Using trusted SaaS messaging features (Slack DMs, Teams messages) to send phishing links that bypass email security.",
    mitre_ttps: ["T1566"],
    detection_hints: ["social_impersonation", "brand_impersonation"],
    severity: "high",
  },
  {
    id: "passwordless_logins",
    name: "Passwordless Logins",
    phase: "lateral_movement", phase_label: "Lateral Movement",
    description: "Abusing magic link or one-time password flows to move laterally between SaaS accounts without knowing passwords.",
    mitre_ttps: ["T1078", "T1550"],
    detection_hints: ["authentication_anomaly"],
    severity: "medium",
  },
  {
    id: "automation_workflow_sharing",
    name: "Automation Workflow Sharing",
    phase: "lateral_movement", phase_label: "Lateral Movement",
    description: "Sharing malicious automation workflows (Zapier, Make, Power Automate) that execute in the target's context.",
    mitre_ttps: ["T1072"],
    detection_hints: ["oauth_abuse"],
    severity: "high",
  },

  // ── EXFILTRATION ─────────────────────────────────────────────────
  {
    id: "takeout_services",
    name: "Takeout Services",
    phase: "exfiltration", phase_label: "Exfiltration",
    description: "Using legitimate data export features (Google Takeout, Slack export) to exfiltrate large volumes of data.",
    mitre_ttps: ["T1567"],
    detection_hints: ["data_exfiltration"],
    severity: "critical",
  },
  {
    id: "webhooks_exfil",
    name: "Webhooks",
    phase: "exfiltration", phase_label: "Exfiltration",
    description: "Configuring SaaS webhooks to automatically send data to attacker-controlled endpoints.",
    mitre_ttps: ["T1567", "T1020"],
    detection_hints: ["data_exfiltration", "c2_communication"],
    severity: "high",
  },
];

// ── Threat type → technique mappings ──────────────────────────────
// Maps Averrow threat_type values to their most likely SaaS technique id.
export const THREAT_TYPE_TO_TECHNIQUE: Record<string, string> = {
  "phishing":              "email_phishing",
  "malware_distribution":  "email_phishing",
  "typosquat":             "subdomain_tenant_discovery",
  "typosquatting":         "subdomain_tenant_discovery",
  "lookalike":             "subdomain_tenant_discovery",
  "brand_impersonation":   "verification_phishing",
  "impersonation":         "verification_phishing",
  "social_impersonation":  "im_user_spoofing",
  "credential_harvesting": "aitm_phishing",
  "oauth_abuse":           "consent_phishing",
  "malicious_ip":          "aitm_phishing",
  "c2":                    "inbound_federation",
  "botnet":                "inbound_federation",
  "data_exfiltration":     "takeout_services",
  "spam":                  "email_phishing",
  "malware":               "email_phishing",
};

// ── Domain pattern → technique hints ──────────────────────────────
export const DOMAIN_PATTERN_HINTS: Array<{
  pattern:   RegExp;
  technique: string;
}> = [
  { pattern: /login\.|signin\.|auth\.|sso\./i,    technique: "aitm_phishing" },
  { pattern: /oauth\.|authorize\.|consent\./i,    technique: "consent_phishing" },
  { pattern: /microsoft|office365|o365|outlook/i, technique: "aitm_phishing" },
  { pattern: /google|gmail|workspace/i,           technique: "consent_phishing" },
  { pattern: /slack\.|teams\.|discord\./i,        technique: "im_phishing" },
  { pattern: /verify|verification|validate/i,     technique: "verification_phishing" },
  { pattern: /device|activate/i,                  technique: "device_code_phishing" },
];

// Lookup helper: id → technique (built once)
export const SAAS_TECHNIQUE_BY_ID: Record<string, SaasTechnique> =
  Object.fromEntries(SAAS_TECHNIQUES.map((t) => [t.id, t]));
