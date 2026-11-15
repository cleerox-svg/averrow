/**
 * Bounded SPF include-tree walk (RFC 7208 §4.6.4 processing limits).
 *
 * Starting from a domain's already-fetched SPF record, follows every
 * evaluated `include:` and an applicable `redirect=` over DoH TXT queries
 * and counts, the way a receiver would on a worst-case evaluation:
 *   - DNS-querying terms (`include`, `a`, `mx`, `ptr`, `exists`,
 *     `redirect`) against the limit of 10 (over → permerror);
 *   - void lookups (an include / redirect target that is NXDOMAIN or has no
 *     TXT answers at all) against the limit of 2;
 *   - loops (a target already on the current include path).
 * `a`, `mx`, `ptr` and `exists` are COUNTED but not resolved, so void
 * lookups are measured on include / redirect targets only (a lower bound).
 * Duplicate includes are counted per occurrence (a receiver evaluates them
 * again) but fetched once.
 *
 * The walk stops as soon as more than 10 lookups are proven (a receiver
 * permerrors at that point too), so the reported count is then "at least"
 * (`stoppedAtLimit`). Every followed target is itself a counted lookup, so
 * a walk issues at most ~11 queries before that stop; the query cap below
 * is defence in depth. Every term of a record is scanned (ip4/ip6 terms
 * cost nothing and never make a walk unknown); only a record longer than
 * SPF_MAX_RECORD_LENGTH (64 KiB) is cut, making the walk `unknown`
 * (reason `record_too_long`).
 *
 * Amplification defence. The records walked come from third-party DNS and
 * the public scan endpoint takes attacker-chosen domains, so an attacker
 * controls the fan-out. Every walk is hard-capped (named constants below):
 * SPF_WALK_MAX_QUERIES DoH queries, SPF_WALK_BUDGET_MS wall time (each query
 * gets only what is left and is raced against it), SPF_WALK_MAX_DEPTH
 * nesting, SPF_WALK_MAX_VISITS record evaluations (CPU; a diamond of
 * duplicate includes re-counts without re-querying), names deduped. A name
 * is queried only when it is a valid public DNS name: no macros, no IP
 * literals, no malformed / over-long names, no internal or reserved TLDs.
 *
 * Honesty rule (same as lib/dnsbl-doh.ts): a lookup failure, timeout or a
 * cap being reached makes the walk `unknown` — never "pass", never "fail".
 * Counts are then lower bounds; a limit is reported exceeded only when the
 * part that WAS read already exceeds it.
 */

import { hasSpfMacro, parseSpfRecord, selectSpfRecords, type ParsedSpfRecord, type SpfQualifier } from './spf-record';
import { validDnsName } from './dnsbl-doh';
import type { DohTxtStatus } from './doh';

/** RFC 7208 §4.6.4: more than 10 DNS-querying terms is a permerror. */
export const SPF_MAX_DNS_LOOKUPS = 10;
/** RFC 7208 §4.6.4: implementations SHOULD permerror past 2 void lookups. */
export const SPF_MAX_VOID_LOOKUPS = 2;
/** Hard cap on DoH queries per walk (the root record is fetched by the
 *  caller and not counted). A tree within the 10-lookup limit needs ≤ 10. */
export const SPF_WALK_MAX_QUERIES = 25;
/** Hard wall-clock cap per walk. */
export const SPF_WALK_BUDGET_MS = 4_000;
/** Max include / redirect nesting below the root. */
export const SPF_WALK_MAX_DEPTH = 6;
/** Max record evaluations (repeats included) per walk — bounds CPU. */
export const SPF_WALK_MAX_VISITS = 60;
/** Names reported per finding list. */
const MAX_NAMES_REPORTED = 5;
/** Cap on `targets` / `resolvedTargets` (visits are capped at 60 anyway). */
export const SPF_WALK_MAX_TARGETS_REPORTED = 64;

/** Reserved / internal TLDs that are never queried (RFC 2606, 6761, 6762,
 *  8375, 9476 and common private-network suffixes). */
const NON_PUBLIC_TLDS: ReadonlySet<string> = new Set([
  'localhost', 'local', 'localdomain', 'internal', 'intranet', 'private', 'corp',
  'home', 'lan', 'arpa', 'test', 'invalid', 'example', 'onion', 'alt',
]);

/** Normalised name when `name` may be queried during a walk, else null. */
export function spfWalkName(name: string): string | null {
  if (hasSpfMacro(name)) return null;
  const d = validDnsName(name);
  if (d === null) return null;
  const tld = d.slice(d.lastIndexOf('.') + 1);
  return NON_PUBLIC_TLDS.has(tld) ? null : d;
}

export type SpfTxtLookup = (name: string, timeoutMs: number) => Promise<{ status: DohTxtStatus; records: string[] }>;

export type SpfWalkStatus = 'complete' | 'unknown';

export type SpfWalkIncompleteReason =
  | 'lookup_error' | 'query_cap' | 'time_budget' | 'depth_cap' | 'visit_cap' | 'record_too_long'
  | 'invalid_name' | 'macro';

export interface SpfWalkResult {
  status: SpfWalkStatus;
  /** DNS-querying terms over the whole tree (lower bound when unknown or
   *  stoppedAtLimit). */
  lookupCount: number;
  /** The walk stopped as soon as more than 10 lookups were proven (a
   *  receiver permerrors there too); the rest of the tree was not read. */
  stoppedAtLimit: boolean;
  /** Void include / redirect targets (lower bound when unknown). */
  voidLookups: number;
  /** DoH queries issued. */
  queries: number;
  incompleteReasons: SpfWalkIncompleteReason[];
  /** `all` qualifier in force for the root: its own, else the one reached
   *  through its redirect chain; null when none / not read. */
  effectiveAllQualifier: SpfQualifier | null;
  /** Names (validated, ≤ 5 each) where each condition was seen. */
  loopAt: string[];
  multipleRecordsAt: string[];
  syntaxErrorAt: string[];
  missingRecordAt: string[];
  /** Subset of `missingRecordAt` whose TXT answer was NXDOMAIN (the name does
   *  not exist at all), as opposed to existing with no SPF record. Input to
   *  the dangling-include check (lib/spf-dangling.ts). */
  nxdomainAt: string[];
  ptrAt: string[];
  /** `+all` / bare `all` in a record reached through an include. */
  includePassAllAt: string[];
  /** Every include / redirect target name the walk followed (validated,
   *  ≤ SPF_WALK_MAX_TARGETS_REPORTED). Input to the newly-registered check
   *  (email-security.ts): is a name still in the tree? */
  targets: string[];
  /** Subset of `targets` whose TXT answer showed the name EXISTS (records,
   *  or NOERROR with no TXT) — never NXDOMAIN, never a failed lookup. */
  resolvedTargets: string[];
}

export interface SpfWalkOptions {
  maxQueries?: number;
  budgetMs?: number;
  maxDepth?: number;
  maxVisits?: number;
  /** Clock (tests). */
  now?: () => number;
}

type Fetched =
  | { kind: 'ok'; record: ParsedSpfRecord }
  | { kind: 'void'; nx: boolean }  // NXDOMAIN / no TXT answers
  | { kind: 'none' }       // TXT answers, none of them SPF
  | { kind: 'multiple' }   // more than one SPF record (permerror)
  | { kind: 'unknown'; reason: SpfWalkIncompleteReason };

class NameSet {
  private readonly s = new Set<string>();
  constructor(private readonly cap: number = MAX_NAMES_REPORTED) {}
  add(n: string): void { if (this.s.size < this.cap) this.s.add(n); }
  list(): string[] { return [...this.s]; }
}

/** Resolve `p` or reject after `ms`, whichever comes first. */
/** Our own deadline fired (a timer can fire a millisecond before the clock
 *  reaches the deadline, so the clock alone cannot tell the two apart). */
class SpfWalkTimeout extends Error {
  constructor() { super('spf walk lookup timed out'); }
}

async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SpfWalkTimeout()), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Walk the include / redirect tree under `root` (the record already
 * published at `rootDomain`). Never throws; all I/O goes through `lookup`.
 */
export async function walkSpfTree(
  rootDomain: string,
  root: ParsedSpfRecord,
  lookup: SpfTxtLookup,
  opts: SpfWalkOptions = {},
): Promise<SpfWalkResult> {
  const now = opts.now ?? Date.now;
  const maxQueries = opts.maxQueries ?? SPF_WALK_MAX_QUERIES;
  const maxDepth = opts.maxDepth ?? SPF_WALK_MAX_DEPTH;
  const maxVisits = opts.maxVisits ?? SPF_WALK_MAX_VISITS;
  const deadline = now() + (opts.budgetMs ?? SPF_WALK_BUDGET_MS);

  let lookupCount = 0;
  let voidLookups = 0;
  let queries = 0;
  let visits = 0;
  /** Set once the walk must not do any further per-target work: limit
   *  proven, visit / query / time cap reached. */
  let halted = false;
  let stoppedAtLimit = false;
  const reasons = new Set<SpfWalkIncompleteReason>();
  const loopAt = new NameSet();
  const multipleRecordsAt = new NameSet();
  const syntaxErrorAt = new NameSet();
  const missingRecordAt = new NameSet();
  const nxdomainAt = new NameSet();
  const ptrAt = new NameSet();
  const includePassAllAt = new NameSet();
  const targets = new NameSet(SPF_WALK_MAX_TARGETS_REPORTED);
  const resolvedTargets = new NameSet(SPF_WALK_MAX_TARGETS_REPORTED);
  const cache = new Map<string, Fetched>();

  function stop(reason: SpfWalkIncompleteReason): void {
    reasons.add(reason);
    halted = true;
  }

  async function fetchSpf(name: string): Promise<Fetched> {
    const hit = cache.get(name);
    if (hit) return hit;
    if (queries >= maxQueries) return { kind: 'unknown', reason: 'query_cap' };
    const remaining = deadline - now();
    if (remaining <= 0) return { kind: 'unknown', reason: 'time_budget' };
    queries++;
    let res: Fetched;
    try {
      const answer = await raceTimeout(lookup(name, remaining), remaining);
      if (answer.status === 'error') {
        res = { kind: 'unknown', reason: 'lookup_error' };
      } else if (answer.status === 'nxdomain' || answer.records.length === 0) {
        res = { kind: 'void', nx: answer.status === 'nxdomain' };
      } else {
        const spf = selectSpfRecords(answer.records);
        const parsed = spf.length === 1 ? parseSpfRecord(spf[0]) : null;
        res = spf.length === 0 ? { kind: 'none' }
          : spf.length > 1 ? { kind: 'multiple' }
          : parsed ? { kind: 'ok', record: parsed } : { kind: 'none' };
      }
    } catch (err) {
      res = { kind: 'unknown', reason: err instanceof SpfWalkTimeout || now() >= deadline ? 'time_budget' : 'lookup_error' };
    }
    cache.set(name, res);
    return res;
  }

  /** Follow one include / redirect target; returns the target's effective
   *  `all` qualifier (used for the root's redirect chain). */
  async function follow(
    target: string, depth: number, path: readonly string[], viaInclude: boolean,
  ): Promise<SpfQualifier | null> {
    if (halted) return null;
    if (hasSpfMacro(target)) { reasons.add('macro'); return null; }
    const name = spfWalkName(target);
    if (name === null) { reasons.add('invalid_name'); return null; }
    if (path.includes(name)) { loopAt.add(name); return null; }
    if (depth > maxDepth) { reasons.add('depth_cap'); return null; }
    targets.add(name);
    const f = await fetchSpf(name);
    if (f.kind === 'ok' || f.kind === 'none' || f.kind === 'multiple' || (f.kind === 'void' && !f.nx)) {
      resolvedTargets.add(name);
    }
    switch (f.kind) {
      case 'unknown':
        if (f.reason === 'lookup_error') reasons.add(f.reason);
        else stop(f.reason); // query cap / time budget: nothing more can be read
        return null;
      case 'void':
        voidLookups++;
        missingRecordAt.add(name);
        if (f.nx) nxdomainAt.add(name);
        return null;
      case 'none': missingRecordAt.add(name); return null;
      case 'multiple': multipleRecordsAt.add(name); return null;
      case 'ok': return visit(name, f.record, depth, [...path, name], viaInclude);
    }
  }

  async function visit(
    name: string, rec: ParsedSpfRecord, depth: number, path: readonly string[], viaInclude: boolean,
  ): Promise<SpfQualifier | null> {
    if (halted) return null;
    if (++visits > maxVisits) { stop('visit_cap'); return null; }
    if (rec.truncated) reasons.add('record_too_long');
    if (rec.syntaxErrors.length > 0) syntaxErrorAt.add(name);
    if (rec.usesPtr) ptrAt.add(name);
    if (viaInclude && rec.allQualifier === '+') includePassAllAt.add(name);
    lookupCount += rec.lookupTerms;
    if (lookupCount > SPF_MAX_DNS_LOOKUPS) {
      // Permerror is proven; a receiver stops here too. No further work.
      stoppedAtLimit = true;
      halted = true;
      return rec.allQualifier;
    }
    for (const target of rec.includeTargets) {
      if (halted) break;
      await follow(target, depth + 1, path, true);
    }
    if (rec.allQualifier !== null) return rec.allQualifier;
    if (rec.redirectApplies && rec.redirect !== null) return follow(rec.redirect, depth + 1, path, viaInclude);
    return null;
  }

  const rootName = rootDomain.trim().toLowerCase().replace(/\.$/, '');
  const effectiveAllQualifier = await visit(rootName, root, 0, [rootName], false);

  return {
    status: reasons.size === 0 ? 'complete' : 'unknown',
    lookupCount,
    stoppedAtLimit,
    voidLookups,
    queries,
    incompleteReasons: [...reasons],
    effectiveAllQualifier,
    loopAt: loopAt.list(),
    multipleRecordsAt: multipleRecordsAt.list(),
    syntaxErrorAt: syntaxErrorAt.list(),
    missingRecordAt: missingRecordAt.list(),
    nxdomainAt: nxdomainAt.list(),
    ptrAt: ptrAt.list(),
    includePassAllAt: includePassAllAt.list(),
    targets: targets.list(),
    resolvedTargets: resolvedTargets.list(),
  };
}
