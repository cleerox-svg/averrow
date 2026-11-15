/**
 * SPF record parser — RFC 7208.
 *
 * Pure functions, no I/O (unit-tested in test/spf-record.test.ts). The DNS
 * side — following `include:` / `redirect=` and counting lookups — lives in
 * lib/spf-walk.ts; the posture scanner (email-security.ts) wires the two.
 *
 * What the parser reports for one record:
 *   - every mechanism with its qualifier (`+` default, `-`, `~`, `?`) and
 *     argument: `all`, `include`, `a`, `mx`, `ptr`, `exists`, `ip4`, `ip6`;
 *   - the `redirect=` and `exp=` modifiers (unknown modifiers are ignored,
 *     RFC 7208 §6);
 *   - syntax errors (each one a permerror for a receiver, §4.6): unknown
 *     mechanism, missing / forbidden argument, bad address or CIDR length,
 *     duplicate `redirect` / `exp`, malformed macro;
 *   - how many DNS-querying terms the record itself spends (§4.6.4:
 *     `include`, `a`, `mx`, `ptr`, `exists`, and `redirect` when it
 *     applies). Terms after the first `all` are never evaluated (§5.1), and
 *     `redirect` is ignored when the record has an `all` (§6.1), so neither
 *     counts.
 *   - use of the deprecated `ptr` mechanism (§5.5 "SHOULD NOT be used").
 *
 * Syntax-error strings are fixed text naming only our own vocabulary —
 * never echoed record content (records come from third-party DNS and the
 * findings reach tenant-visible reports).
 */

export type SpfQualifier = '+' | '-' | '~' | '?';

export type SpfMechanismName = 'all' | 'include' | 'a' | 'mx' | 'ptr' | 'exists' | 'ip4' | 'ip6';

export interface SpfMechanism {
  qualifier: SpfQualifier;
  name: SpfMechanismName;
  /** Domain-spec (include/a/mx/ptr/exists) or address (ip4/ip6), CIDR
   *  suffix removed; null when the optional argument is omitted. */
  value: string | null;
}

export interface ParsedSpfRecord {
  mechanisms: SpfMechanism[];
  /** `redirect=` domain-spec, null when absent or malformed. */
  redirect: string | null;
  /** True when `redirect` is present and the record has no `all`. */
  redirectApplies: boolean;
  exp: string | null;
  /** Qualifier of the first `all`, null when the record has no `all`. */
  allQualifier: SpfQualifier | null;
  /** DNS-querying terms evaluated in this record (RFC 7208 §4.6.4). */
  lookupTerms: number;
  /** `include:` targets that are evaluated (before the first `all`). */
  includeTargets: string[];
  /** A `ptr` mechanism is evaluated (deprecated, §5.5). */
  usesPtr: boolean;
  syntaxErrors: string[];
  /** Longer than SPF_MAX_RECORD_LENGTH; only that prefix was parsed, so
   *  everything derived from this record is a lower bound. */
  truncated: boolean;
}

/**
 * Bound on the record text parsed (CPU). Every term up to it is scanned —
 * one cheap regex per term, no per-term I/O — so a long flattened ip4/ip6
 * list keeps its trailing `all`, `redirect=` and lookup counts. 64 KiB is
 * the largest TXT RRset a DNS message can carry; a real record is far
 * shorter. The expensive work (following includes) is bounded by the walk
 * (lib/spf-walk.ts), which stops as soon as >10 lookups are proven.
 */
export const SPF_MAX_RECORD_LENGTH = 65_536;
/** Syntax-error strings kept per record. */
const MAX_SYNTAX_ERRORS = 20;

const LOOKUP_MECHANISMS: ReadonlySet<SpfMechanismName> = new Set(['include', 'a', 'mx', 'ptr', 'exists']);
const MODIFIER_RE = /^([a-z][a-z0-9_.-]*)=(.*)$/i;
const MECHANISM_RE = /^([+\-~?]?)([a-z][a-z0-9_.-]*)(.*)$/i;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9a-f:.]+$/i;
/** `%` must start a macro (`%{`) or one of the escapes `%%`, `%_`, `%-`. */
const BAD_MACRO_RE = /%(?![{%_-])/;

/** True when `txt` is an SPF record (`v=spf1` then a space or the end). */
export function isSpfRecord(txt: string): boolean {
  return /^v=spf1(\s|$)/i.test(txt.trim());
}

/** The SPF records among a name's TXT answers (RFC 7208 §4.5). More than
 *  one is a permerror. */
export function selectSpfRecords(txt: readonly string[]): string[] {
  return txt.filter(isSpfRecord).map((r) => r.trim());
}

/** True when the domain-spec contains SPF macros (`%{…}`), which need the
 *  sender's IP / address to expand and cannot be resolved by a scanner. */
export function hasSpfMacro(domainSpec: string): boolean {
  return domainSpec.includes('%');
}

function validDomainSpec(v: string): boolean {
  return v.length > 0 && !/\s/.test(v) && !BAD_MACRO_RE.test(v);
}

function cidrOk(bits: string | undefined, max: number): boolean {
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  const n = parseInt(bits, 10);
  return n >= 0 && n <= max && String(n) === bits;
}

/**
 * Parse one SPF TXT record. Returns null when the record does not start
 * with `v=spf1` (case-insensitive). Whitespace between terms is tolerated
 * beyond the single SP the grammar asks for.
 */
export function parseSpfRecord(record: string | null | undefined): ParsedSpfRecord | null {
  if (!record || !isSpfRecord(record)) return null;
  const trimmed = record.trim();
  const truncated = trimmed.length > SPF_MAX_RECORD_LENGTH;
  // Over the bound: parse the prefix up to the last whole term.
  const text = truncated
    ? trimmed.slice(0, SPF_MAX_RECORD_LENGTH).replace(/\s+\S*$/, '')
    : trimmed;
  const terms = text.split(/\s+/).slice(1);

  const mechanisms: SpfMechanism[] = [];
  const errorList: string[] = [];
  const syntaxErrors = {
    push(e: string): void { if (errorList.length < MAX_SYNTAX_ERRORS) errorList.push(e); },
  };
  let redirect: string | null = null;
  let exp: string | null = null;
  let sawRedirect = false;
  let sawExp = false;

  for (const term of terms) {
    if (term === '') continue;
    const mod = MODIFIER_RE.exec(term);
    if (mod) {
      const name = mod[1]!.toLowerCase();
      const value = mod[2]!;
      if (name === 'redirect') {
        if (sawRedirect) syntaxErrors.push('duplicate redirect modifier');
        else if (!validDomainSpec(value)) syntaxErrors.push('invalid redirect target');
        else redirect = value;
        sawRedirect = true;
      } else if (name === 'exp') {
        if (sawExp) syntaxErrors.push('duplicate exp modifier');
        else if (!validDomainSpec(value)) syntaxErrors.push('invalid exp target');
        else exp = value;
        sawExp = true;
      }
      // Unknown modifiers are ignored (RFC 7208 §6).
      continue;
    }

    const m = MECHANISM_RE.exec(term);
    if (!m) {
      syntaxErrors.push('unparseable term');
      continue;
    }
    const qualifier = (m[1] || '+') as SpfQualifier;
    const rawName = m[2]!.toLowerCase();
    const rest = m[3]!;

    switch (rawName) {
      case 'all': {
        if (rest !== '') { syntaxErrors.push('all takes no argument'); break; }
        mechanisms.push({ qualifier, name: 'all', value: null });
        break;
      }
      case 'include':
      case 'exists': {
        const arg = rest.startsWith(':') ? rest.slice(1) : null;
        if (arg === null || !validDomainSpec(arg)) { syntaxErrors.push(`${rawName} requires a domain`); break; }
        mechanisms.push({ qualifier, name: rawName, value: arg });
        break;
      }
      case 'a':
      case 'mx': {
        // [":" domain-spec] [ip4-cidr-length] ["/" ip6-cidr-length]
        const dual = /^(.*?)(?:\/(\d+))?(?:\/\/(\d+))?$/.exec(rest);
        let spec = dual?.[1] ?? rest;
        if (!dual || !cidrOk(dual[2], 32) || !cidrOk(dual[3], 128)) { syntaxErrors.push(`invalid ${rawName} cidr length`); break; }
        if (spec === '') { mechanisms.push({ qualifier, name: rawName, value: null }); break; }
        if (!spec.startsWith(':')) { syntaxErrors.push(`invalid ${rawName} argument`); break; }
        spec = spec.slice(1);
        if (!validDomainSpec(spec)) { syntaxErrors.push(`${rawName} requires a domain`); break; }
        mechanisms.push({ qualifier, name: rawName, value: spec });
        break;
      }
      case 'ptr': {
        if (rest === '') { mechanisms.push({ qualifier, name: 'ptr', value: null }); break; }
        const arg = rest.startsWith(':') ? rest.slice(1) : null;
        if (arg === null || !validDomainSpec(arg)) { syntaxErrors.push('invalid ptr argument'); break; }
        mechanisms.push({ qualifier, name: 'ptr', value: arg });
        break;
      }
      case 'ip4':
      case 'ip6': {
        const arg = rest.startsWith(':') ? rest.slice(1) : null;
        const slash = arg === null ? -1 : arg.indexOf('/');
        const addr = arg === null ? '' : slash >= 0 ? arg.slice(0, slash) : arg;
        const bits = arg !== null && slash >= 0 ? arg.slice(slash + 1) : undefined;
        const addrOk = rawName === 'ip4' ? IPV4_RE.test(addr) : IPV6_RE.test(addr) && addr.includes(':');
        if (!addrOk) { syntaxErrors.push(`invalid ${rawName} address`); break; }
        if (!cidrOk(bits, rawName === 'ip4' ? 32 : 128)) { syntaxErrors.push(`invalid ${rawName} cidr length`); break; }
        mechanisms.push({ qualifier, name: rawName, value: addr });
        break;
      }
      default:
        syntaxErrors.push('unknown mechanism');
    }
  }

  // Only terms up to the first `all` are ever evaluated (§5.1).
  const firstAll = mechanisms.findIndex((x) => x.name === 'all');
  const evaluated = firstAll >= 0 ? mechanisms.slice(0, firstAll + 1) : mechanisms;
  const allQualifier = firstAll >= 0 ? mechanisms[firstAll]!.qualifier : null;
  const redirectApplies = redirect !== null && firstAll < 0;

  let lookupTerms = 0;
  const includeTargets: string[] = [];
  let usesPtr = false;
  for (const mech of evaluated) {
    if (LOOKUP_MECHANISMS.has(mech.name)) lookupTerms++;
    if (mech.name === 'include' && mech.value) includeTargets.push(mech.value);
    if (mech.name === 'ptr') usesPtr = true;
  }
  if (redirectApplies) lookupTerms++;

  return {
    mechanisms,
    redirect,
    redirectApplies,
    exp,
    allQualifier,
    lookupTerms,
    includeTargets,
    usesPtr,
    syntaxErrors: errorList,
    truncated,
  };
}
