/**
 * Email Security Posture Engine
 *
 * DNS-based checks for DMARC, SPF, DKIM, and MX records.
 * Uses Cloudflare DoH (DNS over HTTPS) — free, no API key, works from Workers.
 */

import {
  parseDmarcRecord,
  isDmarcTestingMode,
  hasNonExistentSubdomainGap,
} from './lib/dmarc-record';

// ─── DNS over HTTPS ─────────────────────────────────────────────────────────

const DOH_URL = 'https://cloudflare-dns.com/dns-query';

interface DnsAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer?: DnsAnswer[];
}

async function dnsLookup(name: string, type: string = 'TXT'): Promise<string[]> {
  const typeNum = type === 'TXT' ? 16 : type === 'MX' ? 15 : 16;
  const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`;
  try {
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return [];
    const data: DohResponse = await resp.json();
    if (data.Status !== 0 || !data.Answer) return [];
    return data.Answer
      .filter(a => a.type === typeNum)
      .map(a => a.data.replace(/^"|"$/g, '').replace(/""/g, ''));
  } catch {
    return [];
  }
}

// ─── DMARC ─────────────────────────────────────────────────────────────────
//
// RFC 9989 (DMARCbis) tag handling lives in lib/dmarc-record.ts. `pct` is
// deprecated but still parsed and stored; scoring treats pct<100 and t=y
// identically ("testing / not fully enforced").

export interface DmarcResult {
  exists: boolean;
  /** Validated `p=` — 'none' | 'quarantine' | 'reject'; 'none' when p= is
   *  absent or invalid. Never raw TXT text. */
  policy: string | null;
  /** Legacy `pct` (RFC 7489, deprecated by RFC 9989). 100 when absent. */
  pct: number | null;
  rua: string | null;
  ruf: string | null;
  raw: string | null;
  /** `sp=` — existing-subdomain policy. Optional so stored-row callers compile. */
  sp?: string | null;
  /** `np=` (RFC 9989) — non-existent-subdomain policy. */
  np?: string | null;
  /** `t=` (RFC 9989) — 'y' | 'n'. */
  t?: string | null;
  /** `psd=` (RFC 9989) — 'y' | 'n' | 'u'. Stored, never scored. */
  psd?: string | null;
  /** A `p=` tag was present but invalid; `policy` is then 'none'. */
  policyInvalid?: boolean;
}

/**
 * Version of the score/grade rubric in calculateEmailSecurityScore. Stamped
 * on every email_security_scans row (score_rubric_version, migration 0328).
 * Grade-change alerting only compares two scans graded under the SAME
 * version, so a rubric change never tells a customer their protection
 * changed when their DNS did not. Bump on any scoring change.
 *   1 (implicit, stored NULL) — pre-RFC 9989 rubric
 *   2 — RFC 9989: t=y / pct<100 testing, np/sp=none gap (2026-11)
 */
export const EMAIL_SCORE_RUBRIC_VERSION = 2;

/** Build a DmarcResult from a raw TXT record (pure; exported for tests). */
export function dmarcResultFromRecord(dmarcRecord: string | null | undefined): DmarcResult {
  const parsed = dmarcRecord && dmarcRecord.startsWith('v=DMARC1') ? parseDmarcRecord(dmarcRecord) : null;
  if (!dmarcRecord || !parsed) {
    return { exists: false, policy: null, pct: null, rua: null, ruf: null, raw: null, sp: null, np: null, t: null, psd: null, policyInvalid: false };
  }
  return {
    exists: true,
    policy: parsed.policyForStorage,
    policyInvalid: parsed.pInvalid,
    pct: parsed.pct ?? 100,
    rua: parsed.rua,
    ruf: parsed.ruf,
    raw: dmarcRecord,
    sp: parsed.sp,
    np: parsed.np,
    t: parsed.t,
    psd: parsed.psd,
  };
}

export async function checkDmarc(domain: string): Promise<DmarcResult> {
  const records = await dnsLookup(`_dmarc.${domain}`, 'TXT');
  return dmarcResultFromRecord(records.find(r => r.startsWith('v=DMARC1')));
}

// ─── SPF ───────────────────────────────────────────────────────────────────

export interface SpfResult {
  exists: boolean;
  policy: string | null;
  includes: number;
  tooManyLookups: boolean;
  raw: string | null;
}

export async function checkSpf(domain: string): Promise<SpfResult> {
  const records = await dnsLookup(domain, 'TXT');
  const spfRecord = records.find(r => r.startsWith('v=spf1'));
  if (!spfRecord) {
    return { exists: false, policy: null, includes: 0, tooManyLookups: false, raw: null };
  }

  const allMatch = spfRecord.match(/([~\-+?])all/);
  const policy = allMatch ? `${allMatch[1]}all` : null;

  const includes = (spfRecord.match(/include:/g) || []).length;
  const redirects = (spfRecord.match(/redirect=/g) || []).length;
  const aRecords = (spfRecord.match(/\ba\b/g) || []).length;
  const mxRecords = (spfRecord.match(/\bmx\b/g) || []).length;
  const totalLookups = includes + redirects + aRecords + mxRecords;

  return { exists: true, policy, includes, tooManyLookups: totalLookups > 10, raw: spfRecord };
}

// ─── DKIM ──────────────────────────────────────────────────────────────────

const COMMON_DKIM_SELECTORS = [
  'google', 'default', 'selector1', 'selector2',
  'k1', 'k2', 'k3',
  'smtp', 'mail', 'email',
  'dkim', 's1', 's2',
  'mandrill', 'amazonses', 'cm',
  'proofpoint', 'pp', 'pphosted', 'pps',
  'mimecast', 'mimecast20190104', 'mc1',
  'everlytickey1', 'everlytickey2', 'turbo-smtp',
  'zendesk1', 'zendesk2',
  's1024', 's2048',              // Generic 1024/2048-bit selectors
  'sc1',                         // SparkPost
  'smtp2go',                     // SMTP2GO
];

export interface DkimResult {
  exists: boolean;
  selectorsFound: string[];
  raw: string | null;
}

export async function checkDkim(domain: string): Promise<DkimResult> {
  const found: string[] = [];

  // Check in parallel batches of 5
  for (let i = 0; i < COMMON_DKIM_SELECTORS.length; i += 5) {
    const batch = COMMON_DKIM_SELECTORS.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (selector) => {
        const records = await dnsLookup(`${selector}._domainkey.${domain}`, 'TXT');
        const dkimRecord = records.find(r => r.includes('v=DKIM1') || r.includes('p='));
        return dkimRecord ? selector : null;
      })
    );
    found.push(...results.filter(Boolean) as string[]);
    // If we've found some already and checked at least 10, stop early
    if (found.length > 0 && i >= 10) break;
  }

  return {
    exists: found.length > 0,
    selectorsFound: found,
    raw: found.length > 0 ? `Selectors: ${found.join(', ')}` : null,
  };
}

// ─── MX ────────────────────────────────────────────────────────────────────

const MX_PROVIDERS: Record<string, string> = {
  'google.com': 'Google Workspace',
  'googlemail.com': 'Google Workspace',
  'outlook.com': 'Microsoft 365',
  'protection.outlook.com': 'Microsoft 365',
  'microsoft.com': 'Microsoft 365',
  'pphosted.com': 'Proofpoint',
  'proofpoint.com': 'Proofpoint',
  'mimecast.com': 'Mimecast',
  'barracudanetworks.com': 'Barracuda',
  'barracuda.com': 'Barracuda',
  'messagelabs.com': 'Symantec',
  'iphmx.com': 'Cisco',
  'fireeyecloud.com': 'FireEye/Trellix',
  'ess.barracuda.com': 'Barracuda',
  'secureserver.net': 'GoDaddy',
  'zoho.com': 'Zoho',
  'mx.cloudflare.net': 'Cloudflare',
};

/** Enterprise providers that always sign with DKIM (may use custom/rotating selectors) */
const ENTERPRISE_DKIM_PROVIDERS = [
  'Google Workspace',
  'Microsoft 365',
  'Proofpoint',
  'Mimecast',
  'Barracuda',
];

export interface MxResult {
  exists: boolean;
  providers: string[];
}

export async function checkMx(domain: string): Promise<MxResult> {
  const records = await dnsLookup(domain, 'MX');
  if (!records.length) return { exists: false, providers: [] };

  const providers: string[] = [];
  for (const record of records) {
    const mxHost = record.split(/\s+/).pop()?.toLowerCase() ?? '';
    for (const [pattern, provider] of Object.entries(MX_PROVIDERS)) {
      if (mxHost.includes(pattern) && !providers.includes(provider)) {
        providers.push(provider);
      }
    }
  }

  return { exists: true, providers };
}

// ─── Scoring ───────────────────────────────────────────────────────────────

export interface EmailSecurityScanInput {
  dmarc: DmarcResult;
  spf: SpfResult;
  dkim: DkimResult;
  mx: MxResult;
}

export function calculateEmailSecurityScore(scan: EmailSecurityScanInput): { score: number; grade: string } {
  let score = 0;

  // DMARC (35 points max). Where aggregate reports are sent does not
  // affect the grade — any rua destination scores the same (G30: the old
  // +5 for reporting to an Averrow address was removed so the grade stays
  // neutral and comparable). Max total is therefore 95, still A+.
  //
  // RFC 9989 (DMARCbis):
  //   - Testing mode — `t=y`, or a legacy `pct` below 100 (pct is deprecated
  //     and is NOT scored on its own; it is read only as the old spelling of
  //     "testing") — scores an enforcing policy one level lower
  //     (reject → quarantine credit, quarantine → none credit). Before this,
  //     neither pct nor t was scored, so `p=reject; pct=0` graded like a
  //     fully enforced reject.
  //   - Non-existent-subdomain gap — apex at quarantine/reject but `np`
  //     (or its `sp` fallback) is `none` — costs 5 points. A missing `np`
  //     that falls back to an enforcing sp/p is fine.
  if (scan.dmarc.exists) {
    score += 10; // Has DMARC record
    const testing = isDmarcTestingMode(scan.dmarc);
    if (scan.dmarc.policy === 'reject') score += testing ? 12 : 20;
    else if (scan.dmarc.policy === 'quarantine') score += testing ? 4 : 12;
    else if (scan.dmarc.policy === 'none') score += 4;
    if (hasNonExistentSubdomainGap(scan.dmarc)) score -= 5;
    if (scan.dmarc.rua) score += 5; // Aggregate reporting
  }

  // SPF (30 points max)
  if (scan.spf.exists) {
    score += 10; // Has SPF record
    if (scan.spf.policy === '-all') score += 15;      // Hard fail
    else if (scan.spf.policy === '~all') score += 10;  // Soft fail
    else if (scan.spf.policy === '?all') score += 3;   // Neutral
    if (!scan.spf.tooManyLookups) score += 5;          // Under lookup limit
  }

  // DKIM (20 points max)
  if (scan.dkim.exists) {
    score += 20;
  } else if (scan.mx.providers.some(p => ENTERPRISE_DKIM_PROVIDERS.includes(p))) {
    // Enterprise providers always sign with DKIM but may use custom/rotating
    // selectors we can't guess — award partial credit.
    score += 10;
  }

  // MX (10 points max)
  if (scan.mx.exists) {
    score += 10;
  }

  score = Math.min(score, 100);

  let grade: string;
  if (score >= 90) grade = 'A+';
  else if (score >= 80) grade = 'A';
  else if (score >= 70) grade = 'B';
  else if (score >= 55) grade = 'C';
  else if (score >= 40) grade = 'D';
  else grade = 'F';

  return { score, grade };
}

// ─── Recommendations ───────────────────────────────────────────────────────

export function generateRecommendations(scan: EmailSecurityScanInput): string[] {
  const recs: string[] = [];

  if (scan.dmarc.exists && scan.dmarc.policyInvalid) {
    recs.push('WARNING: DMARC p= value is invalid — receivers treat it as "none" (no enforcement). Set p=quarantine or p=reject.');
  }

  if (!scan.dmarc.exists) {
    recs.push('CRITICAL: No DMARC record found. Anyone can send emails pretending to be your domain.');
  } else if (scan.dmarc.policy === 'none') {
    recs.push('WARNING: DMARC policy is set to "none" — spoofed emails are not being blocked. Upgrade to "quarantine" or "reject".');
  } else if (scan.dmarc.policy === 'quarantine') {
    recs.push('GOOD: DMARC quarantine is active. Consider upgrading to "reject" for full protection.');
  }

  if (scan.dmarc.exists && (scan.dmarc.policy === 'quarantine' || scan.dmarc.policy === 'reject')) {
    if ((scan.dmarc.t ?? '').toLowerCase() === 'y') {
      recs.push('WARNING: DMARC is in testing mode (t=y) — receivers are asked not to apply your policy in full. Remove t=y (or set t=n) once reports look clean.');
    } else if (isDmarcTestingMode(scan.dmarc)) {
      recs.push(`WARNING: DMARC pct=${scan.dmarc.pct} means the policy is only partly enforced. pct is deprecated by RFC 9989 (DMARCbis) — remove it for full enforcement, or use t=y while testing.`);
    }
    if (hasNonExistentSubdomainGap(scan.dmarc)) {
      recs.push('WARNING: DMARC policy for non-existent subdomains resolves to "none" (np=none, or sp=none with no np). Attackers can spoof made-up subdomains of your domain. Set np=reject (RFC 9989).');
    }
  }

  if (scan.dmarc.exists && !scan.dmarc.rua) {
    recs.push('No DMARC aggregate reporting configured. You have no visibility into who is sending email as your domain.');
  }

  if (!scan.spf.exists) {
    recs.push('CRITICAL: No SPF record found. Email receivers cannot verify your authorized mail servers.');
  } else if (scan.spf.policy === '~all' || scan.spf.policy === '?all') {
    recs.push('SPF soft-fail detected. Upgrade to "-all" (hard fail) for stronger protection.');
  }

  if (scan.spf.tooManyLookups) {
    recs.push('SPF record exceeds 10 DNS lookups — this causes SPF validation failures.');
  }

  if (!scan.dkim.exists) {
    const hasEnterpriseMx = scan.mx.providers.some(p => ENTERPRISE_DKIM_PROVIDERS.includes(p));
    if (hasEnterpriseMx) {
      recs.push('No DKIM selector found, but an enterprise email provider was detected — DKIM is likely configured with a custom or rotating selector.');
    } else {
      recs.push('No DKIM signing detected (checked common selectors). Email recipients cannot verify message integrity.');
    }
  }

  if (!scan.mx.exists) {
    recs.push('No MX records found. This domain may not be configured to receive email.');
  }

  if (recs.length === 0) {
    recs.push('Excellent! This domain has strong email authentication configured.');
  }

  return recs;
}

// ─── Full Scan ─────────────────────────────────────────────────────────────

export interface EmailSecurityResult {
  domain: string;
  score: number;
  grade: string;
  /** EMAIL_SCORE_RUBRIC_VERSION the score/grade were computed under. */
  score_rubric_version: number;
  dmarc: {
    exists: boolean;
    policy: string | null;
    pct: number | null;
    rua: string | null;
    ruf: string | null;
    /** RFC 9989 tags (null when absent). */
    sp: string | null;
    np: string | null;
    t: string | null;
    psd: string | null;
    /** t=y or legacy pct<100 — scored one enforcement level lower. */
    testing: boolean;
    reporting_enabled: boolean;
    record: string | null;
  };
  spf: {
    exists: boolean;
    policy: string | null;
    too_many_lookups: boolean;
    record: string | null;
  };
  dkim: {
    exists: boolean;
    selectors_found: string[];
  };
  mx: {
    exists: boolean;
    providers: string[];
  };
  bimi: BIMIResult;
  recommendations: string[];
  scanned_at: string;
  scan_duration_ms: number;
}

export async function runEmailSecurityScan(domain: string): Promise<EmailSecurityResult> {
  const startTime = Date.now();

  const [dmarc, spf, dkim, mx] = await Promise.all([
    checkDmarc(domain),
    checkSpf(domain),
    checkDkim(domain),
    checkMx(domain),
  ]);

  const { score, grade } = calculateEmailSecurityScore({ dmarc, spf, dkim, mx });

  // BIMI scan runs after DMARC since it depends on the DMARC policy
  const bimi = await scanBIMI(domain, dmarc.policy);

  return {
    domain,
    score,
    grade,
    score_rubric_version: EMAIL_SCORE_RUBRIC_VERSION,
    dmarc: {
      exists: dmarc.exists,
      policy: dmarc.policy,
      pct: dmarc.pct,
      rua: dmarc.rua,
      ruf: dmarc.ruf,
      sp: dmarc.sp ?? null,
      np: dmarc.np ?? null,
      t: dmarc.t ?? null,
      psd: dmarc.psd ?? null,
      testing: dmarc.exists && isDmarcTestingMode(dmarc),
      reporting_enabled: !!dmarc.rua,
      record: dmarc.raw,
    },
    spf: {
      exists: spf.exists,
      policy: spf.policy,
      too_many_lookups: spf.tooManyLookups,
      record: spf.raw,
    },
    dkim: {
      exists: dkim.exists,
      selectors_found: dkim.selectorsFound,
    },
    mx: {
      exists: mx.exists,
      providers: mx.providers,
    },
    bimi,
    recommendations: generateRecommendations({ dmarc, spf, dkim, mx }),
    scanned_at: new Date().toISOString(),
    scan_duration_ms: Date.now() - startTime,
  };
}

// ─── BIMI Scanner ─────────────────────────────────────────────────────────

export type BIMIGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface BIMIResult {
  record: string | null;
  svg_url: string | null;
  vmc_url: string | null;
  vmc_valid: boolean;
  vmc_expiry: string | null;
  grade: BIMIGrade;
}

/**
 * Scan a domain for BIMI (Brand Indicators for Message Identification).
 *
 * BIMI requires DMARC at enforcement level (quarantine or reject).
 * Grades:
 *   A+ = DMARC enforce + BIMI record + VMC verified
 *   A  = DMARC enforce + BIMI record (no VMC)
 *   B  = DMARC enforce, no BIMI
 *   C  = DMARC quarantine, no BIMI
 *   D  = DMARC none/reporting only
 *   F  = No DMARC at all
 */
export async function scanBIMI(domain: string, dmarcPolicy: string | null): Promise<BIMIResult> {
  const result: BIMIResult = {
    record: null,
    svg_url: null,
    vmc_url: null,
    vmc_valid: false,
    vmc_expiry: null,
    grade: 'F',
  };

  // Step 1: Determine base DMARC grade
  if (!dmarcPolicy) {
    result.grade = 'F';
    return result;
  }
  if (dmarcPolicy === 'none') { result.grade = 'D'; return result; }
  if (dmarcPolicy === 'quarantine') result.grade = 'C';
  else if (dmarcPolicy === 'reject') result.grade = 'B';
  else { result.grade = 'D'; return result; }

  // Step 2: Look up BIMI DNS record
  try {
    const bimiRecords = await dnsLookup(`default._bimi.${domain}`, 'TXT');
    const bimiTxt = bimiRecords.find(r => r.includes('v=BIMI1'));

    if (!bimiTxt) {
      // DMARC enforce but no BIMI — grade stays B or C
      return result;
    }

    result.record = bimiTxt;

    // Extract l= (logo URL) and a= (VMC URL)
    const logoMatch = bimiTxt.match(/l=([^;\s]+)/);
    const vmcMatch = bimiTxt.match(/a=([^;\s]+)/);

    if (logoMatch) result.svg_url = logoMatch[1]!.trim();
    if (vmcMatch) result.vmc_url = vmcMatch[1]!.trim();

    // Step 3: Validate SVG is reachable
    if (result.svg_url) {
      try {
        const svgRes = await fetch(result.svg_url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        });
        if (svgRes.ok) {
          // BIMI record + reachable SVG = grade A
          result.grade = 'A';
        }
      } catch {
        // SVG unreachable — keep grade B/C
      }
    }

    // Step 4: Check VMC if present
    if (result.vmc_url && result.grade === 'A') {
      try {
        const vmcRes = await fetch(result.vmc_url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        });
        if (vmcRes.ok) {
          result.vmc_valid = true;
          result.grade = 'A+';

          // Try to get expiry from response headers
          const expires = vmcRes.headers.get('expires');
          if (expires) result.vmc_expiry = expires;
        }
      } catch {
        // VMC unreachable — stay at A
      }
    }
  } catch {
    // DNS lookup failed — return current grade based on DMARC only
  }

  return result;
}

/**
 * Quick BIMI DNS check — returns true if a BIMI TXT record exists.
 * Used by the typosquat scanner to flag suspicious domains.
 */
export async function checkBIMIExists(domain: string): Promise<boolean> {
  try {
    const records = await dnsLookup(`default._bimi.${domain}`, 'TXT');
    return records.some(r => r.includes('v=BIMI1'));
  } catch {
    return false;
  }
}

// ─── DB Save ───────────────────────────────────────────────────────────────

export async function saveEmailSecurityScan(
  db: D1Database,
  brandId: number | string,
  result: EmailSecurityResult,
): Promise<void> {
  await db.prepare(`
    INSERT INTO email_security_scans (
      brand_id, domain,
      dmarc_exists, dmarc_policy, dmarc_pct, dmarc_rua, dmarc_ruf, dmarc_raw,
      dmarc_sp, dmarc_np, dmarc_t, dmarc_psd,
      spf_exists, spf_policy, spf_includes, spf_too_many_lookups, spf_raw,
      dkim_exists, dkim_selectors_found, dkim_raw,
      mx_exists, mx_providers,
      email_security_score, email_security_grade, score_rubric_version,
      scanned_at, scan_duration_ms
    ) VALUES (
      ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      datetime('now'), ?
    )
  `).bind(
    brandId, result.domain,
    result.dmarc.exists ? 1 : 0, result.dmarc.policy, result.dmarc.pct,
    result.dmarc.exists ? result.dmarc.rua ?? null : null,
    result.dmarc.exists ? result.dmarc.ruf ?? null : null,
    result.dmarc.record,
    result.dmarc.exists ? result.dmarc.sp ?? null : null,
    result.dmarc.exists ? result.dmarc.np ?? null : null,
    result.dmarc.exists ? result.dmarc.t ?? null : null,
    result.dmarc.exists ? result.dmarc.psd ?? null : null,
    result.spf.exists ? 1 : 0, result.spf.policy, 0, result.spf.too_many_lookups ? 1 : 0, result.spf.record,
    result.dkim.exists ? 1 : 0,
    JSON.stringify(result.dkim.selectors_found),
    result.dkim.exists ? `Selectors: ${result.dkim.selectors_found.join(', ')}` : null,
    result.mx.exists ? 1 : 0,
    JSON.stringify(result.mx.providers),
    result.score, result.grade, result.score_rubric_version,
    result.scan_duration_ms,
  ).run();
}
