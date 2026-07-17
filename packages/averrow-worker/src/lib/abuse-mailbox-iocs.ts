// Averrow — Abuse Mailbox IOC extraction, correlation, and promotion
//
// PR-AX layer on top of the PR-AS raw-capture columns. Bridges the
// abuse-mailbox surface to the platform's threat intelligence:
//
//   1. Parse Authentication-Results + Received chain for the signals
//      that materially affect a phishing verdict (SPF/DKIM/DMARC,
//      external sender IP).
//   2. Correlate extracted URLs against the `threats` table so the
//      classifier + UI can show "this URL was already flagged 12 days
//      ago across 3 brands".
//   3. Promote confirmed phishing/malware verdicts into `threats`
//      so the intel learned from one tenant's report benefits every
//      other tenant + the platform's own correlation pipeline.
//
// D1 cost profile (realistic abuse-mailbox volume of 5-20 caps/day):
//   - correlateUrls: 1 indexed seek per URL (`idx_threats_domain`).
//     Few hundred reads/day. Throttle-gated upstream so a flood can't
//     compound.
//   - promoteToThreats: 1 INSERT OR IGNORE per URL on confirmed
//     phishing/malware HIGH+ rows only. Deterministic threat id
//     keeps repeated reports idempotent.
//   - parsers (parseAuthResults, parseSenderIp): pure, zero D1.

import type { Env } from "../types";
import type { ExtractedUrl } from "../handlers/abuseMailboxEmail";
import { extractDomain, threatId, type ThreatRow } from "../feeds/types";
import { insertThreat } from "./feedRunner";

// ─── Authentication-Results parsing ─────────────────────────────

export type AuthVerdict = "pass" | "fail" | "softfail" | "neutral" | "none" | "policy" | "permerror" | "temperror";

export interface AuthResults {
  spf:   AuthVerdict | null;
  dkim:  AuthVerdict | null;
  dmarc: AuthVerdict | null;
}

const VALID_AUTH_VERDICTS = new Set<AuthVerdict>([
  "pass", "fail", "softfail", "neutral", "none", "policy", "permerror", "temperror",
]);

/**
 * Extract SPF / DKIM / DMARC verdicts from the `Authentication-Results`
 * header value. RFC 8601 format — each verifier emits its method=verdict
 * pair joined by semicolons:
 *
 *   Authentication-Results: mx.example.com;
 *     spf=pass smtp.mailfrom=bad.example;
 *     dkim=fail header.d=other.example;
 *     dmarc=fail action=quarantine
 *
 * When the header is missing OR the method isn't recorded, the matching
 * field returns null (vs. 'none' which means "method ran, no policy").
 */
export function parseAuthResults(headers: Record<string, string>): AuthResults {
  const raw = headers["authentication-results"] ?? null;
  if (!raw) {
    return { spf: null, dkim: null, dmarc: null };
  }
  // Headers can be folded — collapse whitespace runs to a single space
  // so the regex below matches across newlines.
  const flat = raw.replace(/\s+/g, " ").toLowerCase();
  return {
    spf:   matchVerdict(flat, "spf"),
    dkim:  matchVerdict(flat, "dkim"),
    dmarc: matchVerdict(flat, "dmarc"),
  };
}

// PR-BR: static lookup of compiled patterns. Pre-fix, matchVerdict
// built a fresh RegExp from a `method` parameter via string concat —
// only called with hardcoded literals today, but a future caller
// passing untrusted input would create a regex-injection surface.
// Compiled-once table eliminates that footgun and is marginally
// faster.
const VERDICT_PATTERNS: Record<string, RegExp> = {
  spf: /spf=([a-z]+)/i,
  dkim: /dkim=([a-z]+)/i,
  dmarc: /dmarc=([a-z]+)/i,
};

function matchVerdict(flat: string, method: "spf" | "dkim" | "dmarc"): AuthVerdict | null {
  const re = VERDICT_PATTERNS[method];
  if (!re) return null;
  const m = re.exec(flat);
  if (!m?.[1]) return null;
  const v = m[1].toLowerCase() as AuthVerdict;
  return VALID_AUTH_VERDICTS.has(v) ? v : null;
}

// ─── Sender-IP extraction from Received chain ───────────────────

const PRIVATE_IP_PREFIXES = [
  "10.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.",
  "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.",
  "172.29.", "172.30.", "172.31.", "192.168.", "127.", "169.254.", "0.0.0.0",
];

function isPrivateOrLoopback(ip: string): boolean {
  // IPv6 loopback / link-local
  if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  return PRIVATE_IP_PREFIXES.some((p) => ip.startsWith(p));
}

// PR-BP: strict IP patterns. The previous loose `[0-9a-f:]+::?[0-9a-f:]+`
// regex matched non-IPv6 strings like `aa:bb` and `abcd:1234`, none of
// which passed the loopback/link-local check in isPrivateOrLoopback(),
// allowing attacker-controlled junk in a Received header to be stamped
// into threats.ip_address. These patterns require:
//   - IPv4: 4 octets, each 0-255 (validated below by isValidOctet)
//   - IPv6: at least one `::` OR enough colon-separated groups to be a
//           plausible v6 address, validated by isValidIPv6 below.
const IP_PATTERN = /\[?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}|::[0-9a-f:]+|[0-9a-f:]+::[0-9a-f:]*|::1)\]?/i;

function isValidIPv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const n = parseInt(m[i] ?? "", 10);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isValidIPv6(ip: string): boolean {
  // Must contain at least one colon and only valid hex/colon characters.
  // Allows zero-compression (::) appearing at most once.
  if (!/^[0-9a-f:]+$/i.test(ip)) return false;
  const doubleColonCount = (ip.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return false;
  // Split on `::` if present; each half must be 0-7 groups of 1-4 hex.
  // If no `::`, must be exactly 8 groups.
  const groups = ip.split("::");
  if (groups.length === 1) {
    const parts = ip.split(":");
    if (parts.length !== 8) return false;
    return parts.every((p) => /^[0-9a-f]{1,4}$/i.test(p));
  }
  // groups.length === 2 (split by `::`)
  const left = groups[0] ? groups[0].split(":") : [];
  const right = groups[1] ? groups[1].split(":") : [];
  if (left.length + right.length > 7) return false;
  return [...left, ...right].every((p) => p === "" || /^[0-9a-f]{1,4}$/i.test(p));
}

function isValidIp(ip: string): boolean {
  return isValidIPv4(ip) || isValidIPv6(ip);
}

/**
 * Walk the Received chain from oldest (bottom of the chain) to newest
 * (top — closest to our infrastructure) and return the first non-private,
 * non-loopback IP. That's the most-external sender — i.e. the entry
 * point into the public mail relay chain.
 *
 * The `received` header is appended once per hop (newest first), so
 * Cloudflare's Email Routing concatenates them with `; ` delimiters
 * when we read the value. We split + reverse to walk oldest-first.
 */
export function parseSenderIp(headers: Record<string, string>): string | null {
  const received = headers["received"] ?? null;
  if (!received) return null;
  // Split on the synthetic `; ` joiner Cloudflare's header parser uses
  // (preserving order — earliest hop appears LAST in the joined string).
  // We walk from oldest to newest so the first external IP we hit is
  // the most-external entry point.
  const hops = received.split(/;\s+/).reverse();
  for (const hop of hops) {
    const m = IP_PATTERN.exec(hop);
    const ip = m?.[1];
    if (!ip) continue;
    // PR-BP: validate strictly before any stamping. The IP_PATTERN
    // regex catches plausible candidates but doesn't enforce octet
    // ranges or full IPv6 structure — `isValidIp` rejects garbage
    // before it can poison threats.ip_address downstream.
    if (!isValidIp(ip)) continue;
    if (isPrivateOrLoopback(ip)) continue;
    return ip;
  }
  return null;
}

// ─── Existing-threat correlation ────────────────────────────────

export interface CorrelatedThreat {
  threat_id:       string;
  url:             string | null;
  domain:          string | null;
  first_seen:      string;
  target_brand_id: string | null;
  source_feed:     string;
  threat_type:     string;
  status:          string;
}

/**
 * Look up extracted URLs in the `threats` table by both exact-URL match
 * and domain match. Returns a deduped list of correlations. Each URL
 * costs one indexed read; capped at the first 20 URLs to keep a wildly
 * URL-heavy submission from spiking D1 cost.
 */
export async function correlateUrls(
  env: Env,
  urls: ExtractedUrl[],
): Promise<CorrelatedThreat[]> {
  if (urls.length === 0) return [];
  const out = new Map<string, CorrelatedThreat>();
  const capped = urls.slice(0, 20);
  for (const u of capped) {
    // Exact URL match first (rare but high-confidence).
    if (u.url) {
      const row = await env.DB.prepare(
        `SELECT id, malicious_url, malicious_domain, first_seen,
                target_brand_id, source_feed, threat_type, status
         FROM threats
         WHERE malicious_url = ?
         LIMIT 1`,
      ).bind(u.url).first<{
        id: string; malicious_url: string | null; malicious_domain: string | null;
        first_seen: string; target_brand_id: string | null;
        source_feed: string; threat_type: string; status: string;
      }>();
      if (row?.id && !out.has(row.id)) {
        out.set(row.id, {
          threat_id: row.id,
          url: row.malicious_url,
          domain: row.malicious_domain,
          first_seen: row.first_seen,
          target_brand_id: row.target_brand_id,
          source_feed: row.source_feed,
          threat_type: row.threat_type,
          status: row.status,
        });
        continue;
      }
    }
    // Fall back to domain match (broader, catches different URLs on
    // the same hostile host).
    if (u.domain) {
      const row = await env.DB.prepare(
        `SELECT id, malicious_url, malicious_domain, first_seen,
                target_brand_id, source_feed, threat_type, status
         FROM threats
         WHERE malicious_domain = ?
         ORDER BY first_seen DESC
         LIMIT 1`,
      ).bind(u.domain).first<{
        id: string; malicious_url: string | null; malicious_domain: string | null;
        first_seen: string; target_brand_id: string | null;
        source_feed: string; threat_type: string; status: string;
      }>();
      if (row?.id && !out.has(row.id)) {
        out.set(row.id, {
          threat_id: row.id,
          url: row.malicious_url,
          domain: row.malicious_domain,
          first_seen: row.first_seen,
          target_brand_id: row.target_brand_id,
          source_feed: row.source_feed,
          threat_type: row.threat_type,
          status: row.status,
        });
      }
    }
  }
  return Array.from(out.values());
}

// ─── Promotion: confirmed verdicts → platform threats ──────────

export interface PromoteOptions {
  urls:           ExtractedUrl[];
  classification: "phishing" | "malware";
  confidence:     number;             // 0-100, from classifier
  brandId:        string | null;
  senderIp:       string | null;
  messageId:      string;
  // PR — Kali365 detection. When a device-code phishing technique is
  // detected and/or a named threat is matched, label the promoted
  // threats. `excludeUrls` lists legitimate endpoints (e.g. the real
  // microsoft.com/devicelogin a device-code lure steers victims to) that
  // must NEVER be promoted as malicious.
  technique?:     string | null;
  namedThreatId?: string | null;
  excludeUrls?:   ReadonlyArray<string>;
}

/**
 * Push the URLs from a confirmed phishing/malware capture into the
 * `threats` table so the platform can correlate them against future
 * submissions / feeds / analyst views. Deterministic threat id via
 * `threatId(source, type, value)` so repeated reports of the same URL
 * are idempotent — no duplicates, no UPDATE/REPLACE traffic.
 *
 * Returns the list of threat ids that were promoted (regardless of
 * whether they were brand-new or already existed under the same id).
 */
export async function promoteToThreats(
  env: Env,
  opts: PromoteOptions,
): Promise<string[]> {
  if (opts.urls.length === 0) return [];
  const threatType: ThreatRow["threat_type"] =
    opts.classification === "malware" ? "malware_distribution" : "phishing";
  const severity: NonNullable<ThreatRow["severity"]> =
    opts.confidence >= 80 ? "high" : "medium";
  const ids: string[] = [];
  // Never promote a legitimate endpoint (e.g. the real
  // microsoft.com/devicelogin a device-code lure points at). Flagging
  // microsoft.com itself as malicious would be a serious false positive.
  const exclude = new Set((opts.excludeUrls ?? []).map((u) => u.toLowerCase()));
  // Cap the same way correlateUrls does. A wildly URL-heavy submission
  // shouldn't be able to mass-create threats either.
  const capped = opts.urls.slice(0, 20);
  for (const u of capped) {
    if (!u.url) continue;
    if (exclude.has(u.url.toLowerCase())) continue;
    const id = threatId("abuse_mailbox", "url", u.url);
    const row: ThreatRow = {
      id,
      source_feed:      "abuse_mailbox",
      threat_type:      threatType,
      malicious_url:    u.url,
      malicious_domain: u.domain,
      target_brand_id:  opts.brandId ?? null,
      ip_address:       opts.senderIp ?? null,
      status:           "active",
      confidence_score: opts.confidence,
      ioc_value:        u.url,
      severity,
      technique:        opts.technique ?? null,
      named_threat_id:  opts.namedThreatId ?? null,
    };
    try {
      await insertThreat(env.DB, row);
      // insertThreat is INSERT OR IGNORE — a repeat report of the same
      // URL won't overwrite. Backfill the technique / named-threat label
      // onto an existing row so naming sticks even on dedup.
      if (opts.technique || opts.namedThreatId) {
        await env.DB.prepare(
          `UPDATE threats
           SET technique = COALESCE(technique, ?),
               named_threat_id = COALESCE(named_threat_id, ?)
           WHERE id = ?`,
        ).bind(opts.technique ?? null, opts.namedThreatId ?? null, id).run();
      }
      ids.push(id);
    } catch (err) {
      console.warn(
        `[abuse_mailbox_iocs] promote failed for ${u.url} msg=${opts.messageId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return ids;
}

// ─── Domain extractor re-export for callers that don't want
//     to pull from two places. ─────────────────────────────────
export { extractDomain };
