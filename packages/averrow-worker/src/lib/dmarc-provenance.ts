/**
 * Provenance of an inbound DMARC aggregate-report email (B3, appsec M3).
 *
 * Aggregate reports are unauthenticated XML: anyone can email one claiming
 * any domain. What we CAN check is the delivering message itself: its From
 * domain and the authentication results our receiving MTA recorded.
 *
 * `verified = true` only when BOTH hold:
 *   1. the RFC 5322 From organizational domain is a known aggregate-report
 *      sender (KNOWN_RUA_REPORTER_ORG_DOMAINS — a tunable heuristic), and
 *   2. the TOPMOST Authentication-Results / ARC-Authentication-Results
 *      header — the one added last, by our side — has an authserv-id in
 *      TRUSTED_AUTHSERV_IDS and shows dkim=pass (d= in that org) or
 *      dmarc=pass (header.from in that org).
 *
 * Only the topmost header is read: anything below it was supplied by the
 * sender's side and can be forged. UNVERIFIED (2026-11-14): we have not yet
 * seen a real message delivered to the Worker, so whether Cloudflare Email
 * Routing prepends such a header, and with which authserv-id, is not
 * confirmed. With no trusted header every report is `verified = false`,
 * which is the safe default: unverified reports are stored as metadata,
 * spend no ipinfo, and never notify. Confirm against real mail, then tune
 * TRUSTED_AUTHSERV_IDS.
 */

import { registrableDomain } from "./registrable-domain";

/**
 * Organizational domains we are confident send DMARC aggregate reports.
 * HEURISTIC — extend from real inbound mail. Google (noreply-dmarc-support@
 * google.com), Microsoft (dmarcreport@microsoft.com; Exchange Online
 * reporters under protection.outlook.com → outlook.com), Yahoo (yahoo.com /
 * yahooinc.com), Mail.ru (corp.mail.ru → mail.ru).
 */
export const KNOWN_RUA_REPORTER_ORG_DOMAINS: ReadonlySet<string> = new Set([
  "google.com",
  "microsoft.com",
  "outlook.com",
  "yahoo.com",
  "yahooinc.com",
  "mail.ru",
]);

/**
 * authserv-ids of the MTA that hands mail to this Worker. UNVERIFIED — see
 * the file header. A header from any other authserv-id is ignored.
 */
export const TRUSTED_AUTHSERV_IDS: ReadonlySet<string> = new Set([
  "mx.cloudflare.net",
]);

export interface DmarcProvenance {
  /** From-header domain (lowercase), or the envelope sender's when absent. */
  senderDomain: string | null;
  /** Compact summary of the trusted header's dkim/dmarc results, or null. */
  senderAuth: string | null;
  verified: boolean;
}

interface RawHeader {
  name: string;
  value: string;
}

/** Header block of a raw RFC 822 message, unfolded, in order (top first).
 *  Reads at most 64 KB. */
export function parseRawHeaders(raw: string): RawHeader[] {
  const head = raw.slice(0, 65_536);
  let end = head.indexOf("\r\n\r\n");
  if (end < 0) end = head.indexOf("\n\n");
  const block = end >= 0 ? head.slice(0, end) : head;
  const out: RawHeader[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1]!.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    out.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
  }
  return out;
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

function cleanDomain(d: string | undefined | null): string | null {
  const s = (d ?? "").trim().toLowerCase().replace(/^@/, "").replace(/\.+$/, "");
  return DOMAIN_RE.test(s) ? s : null;
}

/** Domain of the (last) address in a From value / envelope sender. */
export function addressDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const angle = value.match(/<([^<>]*)>\s*$/);
  const addr = (angle ? angle[1]! : value).trim();
  const at = addr.lastIndexOf("@");
  return at >= 0 ? cleanDomain(addr.slice(at + 1)) : null;
}

function orgOf(d: string | null): string | null {
  return d ? registrableDomain(d) ?? d : null;
}

interface AuthResult {
  method: string;
  result: string;
  domain: string | null;
}

/** authserv-id + method results of one (ARC-)Authentication-Results value. */
export function parseAuthResults(name: string, value: string): { authservId: string; results: AuthResult[] } {
  const clauses = value.split(";").map((c) => c.trim()).filter((c) => c !== "");
  if (name === "arc-authentication-results" && /^i\s*=\s*\d+$/i.test(clauses[0] ?? "")) clauses.shift();
  const authservId = (clauses.shift() ?? "").split(/\s+/)[0]!.toLowerCase();
  const results: AuthResult[] = [];
  for (const c of clauses.slice(0, 20)) {
    const m = c.match(/^([a-z][a-z0-9-]*)\s*=\s*([a-z]+)/i);
    if (!m) continue;
    const method = m[1]!.toLowerCase();
    let domain: string | null = null;
    if (method === "dkim") {
      domain = cleanDomain(c.match(/header\.d\s*=\s*([^\s;()]+)/i)?.[1])
        ?? cleanDomain(c.match(/header\.i\s*=\s*[^\s;()@]*@([^\s;()]+)/i)?.[1]);
    } else if (method === "dmarc") {
      domain = cleanDomain(c.match(/header\.from\s*=\s*([^\s;()]+)/i)?.[1]);
    } else if (method === "spf") {
      domain = cleanDomain(c.match(/smtp\.mailfrom\s*=\s*(?:[^\s;()@]*@)?([^\s;()]+)/i)?.[1]);
    }
    results.push({ method, result: m[2]!.toLowerCase(), domain });
  }
  return { authservId, results };
}

/** Provenance from the raw message text (header block) + envelope sender. */
export function readDmarcProvenance(rawMessage: string, envelopeFrom: string): DmarcProvenance {
  const headers = parseRawHeaders(rawMessage);
  const fromHeader = headers.find((h) => h.name === "from")?.value ?? null;
  const senderDomain = addressDomain(fromHeader) ?? addressDomain(envelopeFrom);
  const senderOrg = orgOf(senderDomain);

  const top = headers.find((h) => h.name === "authentication-results" || h.name === "arc-authentication-results");
  if (!top) return { senderDomain, senderAuth: null, verified: false };
  const { authservId, results } = parseAuthResults(top.name, top.value);
  if (!TRUSTED_AUTHSERV_IDS.has(authservId)) return { senderDomain, senderAuth: null, verified: false };

  const relevant = results.filter((r) => r.method === "dkim" || r.method === "dmarc" || r.method === "spf");
  const senderAuth = [authservId, ...relevant.map((r) => `${r.method}=${r.result}${r.domain ? `(${r.domain})` : ""}`)]
    .join("; ").slice(0, 300);
  const passForOrg = relevant.some((r) =>
    (r.method === "dkim" || r.method === "dmarc") && r.result === "pass" && senderOrg !== null && orgOf(r.domain) === senderOrg);
  const verified = senderOrg !== null && KNOWN_RUA_REPORTER_ORG_DOMAINS.has(senderOrg) && passForOrg;
  return { senderDomain, senderAuth, verified };
}
