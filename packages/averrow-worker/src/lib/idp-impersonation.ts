// Averrow — Identity-provider (IdP) impersonation classifier
// (docs/IDP_IMPERSONATION_PLAN_2026-10.md, task T1).
//
// Pure function over a threat's host / URL / brand context. No D1, AI or
// network access. It LABELS TECHNIQUE only; it never decides maliciousness
// (the threat already came from a phishing feed / detector).
//
// Vectors:
//   idp_tenant    — phishing hosted on an attacker-controlled tenant of a
//                   legitimate IdP (acme-sso.okta.com, acme.eu.auth0.com).
//   idp_lookalike — an attacker-registered domain carrying an IdP lure
//                   (acme-okta.com, acme-sso.com, acme-servicedesk.com), or
//                   a non-Microsoft host serving an Entra sign-in path
//                   (AiTM proxy of /common/oauth2, /<tenant>.onmicrosoft.com/).
//   device_code   — existing techniques 'device_code_phishing' /
//                   'oauth_consent_phishing' (lib/device-code-detector.ts,
//                   feeds/advisories.ts). This module never assigns them; it
//                   only maps them into the family.
//
// Judgment calls (documented for review):
//   * microsoftonline.com / onmicrosoft.com are NOT tenant hosts — they are
//     Microsoft's shared login plane. Entra lures are detected only from the
//     URL PATH on a non-Microsoft host. Query strings are ignored (legit SaaS
//     sites routinely carry login.microsoftonline.com in redirect params).
//   * duosecurity.com is NOT a tenant host: Duo's per-customer hosts are
//     api-<hex>.duosecurity.com (opaque id, Duo-operated, no brand label), so
//     there is nothing for an attacker to name. Duo is a lookalike lure only.
//   * pingone.com tenants are path-scoped (auth.pingone.com/<envId>), not
//     subdomains, so they are not in the tenant table. ForgeRock Identity
//     Cloud (now Ping "Advanced Identity Cloud") tenants ARE subdomains
//     (openam-<tenant>.forgeblocks.com) and are included as `ping`.
//   * okta-gov.com / okta-mil.com (Okta for Government High / US Military
//     cells) could not be confirmed from public docs; included because a
//     wrong suffix can only mislabel a host as idp_tenant instead of
//     idp_lookalike — same family, same IdP.
//   * Google Workspace has no tenant subdomain; `google` comes only from
//     brand-combined lures (gsuite / googleworkspace). Bare "google",
//     "microsoft", "office365" are brand impersonation, not IdP lures, and
//     are deliberately excluded so the family is not swamped by M365 phish.

export type IdpVector = 'idp_tenant' | 'idp_lookalike' | 'device_code';
export type IdpProvider =
  | 'okta' | 'entra' | 'onelogin' | 'auth0' | 'ping' | 'duo' | 'google' | 'generic_sso';

export const IDP_TECHNIQUE: Record<'idp_tenant' | 'idp_lookalike', string> = {
  idp_tenant: 'idp_tenant_abuse',
  idp_lookalike: 'idp_lookalike',
};

const DEVICE_CODE_TECHNIQUES: readonly string[] = ['device_code_phishing', 'oauth_consent_phishing'];

/** Every `threats.technique` value in the IdP family — for SQL `IN (...)`. */
export const IDP_FAMILY_TECHNIQUES: readonly string[] = [
  IDP_TECHNIQUE.idp_tenant,
  IDP_TECHNIQUE.idp_lookalike,
  ...DEVICE_CODE_TECHNIQUES,
];

export function techniqueToVector(technique: string | null | undefined): IdpVector | null {
  if (!technique) return null;
  if (technique === IDP_TECHNIQUE.idp_tenant) return 'idp_tenant';
  if (technique === IDP_TECHNIQUE.idp_lookalike) return 'idp_lookalike';
  if (DEVICE_CODE_TECHNIQUES.includes(technique)) return 'device_code';
  return null;
}

export const IDP_PROVIDER_LABEL: Record<IdpProvider, string> = {
  okta: 'Okta',
  entra: 'Microsoft Entra ID',
  onelogin: 'OneLogin',
  auth0: 'Auth0',
  ping: 'Ping Identity',
  duo: 'Duo',
  google: 'Google Workspace',
  generic_sso: 'Generic SSO',
};

export const IDP_VECTOR_LABEL: Record<IdpVector, string> = {
  idp_tenant: 'Abused identity-provider tenant',
  idp_lookalike: 'Identity-provider lookalike domain',
  device_code: 'Device-code and OAuth consent phishing',
};

export interface IdpMitreTechnique {
  id: string;
  name: string;
  tactic: string;
  vectors: IdpVector[];
}

// Each mapping is backed by an artifact the vector actually evidences.
// T1621 (MFA Request Generation / push-bombing) was DROPPED: it is adjacent
// Scattered Spider tradecraft but nothing in a host, URL or lure observes
// it — it happens against the real IdP, out of our view.
export const IDP_MITRE: readonly IdpMitreTechnique[] = [
  { id: 'T1566.002', name: 'Phishing: Spearphishing Link', tactic: 'Initial Access',
    vectors: ['idp_tenant', 'idp_lookalike', 'device_code'] },
  { id: 'T1557', name: 'Adversary-in-the-Middle', tactic: 'Credential Access',
    vectors: ['idp_tenant', 'idp_lookalike'] },
  { id: 'T1111', name: 'Multi-Factor Authentication Interception', tactic: 'Credential Access',
    vectors: ['idp_tenant', 'idp_lookalike'] },
  { id: 'T1528', name: 'Steal Application Access Token', tactic: 'Credential Access',
    vectors: ['device_code'] },
  { id: 'T1078.004', name: 'Valid Accounts: Cloud Accounts', tactic: 'Initial Access',
    vectors: ['idp_tenant', 'idp_lookalike', 'device_code'] },
  { id: 'T1583.001', name: 'Acquire Infrastructure: Domains', tactic: 'Resource Development',
    vectors: ['idp_lookalike'] },
  { id: 'T1583.006', name: 'Acquire Infrastructure: Web Services', tactic: 'Resource Development',
    vectors: ['idp_tenant'] },
  { id: 'T1656', name: 'Impersonation', tactic: 'Defense Evasion',
    vectors: ['idp_tenant', 'idp_lookalike', 'device_code'] },
];

// ─── Tenant hosts ────────────────────────────────────────────────────

/** Registrable IdP tenant host suffix → provider. Longest suffix wins. */
export const IDP_TENANT_HOSTS: Readonly<Record<string, IdpProvider>> = {
  'okta.com': 'okta',
  'oktapreview.com': 'okta',
  'okta-emea.com': 'okta',
  'okta-gov.com': 'okta',
  'okta-mil.com': 'okta',
  'onelogin.com': 'onelogin',
  'auth0.com': 'auth0',
  'us.auth0.com': 'auth0',
  'eu.auth0.com': 'auth0',
  'au.auth0.com': 'auth0',
  'jp.auth0.com': 'auth0',
  'uk.auth0.com': 'auth0',
  'ca.auth0.com': 'auth0',
  'forgeblocks.com': 'ping',
};

// Vendor-operated labels directly under a tenant suffix — never a tenant.
const COMMON_CORP_LABELS = new Set<string>([
  'www', 'login', 'signin', 'sso', 'auth', 'id', 'api', 'cdn', 'static', 'assets',
  'support', 'help', 'docs', 'developer', 'developers', 'devforum', 'community',
  'trust', 'security', 'status', 'blog', 'mail', 'email', 'events', 'investor',
  'investors', 'partners', 'learning', 'university', 'careers', 'marketplace',
  'go', 'info', 'pages', 'press', 'shop', 'store',
]);
const PROVIDER_CORP_LABELS: Partial<Record<IdpProvider, ReadonlySet<string>>> = {
  okta: new Set(['okta', 'ok1static', 'ok2static', 'ok3static', 'ok4static', 'ok5static', 'ok6static',
    'ok7static', 'ok8static', 'ok9static', 'ok10static', 'ok11static', 'ok12static', 'ok14static']),
  onelogin: new Set(['app', 'portal', 'us', 'eu', 'onelogin']),
  auth0: new Set(['manage', 'samples', 'cdn', 'auth0', 'us', 'eu', 'au', 'jp', 'uk', 'ca']),
  ping: new Set(['backstage']),
};

function normalizeHost(raw: string): string {
  let h = raw.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  h = h.split(/[/?#]/, 1)[0] ?? '';
  h = h.replace(/^[^@]*@/, '');
  h = h.replace(/:\d+$/, '');
  h = h.replace(/\.+$/, '');
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

function matchTenantSuffix(host: string): { suffix: string; provider: IdpProvider } | null {
  let best: { suffix: string; provider: IdpProvider } | null = null;
  for (const [suffix, provider] of Object.entries(IDP_TENANT_HOSTS)) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      if (!best || suffix.length > best.suffix.length) best = { suffix, provider };
    }
  }
  return best;
}

function isCorpLabel(label: string, provider: IdpProvider): boolean {
  if (COMMON_CORP_LABELS.has(label)) return true;
  if (label.startsWith('status')) return true;
  return PROVIDER_CORP_LABELS[provider]?.has(label) ?? false;
}

/** The raw tenant label directly under the IdP suffix, or null when the host
 *  is the apex, a regional apex, or a vendor-operated subdomain. */
function rawTenantLabel(host: string): { label: string; provider: IdpProvider } | null {
  const m = matchTenantSuffix(host);
  if (!m || host === m.suffix) return null;
  const prefix = host.slice(0, host.length - m.suffix.length - 1);
  const labels = prefix.split('.').filter(Boolean);
  const label = labels[labels.length - 1];
  if (!label || isCorpLabel(label, m.provider)) return null;
  return { label, provider: m.provider };
}

/** Tenant label for brand attribution: `acme-sso` from acme-sso.okta.com,
 *  `acme` from acme.eu.auth0.com and acme-admin.okta.com (Okta admin
 *  console), `acme` from openam-acme.forgeblocks.com. */
export function idpTenantLabel(host: string): string | null {
  const t = rawTenantLabel(normalizeHost(host));
  if (!t) return null;
  let label = t.label;
  if (t.provider === 'okta' && label.endsWith('-admin') && label.length > 6) label = label.slice(0, -6);
  if (t.provider === 'ping' && label.startsWith('openam-') && label.length > 7) label = label.slice(7);
  return label || null;
}

// ─── Lookalike lures ─────────────────────────────────────────────────

// Strong lures stand alone (whole token, auth-word compound, or brand compound).
const STRONG_LURES: Readonly<Record<string, IdpProvider>> = {
  okta: 'okta', '0kta': 'okta',
  onelogin: 'onelogin',
  auth0: 'auth0',
  duosecurity: 'duo', duomobile: 'duo',
  pingone: 'ping', pingid: 'ping', pingfederate: 'ping', forgerock: 'ping',
  entra: 'entra', azuread: 'entra', adfs: 'entra', microsoftonline: 'entra', onmicrosoft: 'entra',
  sso: 'generic_sso',
};

// Weak lures are generic words: IdP-family only when the host also carries a
// brand token (acme-servicedesk.com yes, servicedesk-pro.com no).
const WEAK_LURES: Readonly<Record<string, IdpProvider>> = {
  servicedesk: 'generic_sso', helpdesk: 'generic_sso', itsupport: 'generic_sso',
  servicenow: 'generic_sso', vpn: 'generic_sso', citrix: 'generic_sso',
  idp: 'generic_sso', mfa: 'generic_sso', '2fa': 'generic_sso',
  duo: 'duo',
  gsuite: 'google', googleworkspace: 'google',
};

// Words that may glue onto a strong lure in one label (oktalogin, mysso).
const AUTH_WORDS = new Set<string>([
  'login', 'signin', 'logon', 'auth', 'portal', 'secure', 'verify', 'mfa', 'account',
  'accounts', 'my', 'id', 'access', 'connect', 'help', 'support', 'verification',
]);

// Long Microsoft tokens are matched after de-leeting and with edit distance 1.
const FUZZY_ENTRA = ['microsoftonline', 'onmicrosoft'];

const MICROSOFT_HOSTS = [
  'microsoft.com', 'microsoftonline.com', 'microsoftonline-p.com', 'onmicrosoft.com',
  'live.com', 'office.com', 'office365.com', 'office.net', 'microsoft365.com', 'windows.net',
  'azure.com', 'azure.net', 'msauth.net', 'msftauth.net', 'msidentity.com', 'sharepoint.com',
  'aka.ms', 'msft.net', 'azureedge.net', 'b2clogin.com', 'ciamlogin.com',
];

function isMicrosoftHost(host: string): boolean {
  return MICROSOFT_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
}

const MULTI_LABEL_TLDS = new Set<string>([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp',
  'co.kr', 'com.cn', 'com.hk', 'com.tw', 'com.sg', 'com.my', 'co.in', 'com.br', 'com.mx',
  'com.ar', 'com.co', 'com.tr', 'co.za', 'com.ng', 'co.il', 'com.sa', 'com.eg', 'co.id', 'com.ph',
]);

/** Host labels minus the public suffix. */
function scannableLabels(host: string): string[] {
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return labels;
  const lastTwo = labels.slice(-2).join('.');
  const drop = MULTI_LABEL_TLDS.has(lastTwo) && labels.length > 2 ? 2 : 1;
  return labels.slice(0, labels.length - drop);
}

function deleet(s: string): string {
  return s.replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

interface LureHit { lure: string; provider: IdpProvider; strong: boolean; matched: string; order: number }

// Strong lures that are also ordinary words / other brands' product names
// ("entra" — bbva-entra.com, entra.es): never fire as a bare token, only
// glued to an auth word (entraid, entra-login, entra-sso). The Entra URL-path
// signal is unaffected.
const COMPOUND_ONLY_LURES = new Set<string>(['entra']);
const COMPOUND_ONLY_WORDS = new Set<string>([...AUTH_WORDS, 'sso']);

function strongWholeToken(tok: string): { lure: string; provider: IdpProvider } | null {
  const direct = STRONG_LURES[tok];
  if (direct) return COMPOUND_ONLY_LURES.has(tok) ? null : { lure: tok, provider: direct };
  // De-leet only a token that has a letter: a pure number (550 → "sso",
  // 0174 → "olta") is never a lure.
  if (/[0-9]/.test(tok) && /[a-z]/.test(tok)) {
    const d = deleet(tok);
    // auth0 legitimately contains a digit; deleeting it would make "autho".
    if (d !== 'autho' && STRONG_LURES[d] && !COMPOUND_ONLY_LURES.has(d)) {
      return { lure: d, provider: STRONG_LURES[d] };
    }
  }
  if (tok.length >= 10) {
    const d = deleet(tok);
    for (const f of FUZZY_ENTRA) if (withinOneEdit(d, f)) return { lure: f, provider: 'entra' };
  }
  return null;
}

function normBrandTokens(tokens: string[] | undefined): string[] {
  if (!tokens) return [];
  const out = new Set<string>();
  for (const t of tokens) {
    const n = t.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (n.length >= 3 && !STRONG_LURES[n] && !WEAK_LURES[n]) out.add(n);
  }
  return [...out];
}

function findLures(host: string, brands: string[]): LureHit[] {
  const hits: LureHit[] = [];
  let order = 0;
  const labels = scannableLabels(host);
  // Raw hyphen-split segments, plus adjacent pairs re-joined (one-login,
  // azure-ad, auth-0). `covers` = the raw-segment indices each one spans.
  const raw: string[] = [];
  const segments: Array<{ seg: string; covers: number[] }> = [];
  for (const label of labels) {
    const segs = label.split(/[-_]/).filter(Boolean);
    const base = raw.length;
    raw.push(...segs);
    segs.forEach((seg, i) => segments.push({ seg, covers: [base + i] }));
    for (let i = 0; i + 1 < segs.length; i++) {
      segments.push({ seg: `${segs[i]}${segs[i + 1]}`, covers: [base + i, base + i + 1] });
    }
  }

  // A weak lure needs the brand in a DIFFERENT raw segment that does not
  // itself carry the lure: servicedesk.com with brand "service" is not
  // brand-present, nor is service-desk.com (both segments belong to the lure).
  const brandPresentBeside = (lure: string, covers: number[]): boolean =>
    brands.length > 0 && raw.some((s, i) =>
      !covers.includes(i) && !s.includes(lure) &&
      brands.some((b) => s === b || s.startsWith(b) || s.endsWith(b)));

  for (const { seg, covers } of segments) {
    const pieces = new Set<string>([seg, ...seg.split(/(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/)]);
    for (const tok of pieces) {
      if (!tok) continue;
      const strong = strongWholeToken(tok);
      if (strong) hits.push({ ...strong, strong: true, matched: tok, order: order++ });
      const weak = WEAK_LURES[tok];
      if (weak && brandPresentBeside(tok, covers)) hits.push({ lure: tok, provider: weak, strong: false, matched: tok, order: order++ });
    }
    // Compounds within a single segment.
    for (const [lure, provider] of Object.entries(STRONG_LURES)) {
      if (seg === lure || !seg.includes(lure)) continue;
      const rest = seg.startsWith(lure) ? seg.slice(lure.length) : seg.endsWith(lure) ? seg.slice(0, -lure.length) : null;
      if (rest === null) continue;
      const ok = COMPOUND_ONLY_LURES.has(lure)
        ? COMPOUND_ONLY_WORDS.has(rest)
        : AUTH_WORDS.has(rest) || brands.includes(rest);
      if (ok) {
        hits.push({ lure, provider, strong: true, matched: seg, order: order++ });
      }
    }
    for (const [lure, provider] of Object.entries(WEAK_LURES)) {
      if (seg === lure || !seg.includes(lure)) continue;
      const rest = seg.startsWith(lure) ? seg.slice(lure.length) : seg.endsWith(lure) ? seg.slice(0, -lure.length) : null;
      if (rest !== null && brands.includes(rest)) {
        hits.push({ lure, provider, strong: false, matched: seg, order: order++ });
      }
    }
  }
  return hits;
}

function pickHit(hits: LureHit[]): LureHit | null {
  if (hits.length === 0) return null;
  const rank = (h: LureHit) => (h.provider !== 'generic_sso' ? 0 : 2) + (h.strong ? 0 : 1);
  return [...hits].sort((a, b) => rank(a) - rank(b) || a.order - b.order)[0] ?? null;
}

// Entra sign-in paths replayed by AiTM proxies on a non-Microsoft host.
const ENTRA_PATH_RE =
  /\/(?:(?:common|organizations)\/oauth2\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:oauth2|saml2|wsfed)\b|[a-z0-9-]+\.onmicrosoft\.com(?:\/|$)|adfs\/ls\b)/;

function entraPathSignal(url: string | null | undefined): string | null {
  if (!url) return null;
  let path: string;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
    path = decodeURIComponent(u.pathname).toLowerCase();
  } catch {
    return null;
  }
  const m = ENTRA_PATH_RE.exec(path);
  return m ? m[0] : null;
}

// ─── Classifier ──────────────────────────────────────────────────────

export interface IdpClassifyInput {
  host: string;
  url?: string | null;
  brandTokens?: string[];
  existingTechnique?: string | null;
}

export interface IdpClassification {
  vector: IdpVector;
  idp: IdpProvider;
  technique: string;
  /** The host, lure token or URL path fragment that fired — evidence. */
  matched: string;
}

function classifyHost(host: string, url: string | null | undefined, brands: string[]): IdpClassification | null {
  if (!host || isMicrosoftHost(host)) return null;

  const tenantSuffix = matchTenantSuffix(host);
  if (tenantSuffix) {
    // IdP-owned host: a tenant or a vendor corp page — never a lookalike.
    const t = rawTenantLabel(host);
    if (!t) return null;
    return { vector: 'idp_tenant', idp: t.provider, technique: IDP_TECHNIQUE.idp_tenant, matched: host };
  }

  const hit = pickHit(findLures(host, brands));
  const entra = entraPathSignal(url);
  if (entra && (!hit || hit.provider === 'generic_sso')) {
    return { vector: 'idp_lookalike', idp: 'entra', technique: IDP_TECHNIQUE.idp_lookalike, matched: entra };
  }
  if (hit) {
    return { vector: 'idp_lookalike', idp: hit.provider, technique: IDP_TECHNIQUE.idp_lookalike, matched: hit.matched };
  }
  return null;
}

/**
 * Classify a threat as IdP impersonation, or null.
 *
 * `existingTechnique` rules: a non-family technique is never overwritten
 * (null). An existing family technique always wins on vector/technique —
 * the host only refines `idp` (device-code defaults to `entra`, since both
 * detectors that emit it are Microsoft-flow specific).
 */
export function classifyIdpImpersonation(input: IdpClassifyInput): IdpClassification | null {
  const existing = input.existingTechnique ?? null;
  const existingVector = techniqueToVector(existing);
  if (existing && !existingVector) return null;

  const host = normalizeHost(input.host ?? '');
  const brands = normBrandTokens(input.brandTokens);
  const fresh = classifyHost(host, input.url, brands);

  if (existing && existingVector) {
    return {
      vector: existingVector,
      idp: fresh?.idp ?? (existingVector === 'device_code' ? 'entra' : 'generic_sso'),
      technique: existing,
      matched: fresh?.matched ?? host,
    };
  }
  return fresh;
}
