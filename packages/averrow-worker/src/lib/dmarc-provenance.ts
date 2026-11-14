/**
 * Provenance of an inbound DMARC aggregate-report email (B3, appsec M3,
 * review H1/H2).
 *
 * Aggregate reports are unauthenticated XML: anyone can email one claiming
 * any domain. What we CAN check is the delivering message: its From address
 * and the authentication results our receiving MTA recorded.
 *
 * `verified = true` only when ALL hold:
 *   1. the RFC 5322 From address is EXACTLY one of KNOWN_RUA_REPORTERS
 *      (a specific reporter mailbox, never a consumer mailbox domain —
 *      anyone can hold a free @yahoo.com / @outlook.com / @mail.ru box);
 *   2. the TOPMOST `Authentication-Results` header (never
 *      ARC-Authentication-Results — an ARC set is sender-written until its
 *      seal is validated, which we don't do) has an authserv-id in the
 *      trusted set; and
 *   3. that header shows dkim=pass with header.d EXACTLY equal to the
 *      reporter's signing domain, or dmarc=pass with header.from exactly
 *      equal to it.
 *
 * ── DISABLED BY DEFAULT ─────────────────────────────────────────────────
 * TRUSTED_AUTHSERV_IDS ships EMPTY, so every report is `verified = false`.
 * We have not seen a real message delivered to the Worker, so we don't know
 * whether Cloudflare Email Routing prepends an Authentication-Results
 * header at all. If it does not, the topmost header is one the SENDER wrote
 * and trusting it by authserv-id would let anyone mint `verified = 1`.
 * With verified always 0: no failure notification, no ipinfo spend, and
 * the source rollup still runs from threats / clusters / providers /
 * Spamhaus ASN-DROP evidence.
 *
 * To enable (one line, after a canary): send a real aggregate report (or
 * any mail) to the RUA address, capture the raw headers the Worker
 * receives, and confirm (a) the TOPMOST Authentication-Results header is
 * added by Cloudflare on every message, (b) its authserv-id string, and
 * (c) that a sender-supplied Authentication-Results header with the same
 * authserv-id always sits BELOW Cloudflare's (or is stripped). Then add
 * that authserv-id to TRUSTED_AUTHSERV_IDS.
 *
 * Follow-up (the robust fix, not built): verify the message's DKIM
 * signature ourselves with WebCrypto against the reporter's published key,
 * which removes the dependence on any MTA header.
 */

/**
 * Exact aggregate-report sender addresses → the domain their mail is
 * DKIM-signed / DMARC-aligned as. Only entries we are confident of; extend
 * from real inbound mail (HEURISTIC, tunable).
 */
export const KNOWN_RUA_REPORTERS: ReadonlyMap<string, string> = new Map([
  ["noreply-dmarc-support@google.com", "google.com"],
  ["dmarcreport@microsoft.com", "microsoft.com"],
]);

/**
 * authserv-ids whose topmost Authentication-Results header we trust.
 * EMPTY until an operator confirms the live header — see the file header.
 * Enabling is adding one string here.
 */
export const TRUSTED_AUTHSERV_IDS: ReadonlySet<string> = new Set<string>([]);

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

/** The (last) address in a From value, lowercased; null when absent. */
export function fromAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const angle = value.match(/<([^<>]*)>\s*$/);
  const addr = (angle ? angle[1]! : value).trim().toLowerCase();
  return /^[^\s@<>]+@[a-z0-9.-]+$/.test(addr) ? addr : null;
}

export interface DmarcProvenanceOptions {
  /** Override the trusted authserv-id set (tests; the canary). */
  trustedAuthservIds?: ReadonlySet<string>;
}

/** Provenance from the raw message text (header block) + envelope sender. */
export function readDmarcProvenance(rawMessage: string, envelopeFrom: string, opts: DmarcProvenanceOptions = {}): DmarcProvenance {
  const trusted = opts.trustedAuthservIds ?? TRUSTED_AUTHSERV_IDS;
  const headers = parseRawHeaders(rawMessage);
  const fromValue = headers.find((h) => h.name === "from")?.value ?? null;
  const from = fromAddress(fromValue);
  const senderDomain = addressDomain(fromValue) ?? addressDomain(envelopeFrom);

  // Only plain Authentication-Results, and only the topmost one.
  const top = headers.find((h) => h.name === "authentication-results");
  if (!top) return { senderDomain, senderAuth: null, verified: false };
  const { authservId, results } = parseAuthResults(top.name, top.value);
  if (!trusted.has(authservId)) return { senderDomain, senderAuth: null, verified: false };

  const relevant = results.filter((r) => r.method === "dkim" || r.method === "dmarc" || r.method === "spf");
  const senderAuth = [authservId, ...relevant.map((r) => `${r.method}=${r.result}${r.domain ? `(${r.domain})` : ""}`)]
    .join("; ").slice(0, 300);
  const signer = from ? KNOWN_RUA_REPORTERS.get(from) ?? null : null;
  const verified = signer !== null && relevant.some((r) =>
    (r.method === "dkim" || r.method === "dmarc") && r.result === "pass" && r.domain === signer);
  return { senderDomain, senderAuth, verified };
}
