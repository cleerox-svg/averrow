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
import { dohTxtLookupDetailed } from './lib/doh';
import { validDnsName } from './lib/dnsbl-doh';
import { parseSpfRecord, selectSpfRecords } from './lib/spf-record';
import {
  walkSpfTree,
  SPF_MAX_DNS_LOOKUPS,
  SPF_MAX_VOID_LOOKUPS,
  SPF_WALK_BUDGET_MS,
  type SpfTxtLookup,
  type SpfWalkResult,
} from './lib/spf-walk';

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
 *   3 — SPF include-tree walk: proven >10 lookups, a proven include loop
 *       or multiple SPF records (permerror) keep only the record-exists
 *       credit; `+all` (incl. a bare `all`) scores 0 for SPF; a
 *       redirect-only record takes its target's `all` — and gets no policy
 *       credit when that target cannot be read, so an unreadable redirect
 *       target DOES lower the score; an unread include adds and removes
 *       nothing; a failed root lookup carries the previous scan's SPF
 *       forward or scores SPF as not checked (2026-11)
 */
export const EMAIL_SCORE_RUBRIC_VERSION = 3;

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
//
// RFC 7208 parsing lives in lib/spf-record.ts and the bounded include-tree
// walk (10-lookup / 2-void-lookup limits, loops, hard query + time caps) in
// lib/spf-walk.ts. Findings become recommendations only — no alert type.

/** What the SPF check concluded, as stored in
 *  `email_security_scans.spf_walk_status` (migration 0332):
 *   complete   — the include tree was read as far as needed (a walk that
 *                stopped at a proven >10 lookups is complete)
 *   unknown    — an include / redirect lookup failed or timed out, or a
 *                walk cap was reached; tree counts are lower bounds
 *   no_record  — no SPF record at the domain
 *   not_walked — multiple SPF records (permerror before any evaluation)
 *   root_error — the domain's own TXT lookup failed and nothing was carried
 *                forward: SPF was NOT checked (stored spf_exists is NULL,
 *                never a confirmed 0)
 *   carried_legacy — a root failure carried forward a scan stored before
 *                migration 0332 (no walk data): SPF values are real but the
 *                walk-derived part is unknown, so grade-change detection
 *                treats it as SPF-uncertain
 *  A root failure carrying forward a post-0332 scan keeps that scan's
 *  status and adds the `root_lookup_failed` finding. */
export type SpfWalkStatusStored =
  | 'complete' | 'unknown' | 'no_record' | 'not_walked' | 'root_error' | 'carried_legacy';

export const SPF_WALK_STATUSES: readonly SpfWalkStatusStored[] = [
  'complete', 'unknown', 'no_record', 'not_walked', 'root_error', 'carried_legacy',
];

export function storedSpfWalkStatus(v: string | null | undefined): SpfWalkStatusStored | null {
  return SPF_WALK_STATUSES.find((s) => s === v) ?? null;
}

export type SpfFindingCode =
  | 'lookup_limit_exceeded'
  | 'void_lookup_limit_exceeded'
  | 'multiple_records'
  | 'include_multiple_records'
  | 'pass_all'
  | 'include_pass_all'
  | 'neutral_all'
  | 'ptr_mechanism'
  | 'syntax_error'
  | 'include_loop'
  | 'include_target_missing'
  | 'walk_incomplete'
  | 'root_lookup_failed';

export const SPF_FINDING_CODES: readonly SpfFindingCode[] = [
  'lookup_limit_exceeded', 'void_lookup_limit_exceeded', 'multiple_records',
  'include_multiple_records', 'pass_all', 'include_pass_all', 'neutral_all', 'ptr_mechanism',
  'syntax_error', 'include_loop', 'include_target_missing', 'walk_incomplete', 'root_lookup_failed',
];

/** Findings that describe the domain's OWN record (or the root lookup),
 *  not the include tree below it. */
export const SPF_ROOT_FINDING_CODES: ReadonlySet<SpfFindingCode> = new Set<SpfFindingCode>([
  'multiple_records', 'pass_all', 'neutral_all', 'root_lookup_failed',
]);

function isSpfFindingCode(v: unknown): v is SpfFindingCode {
  return typeof v === 'string' && SPF_FINDING_CODES.some((c) => c === v);
}

/** Structured finding — no free text from DNS: `names` are validated DNS
 *  names, `count` a number (`atLeast` = lower bound). Stored as JSON in
 *  `spf_findings`. */
export interface SpfFinding {
  code: SpfFindingCode;
  names?: string[];
  count?: number;
  atLeast?: boolean;
}

export interface SpfResult {
  exists: boolean;
  /** Effective `all`: '-all' | '~all' | '?all' | '+all' (a bare `all` is
   *  '+all'); from the redirect chain when the record has no `all`. */
  policy: string | null;
  includes: number;
  /** PROVEN over the 10-lookup limit (never inferred from an unread part). */
  tooManyLookups: boolean;
  raw: string | null;
  /** Fields below are optional so stored-row callers (reports) compile. */
  recordCount?: number;
  lookupCount?: number | null;
  voidLookups?: number | null;
  walkStatus?: SpfWalkStatusStored | null;
  findings?: SpfFinding[];
  /** The domain's own TXT lookup failed and nothing was carried forward:
   *  SPF was not checked (no points, no "No SPF record" message). */
  rootError?: boolean;
}

const SPF_ROOT_TIMEOUT_MS = 5_000;
const MAX_FINDING_NAMES = 5;

/** Uncached DoH TXT lookup (the scanner has no Worker env). */
const spfTxtLookup: SpfTxtLookup = (name, timeoutMs) =>
  dohTxtLookupDetailed({}, name, 3_600, { timeoutMs });

function validNames(names: readonly string[]): string[] {
  return names
    .map((n) => validDnsName(n))
    .filter((n): n is string => n !== null)
    .slice(0, MAX_FINDING_NAMES);
}

/** SPF state when the domain's own TXT lookup failed and no previous scan
 *  could be carried forward. */
export function spfNotChecked(): SpfResult {
  return {
    exists: false, policy: null, includes: 0, tooManyLookups: false, raw: null,
    recordCount: 0, lookupCount: null, voidLookups: null,
    walkStatus: 'root_error', findings: [{ code: 'root_lookup_failed' }], rootError: true,
  };
}

/**
 * A previous scan's SPF result carried forward over a failed root lookup:
 * same values (the score does not move on a DNS hiccup) plus the
 * `root_lookup_failed` finding.
 */
export function carrySpfForward(previous: SpfResult): SpfResult {
  const findings = (previous.findings ?? []).filter((f) => f.code !== 'root_lookup_failed');
  return {
    ...previous,
    rootError: false,
    // A pre-0332 row has no walk status: never store it as 'no_record' next
    // to spf_exists = 1.
    walkStatus: previous.walkStatus ?? 'carried_legacy',
    findings: [...findings, { code: 'root_lookup_failed' }],
  };
}

/** Shared time budget for the SPF root lookup + include-tree walk. */
export interface SpfCheckBudget {
  /** Timeout of the domain's own TXT lookup. */
  rootTimeoutMs: number;
  /** Root lookup + walk together; the walk gets what is left (≤ SPF_WALK_BUDGET_MS). */
  totalMs: number;
}

/**
 * Budget for the wall-clock-capped scans (public free scan, scan-only
 * report: EMAIL_SCAN_BUDGET_MS = 8 s, lib/free-scan-view.ts): 3 s root +
 * walk within 6.5 s total, so SPF finishes inside the cap with headroom.
 * Other callers keep the 5 s root timeout + 4 s walk.
 */
export const CAPPED_SCAN_SPF_BUDGET: SpfCheckBudget = { rootTimeoutMs: 3_000, totalMs: 6_500 };

/**
 * Build the SPF result from the root TXT answers and the walk (pure;
 * exported for tests). `walk` is null when the tree was not walked (no
 * record, multiple records, root lookup failed).
 */
export function buildSpfResult(
  domain: string,
  rootStatus: 'ok' | 'nxdomain' | 'error',
  rootTxt: readonly string[],
  walk: SpfWalkResult | null,
): SpfResult {
  if (rootStatus === 'error') return spfNotChecked();
  const spfRecords = rootStatus === 'ok' ? selectSpfRecords(rootTxt) : [];
  const parsed = spfRecords.length > 0 ? parseSpfRecord(spfRecords[0]) : null;
  if (!parsed) {
    return {
      exists: false, policy: null, includes: 0, tooManyLookups: false, raw: null,
      recordCount: 0, lookupCount: null, voidLookups: null, walkStatus: 'no_record', findings: [],
    };
  }

  const qualifier = walk ? walk.effectiveAllQualifier : parsed.allQualifier;
  const policy = qualifier ? `${qualifier}all` : null;
  const lookupCount = walk ? walk.lookupCount : parsed.lookupTerms;
  const voidLookups = walk ? walk.voidLookups : null;
  const tooManyLookups = lookupCount > SPF_MAX_DNS_LOOKUPS;
  const countIsLowerBound = !!walk && (walk.status === 'unknown' || walk.stoppedAtLimit);
  const rootName = validDnsName(domain);
  const rootOnly = rootName ? [rootName] : [];

  const findings: SpfFinding[] = [];
  if (spfRecords.length > 1) findings.push({ code: 'multiple_records', count: spfRecords.length });
  if (tooManyLookups) {
    findings.push(countIsLowerBound
      ? { code: 'lookup_limit_exceeded', count: lookupCount, atLeast: true }
      : { code: 'lookup_limit_exceeded', count: lookupCount });
  }
  if (voidLookups !== null && voidLookups > SPF_MAX_VOID_LOOKUPS) {
    findings.push({ code: 'void_lookup_limit_exceeded', count: voidLookups });
  }
  if (policy === '+all') findings.push({ code: 'pass_all' });
  if (policy === '?all') findings.push({ code: 'neutral_all' });
  if (walk ? walk.syntaxErrorAt.length > 0 : parsed.syntaxErrors.length > 0) {
    findings.push({ code: 'syntax_error', names: validNames(walk ? walk.syntaxErrorAt : rootOnly) });
  }
  if (walk ? walk.ptrAt.length > 0 : parsed.usesPtr) {
    findings.push({ code: 'ptr_mechanism', names: validNames(walk ? walk.ptrAt : rootOnly) });
  }
  if (walk && walk.loopAt.length > 0) findings.push({ code: 'include_loop', names: validNames(walk.loopAt) });
  if (walk && walk.includePassAllAt.length > 0) {
    findings.push({ code: 'include_pass_all', names: validNames(walk.includePassAllAt) });
  }
  if (walk && walk.multipleRecordsAt.length > 0) {
    findings.push({ code: 'include_multiple_records', names: validNames(walk.multipleRecordsAt) });
  }
  if (walk && walk.missingRecordAt.length > 0) {
    findings.push({ code: 'include_target_missing', names: validNames(walk.missingRecordAt) });
  }
  if (walk && walk.status === 'unknown') findings.push({ code: 'walk_incomplete', count: lookupCount });

  return {
    exists: true,
    policy,
    includes: parsed.includeTargets.length,
    tooManyLookups,
    raw: spfRecords[0]!,
    recordCount: spfRecords.length,
    lookupCount,
    voidLookups,
    walkStatus: walk ? walk.status : 'not_walked',
    findings,
  };
}

/** Loads the brand's previous stored SPF result. Called ONLY when the root
 *  lookup failed, so it costs nothing on a normal scan. */
export type PreviousSpfLoader = () => Promise<SpfResult | null>;

/**
 * Fetch the domain's SPF record (≤ 5 s) and walk its include tree
 * (≤ SPF_WALK_MAX_QUERIES queries, ≤ SPF_WALK_BUDGET_MS). On a root lookup
 * error the previous scan is carried forward when `previous` yields one,
 * else SPF is "not checked". Never throws.
 */
export async function checkSpf(
  domain: string,
  lookup: SpfTxtLookup = spfTxtLookup,
  previous?: PreviousSpfLoader,
  budget?: SpfCheckBudget,
): Promise<SpfResult> {
  const start = Date.now();
  let root: { status: 'ok' | 'nxdomain' | 'error'; records: string[] };
  try {
    root = await lookup(domain, budget ? budget.rootTimeoutMs : SPF_ROOT_TIMEOUT_MS);
  } catch {
    root = { status: 'error', records: [] };
  }
  if (root.status === 'error') {
    let prev: SpfResult | null = null;
    try { prev = previous ? await previous() : null; } catch { prev = null; }
    return prev && !prev.rootError ? carrySpfForward(prev) : spfNotChecked();
  }
  const spfRecords = root.status === 'ok' ? selectSpfRecords(root.records) : [];
  const parsed = spfRecords.length === 1 ? parseSpfRecord(spfRecords[0]) : null;
  // Multiple records are a permerror before any evaluation — not walked.
  const walkOpts = budget
    ? { budgetMs: Math.max(0, Math.min(SPF_WALK_BUDGET_MS, budget.totalMs - (Date.now() - start))) }
    : {};
  const walk = parsed ? await walkSpfTree(domain, parsed, lookup, walkOpts) : null;
  return buildSpfResult(domain, root.status, root.records, walk);
}

/**
 * True when the SPF state is a receiver permerror the score reflects:
 * PROVEN more than 10 lookups, a proven include loop (a receiver can only
 * end it at the lookup limit), or more than one SPF record at the domain.
 * Include targets with no / multiple SPF records and syntax errors are NOT
 * scored (recommendations only).
 */
export function isSpfPermerror(spf: SpfResult): boolean {
  return spf.tooManyLookups
    || (spf.findings ?? []).some((f) => f.code === 'multiple_records' || f.code === 'include_loop');
}

// ─── Stored rows ───────────────────────────────────────────────────────────

/** email_security_scans columns a scan's score and recommendations are
 *  rebuilt from (constant SQL column list, never user input). */
export const STORED_EMAIL_SCAN_COLUMNS = `
  dmarc_exists, dmarc_policy, dmarc_pct, dmarc_rua, dmarc_sp, dmarc_np, dmarc_t,
  spf_exists, spf_policy, spf_too_many_lookups, spf_raw,
  spf_lookup_count, spf_void_lookups, spf_walk_status, spf_findings,
  dkim_exists, dkim_selectors_found, mx_exists, mx_providers`;

/** A stored scan row (STORED_EMAIL_SCAN_COLUMNS). Columns from later
 *  migrations are optional (NULL on older rows). */
export interface StoredEmailScanRow {
  dmarc_exists: number; dmarc_policy: string | null; dmarc_pct: number | null; dmarc_rua: string | null;
  dmarc_sp: string | null; dmarc_np: string | null; dmarc_t: string | null;
  /** NULL = SPF not checked (root lookup failed; migration 0332). */
  spf_exists: number | null; spf_policy: string | null; spf_too_many_lookups: number;
  spf_raw?: string | null;
  spf_lookup_count?: number | null; spf_void_lookups?: number | null;
  spf_walk_status?: string | null; spf_findings?: string | null;
  dkim_exists: number; dkim_selectors_found: string | null;
  mx_exists: number; mx_providers: string | null;
}

function jsonStringArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/** SpfResult rebuilt from a stored row. */
export function spfFromStoredRow(row: StoredEmailScanRow): SpfResult {
  const walkStatus = storedSpfWalkStatus(row.spf_walk_status);
  return {
    exists: row.spf_exists === 1,
    policy: row.spf_policy,
    includes: 0,
    tooManyLookups: !!row.spf_too_many_lookups,
    raw: row.spf_raw ?? null,
    lookupCount: row.spf_lookup_count ?? null,
    voidLookups: row.spf_void_lookups ?? null,
    walkStatus,
    findings: parseStoredSpfFindings(row.spf_findings),
    rootError: row.spf_exists === null && walkStatus === 'root_error',
  };
}

/**
 * Scoring / recommendation input rebuilt from a stored email_security_scans
 * row, including the RFC 9989 inputs (pct, sp, np, t) and the SPF walk
 * columns, so a rebuilt score carries every penalty the stored grade has.
 */
export function scanInputFromStoredRow(row: StoredEmailScanRow): EmailSecurityScanInput {
  return {
    dmarc: {
      exists: !!row.dmarc_exists, policy: row.dmarc_policy,
      pct: row.dmarc_pct, rua: row.dmarc_rua, ruf: null, raw: null,
      sp: row.dmarc_sp, np: row.dmarc_np, t: row.dmarc_t,
    },
    spf: spfFromStoredRow(row),
    dkim: { exists: !!row.dkim_exists, selectorsFound: jsonStringArray(row.dkim_selectors_found), raw: null },
    mx: { exists: !!row.mx_exists, providers: jsonStringArray(row.mx_providers) },
  };
}

type StoredSpfColumns = Pick<StoredEmailScanRow,
  'spf_exists' | 'spf_policy' | 'spf_too_many_lookups' | 'spf_raw' | 'spf_lookup_count'
  | 'spf_void_lookups' | 'spf_walk_status' | 'spf_findings'>;

/** The SPF columns saveEmailSecurityScan writes for a result. */
function storedSpfColumns(spf: EmailSecurityResult['spf']): StoredSpfColumns {
  return {
    // A failed root lookup is never stored as a confirmed "no SPF".
    spf_exists: spf.walk_status === 'root_error' ? null : spf.exists ? 1 : 0,
    spf_policy: spf.policy,
    spf_too_many_lookups: spf.too_many_lookups ? 1 : 0,
    spf_raw: spf.record,
    spf_lookup_count: spf.lookup_count ?? null,
    spf_void_lookups: spf.void_lookups ?? null,
    spf_walk_status: spf.walk_status ?? null,
    spf_findings: spf.findings ? JSON.stringify(spf.findings) : null,
  };
}

/** The stored row saveEmailSecurityScan writes for a result (so a fresh
 *  scan is compared with a stored one on equal terms). */
export function storedRowFromResult(result: EmailSecurityResult): StoredEmailScanRow {
  return {
    dmarc_exists: result.dmarc.exists ? 1 : 0,
    dmarc_policy: result.dmarc.policy,
    dmarc_pct: result.dmarc.pct,
    dmarc_rua: result.dmarc.exists ? result.dmarc.rua ?? null : null,
    dmarc_sp: result.dmarc.exists ? result.dmarc.sp ?? null : null,
    dmarc_np: result.dmarc.exists ? result.dmarc.np ?? null : null,
    dmarc_t: result.dmarc.exists ? result.dmarc.t ?? null : null,
    ...storedSpfColumns(result.spf),
    dkim_exists: result.dkim.exists ? 1 : 0,
    dkim_selectors_found: JSON.stringify(result.dkim.selectors_found),
    mx_exists: result.mx.exists ? 1 : 0,
    mx_providers: JSON.stringify(result.mx.providers),
  };
}

/**
 * Previous-scan loader for checkSpf: the SPF of the brand's latest scan
 * whose SPF was actually CHECKED (skipping "not checked" rows, so a run of
 * root failures keeps carrying the last real result and never becomes the
 * grade-change baseline), or null when there is none. One read on
 * idx_ess_brand_scanned, made only on a root lookup failure.
 */
export function previousSpfLoader(db: D1Database, brandId: number | string): PreviousSpfLoader {
  return async () => {
    const row = await db.prepare(`
      SELECT ${STORED_EMAIL_SCAN_COLUMNS} FROM email_security_scans
      WHERE brand_id = ? AND spf_exists IS NOT NULL
      ORDER BY scanned_at DESC LIMIT 1
    `).bind(brandId).first<StoredEmailScanRow>();
    if (!row || row.spf_exists === null) return null;
    return spfFromStoredRow(row);
  };
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

  // SPF (30 points max). Rubric 3:
  //   - `+all` (or a bare `all`) authorises every sender → 0 for SPF.
  //   - Permerror — PROVEN more than 10 DNS lookups across the include
  //     tree, a proven include loop, or more than one SPF record at the
  //     domain — keeps only the record-exists credit: receivers return
  //     permerror, so the `all` policy never applies.
  //   - An unread include adds and removes nothing (tooManyLookups is set
  //     only when the part read already exceeds 10). An unreadable
  //     redirect target is different: the effective `all` is then unknown
  //     (null), which earns no policy credit and DOES lower the score.
  //   - Root lookup failure: the caller carries the previous scan forward,
  //     else SPF is not checked (exists=false → 0 points; recommendations
  //     say "could not check", and grade-change alerting holds SPF to the
  //     previous scan — lib/email-grade-change.ts).
  //   - Void lookups, ptr, syntax errors, include targets with no or
  //     multiple SPF records, and `+all` inside an include are
  //     recommendations only.
  if (scan.spf.exists && scan.spf.policy !== '+all') {
    score += 10; // Has SPF record
    if (!isSpfPermerror(scan.spf)) {
      if (scan.spf.policy === '-all') score += 15;      // Hard fail
      else if (scan.spf.policy === '~all') score += 10;  // Soft fail
      else if (scan.spf.policy === '?all') score += 3;   // Neutral
      score += 5;                                        // Under lookup limit
    }
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

  if (scan.spf.rootError) {
    recs.push('Could not check the SPF record: the DNS lookup for your domain failed. It will be checked again on the next scan.');
  } else if (!scan.spf.exists) {
    recs.push('CRITICAL: No SPF record found. Email receivers cannot verify your authorized mail servers.');
  } else if (scan.spf.policy === '~all' || scan.spf.policy === '?all') {
    recs.push('SPF soft-fail detected. Upgrade to "-all" (hard fail) for stronger protection.');
  }

  recs.push(...spfFindingRecommendations(scan.spf));

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

/**
 * Recommendation text for each SPF finding. Only fixed text, validated DNS
 * names and numbers — never record content. Exported for tests.
 */
export function spfFindingRecommendations(spf: SpfResult): string[] {
  if (!spf.exists) return []; // no record, or not checked (handled by the caller)
  const recs: string[] = [];
  const findings = spf.findings ?? [];
  const has = (code: SpfFindingCode) => findings.some((f) => f.code === code);
  const list = (names: string[] | undefined): string =>
    names && names.length > 0 ? ` (${names.slice(0, 3).join(', ')})` : '';

  for (const f of findings) {
    switch (f.code) {
      case 'multiple_records':
        recs.push('CRITICAL: More than one SPF record is published — RFC 7208 makes this a permerror, so SPF fails for all your mail. Merge them into a single v=spf1 record.');
        break;
      case 'lookup_limit_exceeded':
        recs.push(`CRITICAL: SPF needs ${f.atLeast || has('walk_incomplete') ? 'at least ' : ''}${f.count ?? 'more than 10'} DNS lookups (limit 10) — receivers return permerror and SPF fails for all your mail. Remove or flatten includes.`);
        break;
      case 'void_lookup_limit_exceeded':
        recs.push(`WARNING: SPF has ${f.count ?? 'more than 2'} void lookups (limit 2): includes or redirects pointing at names with no DNS records. Many receivers return permerror; remove them.`);
        break;
      case 'pass_all':
        recs.push('CRITICAL: SPF ends in "+all" (or a bare "all"), which authorizes every server on the internet to send as your domain. Use "-all".');
        break;
      case 'include_multiple_records':
        recs.push(`WARNING: An SPF include/redirect target publishes more than one SPF record${list(f.names)} — receivers return permerror for it. Ask that provider to fix it, or remove the include.`);
        break;
      case 'ptr_mechanism':
        recs.push(`SPF uses the deprecated "ptr" mechanism${list(f.names)} (RFC 7208 §5.5) — slow, unreliable and ignored by some receivers. Replace it with ip4/ip6 or include.`);
        break;
      case 'syntax_error':
        recs.push(`WARNING: SPF syntax error${list(f.names)} — receivers return permerror for that record. Check it with an SPF validator.`);
        break;
      case 'include_loop':
        recs.push(`CRITICAL: SPF include chain loops back on itself${list(f.names)} — receivers hit the lookup limit and return permerror, so SPF fails for all your mail.`);
        break;
      case 'include_pass_all':
        recs.push(`WARNING: An included SPF record ends in "+all"${list(f.names)} — any sender that reaches that include passes SPF for your domain. Remove the include or ask its owner to fix it.`);
        break;
      case 'root_lookup_failed':
        recs.push('The SPF record could not be re-checked on this scan (DNS lookup failed); the result shown is from the previous scan.');
        break;
      case 'include_target_missing':
        recs.push(`WARNING: SPF include/redirect target has no SPF record or does not exist${list(f.names)} — receivers return permerror. Remove it: a lapsed target domain can be re-registered by an attacker who would then pass your SPF.`);
        break;
      case 'walk_incomplete':
        recs.push(`The SPF include tree could not be fully checked (a DNS lookup failed or a scan limit was reached); ${f.count ?? 0} DNS lookups were counted in the part that was read.`);
        break;
      case 'neutral_all':
        break; // covered by the soft-fail recommendation
    }
  }
  // Rows stored before rubric 3 carry only the boolean / policy.
  if (spf.tooManyLookups && !has('lookup_limit_exceeded')) {
    recs.push('SPF record exceeds 10 DNS lookups — this causes SPF validation failures.');
  }
  if (spf.policy === '+all' && !has('pass_all')) {
    recs.push('CRITICAL: SPF ends in "+all", which authorizes every server on the internet to send as your domain. Use "-all".');
  }
  return recs;
}

/**
 * Parse a stored `spf_findings` JSON column (migration 0332). Unknown
 * codes, names that are not valid DNS names, and malformed JSON are
 * dropped — the column is never trusted as free text.
 */
export function parseStoredSpfFindings(json: string | null | undefined): SpfFinding[] {
  if (!json) return [];
  let v: unknown;
  try { v = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(v)) return [];
  const out: SpfFinding[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const o = item as { code?: unknown; names?: unknown; count?: unknown; atLeast?: unknown };
    if (!isSpfFindingCode(o.code)) continue;
    const f: SpfFinding = { code: o.code };
    if (Array.isArray(o.names)) f.names = validNames(o.names.filter((n): n is string => typeof n === 'string'));
    if (typeof o.count === 'number' && Number.isFinite(o.count)) f.count = Math.max(0, Math.floor(o.count));
    if (o.atLeast === true) f.atLeast = true;
    out.push(f);
  }
  return out;
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
    /** DNS-querying terms across the include tree (lower bound when
     *  walk_status is 'unknown'); null without a record. Optional so
     *  callers that build a result by hand compile. */
    lookup_count?: number | null;
    void_lookups?: number | null;
    walk_status?: SpfWalkStatusStored;
    findings?: SpfFinding[];
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

export interface EmailSecurityScanOptions {
  /** Brand scans pass `previousSpfLoader(db, brandId)` so a failed SPF root
   *  lookup carries the previous scan forward instead of "not checked". */
  previousSpf?: PreviousSpfLoader;
  /** Shared SPF root + walk budget (CAPPED_SCAN_SPF_BUDGET for the
   *  wall-clock-capped scans); default 5 s root + 4 s walk. */
  spfBudget?: SpfCheckBudget;
}

export async function runEmailSecurityScan(
  domain: string,
  opts: EmailSecurityScanOptions = {},
): Promise<EmailSecurityResult> {
  const startTime = Date.now();

  const [dmarc, spf, dkim, mx] = await Promise.all([
    checkDmarc(domain),
    checkSpf(domain, undefined, opts.previousSpf, opts.spfBudget),
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
      lookup_count: spf.lookupCount ?? null,
      void_lookups: spf.voidLookups ?? null,
      walk_status: spf.walkStatus ?? 'no_record',
      findings: spf.findings ?? [],
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
  // spf_exists is NULL (not 0) when the root lookup failed — see
  // storedSpfColumns.
  const spf = storedSpfColumns(result.spf);
  await db.prepare(`
    INSERT INTO email_security_scans (
      brand_id, domain,
      dmarc_exists, dmarc_policy, dmarc_pct, dmarc_rua, dmarc_ruf, dmarc_raw,
      dmarc_sp, dmarc_np, dmarc_t, dmarc_psd,
      spf_exists, spf_policy, spf_includes, spf_too_many_lookups, spf_raw,
      spf_lookup_count, spf_void_lookups, spf_walk_status, spf_findings,
      dkim_exists, dkim_selectors_found, dkim_raw,
      mx_exists, mx_providers,
      email_security_score, email_security_grade, score_rubric_version,
      scanned_at, scan_duration_ms
    ) VALUES (
      ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
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
    spf.spf_exists, spf.spf_policy, 0, spf.spf_too_many_lookups, spf.spf_raw ?? null,
    spf.spf_lookup_count ?? null, spf.spf_void_lookups ?? null, spf.spf_walk_status ?? null,
    spf.spf_findings ?? null,
    result.dkim.exists ? 1 : 0,
    JSON.stringify(result.dkim.selectors_found),
    result.dkim.exists ? `Selectors: ${result.dkim.selectors_found.join(', ')}` : null,
    result.mx.exists ? 1 : 0,
    JSON.stringify(result.mx.providers),
    result.score, result.grade, result.score_rubric_version,
    result.scan_duration_ms,
  ).run();
}
