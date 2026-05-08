// Client-side lookup for SaaS attack techniques (PushSecurity taxonomy).
// Mirrors the backend seed in packages/trust-radar/src/lib/saas-techniques-seed.ts.
// Used to render technique badges alongside MITRE TTPs on the Threat Actors view.
//
// Source:      github.com/pushsecurity/saas-attacks (CC-BY-4.0)
// Attribution: PushSecurity (pushsecurity.com)

export interface SaasTechniqueSummary {
  id:          string;
  name:        string;
  phase:       string;
  phase_label: string;
  severity:    'critical' | 'high' | 'medium' | 'low';
  ttps:        string[];
}

// Subset of the taxonomy used for client-side TTP → technique lookup.
// Keeping only the fields the UI needs (name/phase/severity + MITRE T-codes).
const SAAS_TECHNIQUES: SaasTechniqueSummary[] = [
  { id: 'saml_enumeration',           name: 'SAML Enumeration',            phase: 'reconnaissance',    phase_label: 'Reconnaissance',    severity: 'low',      ttps: ['T1589', 'T1590'] },
  { id: 'subdomain_tenant_discovery', name: 'Subdomain Tenant Discovery',  phase: 'reconnaissance',    phase_label: 'Reconnaissance',    severity: 'medium',   ttps: ['T1590.001'] },
  { id: 'dns_reconnaissance',         name: 'DNS Reconnaissance',          phase: 'reconnaissance',    phase_label: 'Reconnaissance',    severity: 'low',      ttps: ['T1590.002'] },
  { id: 'username_enumeration',       name: 'Username Enumeration',        phase: 'reconnaissance',    phase_label: 'Reconnaissance',    severity: 'medium',   ttps: ['T1589.003'] },
  { id: 'consent_phishing',           name: 'Consent Phishing',            phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'high',     ttps: ['T1566.002', 'T1550.001'] },
  { id: 'poisoned_tenants',           name: 'Poisoned Tenants',            phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'high',     ttps: ['T1566', 'T1199'] },
  { id: 'samljacking',                name: 'SAMLjacking',                 phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'critical', ttps: ['T1606.002'] },
  { id: 'account_ambushing',          name: 'Account Ambushing',           phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'high',     ttps: ['T1586'] },
  { id: 'credential_stuffing',        name: 'Credential Stuffing',         phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'high',     ttps: ['T1110.004'] },
  { id: 'app_spraying',               name: 'App Spraying',                phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'high',     ttps: ['T1110.003'] },
  { id: 'email_phishing',             name: 'Email Phishing',              phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'high',     ttps: ['T1566.001'] },
  { id: 'im_phishing',                name: 'IM Phishing',                 phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'high',     ttps: ['T1566'] },
  { id: 'im_user_spoofing',           name: 'IM User Spoofing',            phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'high',     ttps: ['T1656', 'T1566'] },
  { id: 'aitm_phishing',              name: 'AiTM Phishing',               phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'critical', ttps: ['T1557', 'T1539'] },
  { id: 'device_code_phishing',       name: 'Device Code Phishing',        phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'critical', ttps: ['T1528', 'T1566'] },
  { id: 'mfa_fatigue',                name: 'MFA Fatigue',                 phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'high',     ttps: ['T1621'] },
  { id: 'mfa_downgrade',              name: 'MFA Downgrade',               phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'critical', ttps: ['T1556', 'T1621'] },
  { id: 'verification_phishing',      name: 'Verification Phishing',       phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'high',     ttps: ['T1566', 'T1656'] },
  { id: 'noauth',                     name: 'nOAuth',                      phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'critical', ttps: ['T1550.001', 'T1528'] },
  { id: 'hijack_oauth_flows',         name: 'Hijack OAuth Flows',          phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'critical', ttps: ['T1528', 'T1550.001'] },
  { id: 'guest_access_abuse',         name: 'Guest Access Abuse',          phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'medium',   ttps: ['T1078', 'T1199'] },
  { id: 'cross_idp_impersonation',    name: 'Cross-IdP Impersonation',     phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'critical', ttps: ['T1606', 'T1656'] },
  { id: 'ui_redressing',              name: 'UI Redressing',               phase: 'initial_access',    phase_label: 'Initial Access',    severity: 'medium',   ttps: ['T1656'] },
  { id: 'oauth_tokens',               name: 'OAuth Tokens',                phase: 'persistence',       phase_label: 'Persistence',       severity: 'high',     ttps: ['T1550.001'] },
  { id: 'api_keys',                   name: 'API Keys',                    phase: 'persistence',       phase_label: 'Persistence',       severity: 'high',     ttps: ['T1528', 'T1552'] },
  { id: 'evil_twin_integrations',     name: 'Evil Twin Integrations',      phase: 'persistence',       phase_label: 'Persistence',       severity: 'high',     ttps: ['T1550.001', 'T1199'] },
  { id: 'malicious_mail_rules',       name: 'Malicious Mail Rules',        phase: 'persistence',       phase_label: 'Persistence',       severity: 'high',     ttps: ['T1114.003'] },
  { id: 'ghost_logins',               name: 'Ghost Logins',                phase: 'persistence',       phase_label: 'Persistence',       severity: 'medium',   ttps: ['T1078'] },
  { id: 'inbound_federation',         name: 'Inbound Federation',          phase: 'persistence',       phase_label: 'Persistence',       severity: 'critical', ttps: ['T1606', 'T1199'] },
  { id: 'password_scraping',          name: 'Password Scraping',           phase: 'credential_access', phase_label: 'Credential Access', severity: 'critical', ttps: ['T1555', 'T1552'] },
  { id: 'api_secret_theft',           name: 'API Secret Theft',            phase: 'credential_access', phase_label: 'Credential Access', severity: 'critical', ttps: ['T1552.001'] },
  { id: 'session_cookie_theft',       name: 'Session Cookie Theft',        phase: 'credential_access', phase_label: 'Credential Access', severity: 'critical', ttps: ['T1539'] },
  { id: 'in_app_phishing',            name: 'In-App Phishing',             phase: 'lateral_movement',  phase_label: 'Lateral Movement',  severity: 'high',     ttps: ['T1566'] },
  { id: 'passwordless_logins',        name: 'Passwordless Logins',         phase: 'lateral_movement',  phase_label: 'Lateral Movement',  severity: 'medium',   ttps: ['T1078', 'T1550'] },
  { id: 'automation_workflow_sharing',name: 'Automation Workflow Sharing', phase: 'lateral_movement',  phase_label: 'Lateral Movement',  severity: 'high',     ttps: ['T1072'] },
  { id: 'takeout_services',           name: 'Takeout Services',            phase: 'exfiltration',      phase_label: 'Exfiltration',      severity: 'critical', ttps: ['T1567'] },
  { id: 'webhooks_exfil',             name: 'Webhooks',                    phase: 'exfiltration',      phase_label: 'Exfiltration',      severity: 'high',     ttps: ['T1567', 'T1020'] },
];

// Normalize a T-code to its base form (strip sub-technique).
// "T1566.001" → "T1566"
function baseTtp(ttp: string): string {
  return ttp.split('.')[0] ?? ttp;
}

/**
 * Returns the SaaS techniques that share any MITRE T-code with the given
 * actor TTPs. Matches on both exact sub-technique and base-technique codes.
 */
export function saasTechniquesForTtps(actorTtps: string[]): SaasTechniqueSummary[] {
  if (!actorTtps.length) return [];

  const actorSet     = new Set(actorTtps);
  const actorBaseSet = new Set(actorTtps.map(baseTtp));
  const matches: SaasTechniqueSummary[] = [];
  const seen = new Set<string>();

  for (const technique of SAAS_TECHNIQUES) {
    let isMatch = false;
    for (const ttp of technique.ttps) {
      if (actorSet.has(ttp) || actorBaseSet.has(baseTtp(ttp))) {
        isMatch = true;
        break;
      }
    }
    if (isMatch && !seen.has(technique.id)) {
      matches.push(technique);
      seen.add(technique.id);
    }
  }

  return matches;
}
