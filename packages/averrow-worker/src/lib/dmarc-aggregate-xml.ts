/**
 * DMARC aggregate-report XML parser — RFC 7489 Appendix C and RFC 9990
 * (DMARCbis aggregate reporting). No DOM, no npm dependency.
 *
 * Input is HOSTILE: anyone can email XML to the RUA address. So:
 *   - Element scanning is indexOf/sticky-regex based and linear in the
 *     input: an open tag's attribute run is bounded (≤512 chars), and a
 *     missing close tag ends the scan instead of re-scanning to EOF from
 *     every later open tag (the quadratic shape a lazy `<x>[\s\S]*?</x>`
 *     global regex has on unclosed input).
 *   - Namespace prefixes are accepted on any element (`<dmarc:record>`,
 *     `<feedback xmlns="urn:ietf:params:xml:ns:dmarc-2.0">`); matching is
 *     by local name only.
 *   - Comments are stripped, CDATA unwrapped, the five XML entities and
 *     numeric references decoded, control characters removed, and every
 *     field length-capped.
 *   - Source IPs must be a valid IPv4 dotted quad or IPv6 address (IPv6 is
 *     canonicalised); a record with an invalid IP or a non-positive count is
 *     dropped. Counts are clamped.
 *   - At most DMARC_XML_LIMITS.maxRecords records are parsed; `truncated`
 *     says when more were present.
 *
 * Format notes (RFC 9990 vs RFC 7489, see lib/dmarc-source-classify.ts):
 * `version` optional; policy_published drops `pct`, adds `np`, `testing`,
 * `discovery_method`; disposition may be `pass`; override reasons are the
 * union of both RFCs' sets; envelope_from / envelope_to optional (some
 * generators write `envelope-from`).
 */

export const DMARC_XML_LIMITS = {
  /** Records parsed per report; more → `truncated: true`. */
  maxRecords: 10_000,
  /** DKIM auth_results entries kept per record. */
  maxDkimPerRecord: 10,
  /** SPF auth_results entries kept per record. */
  maxSpfPerRecord: 3,
  /** Override reasons kept per record. */
  maxReasonsPerRecord: 5,
  /** Upper bound for one record's message count (B3c). The largest real
   *  aggregate rows are well under a million messages a day. */
  maxCount: 10_000_000,
  /** Upper bound for one report's total messages; larger totals are scaled
   *  down proportionally (the pass/fail RATE is kept). */
  maxReportMessages: 50_000_000,
} as const;

/** Override reason types: RFC 7489 ∪ RFC 9990. Anything else → 'other'. */
const KNOWN_REASONS: ReadonlySet<string> = new Set([
  "forwarded", "sampled_out", "trusted_forwarder", "mailing_list",
  "local_policy", "policy_test_mode", "other",
]);

export interface DmarcAuthDkim { domain: string; selector: string; result: string }
export interface DmarcAuthSpf { domain: string; scope: string; result: string }

export interface DmarcAggregateRecord {
  source_ip: string;
  message_count: number;
  /** none | quarantine | reject | pass (RFC 9990) — '' when absent/unknown. */
  disposition: string;
  /** policy_evaluated dkim / spf (aligned results), lowercased, ≤20 chars. */
  dkim_result: string;
  spf_result: string;
  /** policy_evaluated reason types. */
  reasons: string[];
  header_from: string;
  envelope_from: string;
  envelope_to: string;
  dkim_auth: DmarcAuthDkim[];
  spf_auth: DmarcAuthSpf[];
}

export interface DmarcAggregateReport {
  reporter_org: string;
  reporter_email: string;
  report_id: string;
  date_begin: number;
  date_end: number;
  /** policy_published domain, lowercased; never empty in a parsed report. */
  domain: string;
  /** policy_published p (none|quarantine|reject) or ''. */
  dmarc_policy: string;
  records: DmarcAggregateRecord[];
  /** True when more than maxRecords records were present. */
  truncated: boolean;
}

// ─── Text helpers ─────────────────────────────────────────────────────

/** Remove `<!-- … -->` comments in one linear pass. An unclosed comment
 *  swallows the rest of the document (as an XML parser would). */
export function stripXmlComments(xml: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const start = xml.indexOf("<!--", pos);
    if (start < 0) return out + xml.slice(pos);
    out += xml.slice(pos, start);
    const end = xml.indexOf("-->", start + 4);
    if (end < 0) return out;
    pos = end + 3;
  }
}

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

/** Decode element text: CDATA unwrap, entities, control chars, cap. */
export function xmlText(raw: string | undefined, maxLen = 200): string {
  if (!raw) return "";
  let s = raw.trim();
  if (s.startsWith("<![CDATA[") && s.endsWith("]]>")) s = s.slice(9, -3);
  s = s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITY[e] ?? m;
  });
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, maxLen);
}

/** A DNS name for storage: lowercased, no trailing dot, [a-z0-9._-] only,
 *  ≤253 chars — '' otherwise. */
export function xmlDomain(raw: string | undefined): string {
  const s = xmlText(raw, 300).toLowerCase().replace(/\.+$/, "");
  return /^[a-z0-9_](?:[a-z0-9._-]{0,251}[a-z0-9_])?$/.test(s) ? s : "";
}

/** Short lowercase token (results, dispositions, scopes): [a-z_]{1,20} or ''. */
function xmlToken(raw: string | undefined): string {
  const s = xmlText(raw, 40).toLowerCase();
  return /^[a-z_]{1,20}$/.test(s) ? s : "";
}

const IPV4_RE = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;

/**
 * Validate and canonicalise a source IP. IPv4: strict dotted quad (no
 * leading zeros, no shorthand). IPv6: the WHATWG URL host parser
 * (lowercase, zero-compressed). Returns null when invalid.
 */
export function normalizeSourceIp(raw: string): string | null {
  const s = raw.trim();
  if (IPV4_RE.test(s)) return s;
  if (s.length < 2 || s.length > 45 || !s.includes(":") || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  try {
    const host = new URL(`http://[${s}]/`).hostname;
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : null;
  } catch {
    return null;
  }
}

// ─── Element scanning ────────────────────────────────────────────────

const NAME_RE = /^[a-z_][a-z0-9_-]*$/;
const reCache = new Map<string, { open: RegExp; close: RegExp }>();

function tagRegexes(tag: string): { open: RegExp; close: RegExp } {
  let r = reCache.get(tag);
  if (!r) {
    // Tags are code literals; refuse anything else so no caller text ever
    // reaches a RegExp source.
    if (!NAME_RE.test(tag)) throw new Error(`dmarc-aggregate-xml: bad tag ${tag}`);
    r = {
      // Optional prefix, the local name, then either `>` / `/>` directly or
      // whitespace + a BOUNDED attribute run. Bounded so a `<record ` with
      // no `>` costs ≤512 chars, not a scan to EOF.
      open: new RegExp(`<(?:[A-Za-z_][\\w.-]{0,63}:)?${tag}(?:\\s[^<>]{0,512})?/?>`, "g"),
      close: new RegExp(`</(?:[A-Za-z_][\\w.-]{0,63}:)?${tag}\\s*>`, "g"),
    };
    reCache.set(tag, r);
  }
  return r;
}

/**
 * Inner contents of up to `limit` `<tag>` elements in `xml` (local-name
 * match, any prefix). Self-closing elements yield ''. Linear: a missing
 * close tag ends the scan. `overflow` reports whether more existed.
 */
export function xmlElements(xml: string, tag: string, limit = Number.POSITIVE_INFINITY): { items: string[]; overflow: boolean } {
  const { open, close } = tagRegexes(tag);
  const items: string[] = [];
  let pos = 0;
  for (;;) {
    open.lastIndex = pos;
    const o = open.exec(xml);
    if (!o) return { items, overflow: false };
    if (items.length >= limit) return { items, overflow: true };
    const afterOpen = o.index + o[0].length;
    if (o[0].endsWith("/>")) {
      items.push("");
      pos = afterOpen;
      continue;
    }
    close.lastIndex = afterOpen;
    const c = close.exec(xml);
    if (!c) return { items, overflow: false };
    items.push(xml.slice(afterOpen, c.index));
    pos = c.index + c[0].length;
  }
}

/** Inner contents of the first `<tag>` element, or ''. */
export function xmlFirst(xml: string, tag: string): string {
  return xmlElements(xml, tag, 1).items[0] ?? "";
}

// ─── Report parsing ──────────────────────────────────────────────────

function parseCount(raw: string): number {
  const s = xmlText(raw, 20);
  if (!/^[0-9]{1,12}$/.test(s)) return 0;
  return Math.min(parseInt(s, 10), DMARC_XML_LIMITS.maxCount);
}

function parseEpoch(raw: string): number {
  const s = xmlText(raw, 20);
  return /^[0-9]{1,12}$/.test(s) ? parseInt(s, 10) : 0;
}

function parseRecord(rec: string): DmarcAggregateRecord | null {
  const row = xmlFirst(rec, "row");
  const ip = normalizeSourceIp(xmlText(xmlFirst(row, "source_ip"), 64));
  if (!ip) return null;
  const count = parseCount(xmlFirst(row, "count"));
  if (count <= 0) return null;

  const pe = xmlFirst(row, "policy_evaluated");
  const reasons: string[] = [];
  for (const r of xmlElements(pe, "reason", DMARC_XML_LIMITS.maxReasonsPerRecord).items) {
    const t = xmlToken(xmlFirst(r, "type"));
    if (t) reasons.push(KNOWN_REASONS.has(t) ? t : "other");
  }

  const ids = xmlFirst(rec, "identifiers");
  const auth = xmlFirst(rec, "auth_results");
  const dkim_auth: DmarcAuthDkim[] = xmlElements(auth, "dkim", DMARC_XML_LIMITS.maxDkimPerRecord).items.map((d) => ({
    domain: xmlDomain(xmlFirst(d, "domain")),
    selector: xmlText(xmlFirst(d, "selector"), 100),
    result: xmlToken(xmlFirst(d, "result")),
  })).filter((d) => d.domain !== "");
  const spf_auth: DmarcAuthSpf[] = xmlElements(auth, "spf", DMARC_XML_LIMITS.maxSpfPerRecord).items.map((s) => ({
    domain: xmlDomain(xmlFirst(s, "domain")),
    scope: xmlToken(xmlFirst(s, "scope")),
    result: xmlToken(xmlFirst(s, "result")),
  })).filter((s) => s.domain !== "");

  return {
    source_ip: ip,
    message_count: count,
    disposition: xmlToken(xmlFirst(pe, "disposition")),
    dkim_result: xmlToken(xmlFirst(pe, "dkim")),
    spf_result: xmlToken(xmlFirst(pe, "spf")),
    reasons,
    header_from: xmlDomain(xmlFirst(ids, "header_from")),
    envelope_from: xmlDomain(xmlFirst(ids, "envelope_from") || xmlFirst(ids, "envelope-from")),
    envelope_to: xmlDomain(xmlFirst(ids, "envelope_to") || xmlFirst(ids, "envelope-to")),
    dkim_auth,
    spf_auth,
  };
}

/**
 * Parse one aggregate report. Null when the document has no
 * report_metadata or no valid policy_published domain.
 */
export function parseDmarcAggregateXml(input: string): DmarcAggregateReport | null {
  const xml = stripXmlComments(input);
  const metadata = xmlFirst(xml, "report_metadata");
  if (!metadata) return null;
  const policy = xmlFirst(xml, "policy_published");
  const domain = xmlDomain(xmlFirst(policy, "domain"));
  if (!domain) return null;

  const dateRange = xmlFirst(metadata, "date_range");
  const p = xmlToken(xmlFirst(policy, "p"));

  const { items: recordXmls, overflow } = xmlElements(xml, "record", DMARC_XML_LIMITS.maxRecords);
  const records: DmarcAggregateRecord[] = [];
  for (const rec of recordXmls) {
    const r = parseRecord(rec);
    if (r) records.push(r);
  }

  return {
    reporter_org: xmlText(xmlFirst(metadata, "org_name"), 200),
    reporter_email: xmlText(xmlFirst(metadata, "email"), 200),
    report_id: xmlText(xmlFirst(metadata, "report_id"), 200),
    date_begin: parseEpoch(xmlFirst(dateRange, "begin")),
    date_end: parseEpoch(xmlFirst(dateRange, "end")),
    domain,
    dmarc_policy: p === "none" || p === "quarantine" || p === "reject" ? p : "",
    records,
    truncated: overflow,
  };
}

// ─── Report time (shared by the receiver and the rollup) ──────────────

const DAY_MS = 86_400_000;
/** Report dates further back / ahead than this are not believed. */
export const DMARC_REPORT_DATE_WINDOW = { pastDays: 60, futureDays: 2 } as const;

function clampReportMs(ms: number, nowMs: number): number {
  if (!Number.isFinite(ms) || ms < nowMs - DMARC_REPORT_DATE_WINDOW.pastDays * DAY_MS || ms > nowMs + DMARC_REPORT_DATE_WINDOW.futureDays * DAY_MS) {
    return nowMs;
  }
  return ms;
}

/**
 * UTC report day. The range end is exclusive in practice (Google sends
 * 00:00:00–23:59:59, others end at the next midnight), so take end − 1 s.
 * A date outside the window (hostile or broken) is replaced by `nowMs`'s
 * day so it can't scatter rows across arbitrary days.
 */
export function dmarcReportDay(begin: number, end: number, nowMs: number): string {
  const t = end > 0 ? Math.max(end - 1, begin) : begin;
  return new Date(clampReportMs(t > 0 ? t * 1000 : nowMs, nowMs)).toISOString().slice(0, 10);
}

/** ISO timestamp of a report epoch, clamped to the same window as
 *  dmarcReportDay (a 12-digit epoch would otherwise yield year +33658 and
 *  win MIN()/MAX() forever). */
export function dmarcReportEpochIso(sec: number, nowMs: number): string {
  return new Date(clampReportMs(sec > 0 ? sec * 1000 : nowMs, nowMs)).toISOString();
}

// ─── Per-record evidence for storage (dmarc_report_records.auth_json) ──

interface StoredAuth {
  r?: string[];
  d?: Array<[string, string]>;
  s?: Array<[string, string, string]>;
}

/** Compact JSON of the evidence the classifier reads, ≤ ~1.5 KB. */
export function encodeRecordAuth(r: Pick<DmarcAggregateRecord, "reasons" | "dkim_auth" | "spf_auth">): string {
  const v: StoredAuth = {};
  if (r.reasons.length > 0) v.r = r.reasons;
  if (r.dkim_auth.length > 0) v.d = r.dkim_auth.map((d) => [d.domain, d.result]);
  if (r.spf_auth.length > 0) v.s = r.spf_auth.map((x) => [x.domain, x.scope, x.result]);
  return JSON.stringify(v);
}

const isStr = (x: unknown): x is string => typeof x === "string";

/** Inverse of encodeRecordAuth; tolerant of NULL / corrupt values. */
export function decodeRecordAuth(raw: string | null): Pick<DmarcAggregateRecord, "reasons" | "dkim_auth" | "spf_auth"> {
  const out: Pick<DmarcAggregateRecord, "reasons" | "dkim_auth" | "spf_auth"> = { reasons: [], dkim_auth: [], spf_auth: [] };
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as StoredAuth;
    if (Array.isArray(v.r)) out.reasons = v.r.filter(isStr).slice(0, DMARC_XML_LIMITS.maxReasonsPerRecord);
    if (Array.isArray(v.d)) {
      out.dkim_auth = v.d.filter((x) => Array.isArray(x) && isStr(x[0]) && isStr(x[1]))
        .slice(0, DMARC_XML_LIMITS.maxDkimPerRecord)
        .map((x) => ({ domain: x[0], selector: "", result: x[1] }));
    }
    if (Array.isArray(v.s)) {
      out.spf_auth = v.s.filter((x) => Array.isArray(x) && isStr(x[0]) && isStr(x[1]) && isStr(x[2]))
        .slice(0, DMARC_XML_LIMITS.maxSpfPerRecord)
        .map((x) => ({ domain: x[0], scope: x[1], result: x[2] }));
    }
  } catch {
    // corrupt → no evidence
  }
  return out;
}
