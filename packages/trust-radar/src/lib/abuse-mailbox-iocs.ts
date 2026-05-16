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

function matchVerdict(flat: string, method: string): AuthVerdict | null {
  const re = new RegExp(`${method}=([a-z]+)`, "i");
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

const IP_PATTERN = /\[?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[0-9a-f:]+::?[0-9a-f:]+)\]?/i;

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
  // Cap the same way correlateUrls does. A wildly URL-heavy submission
  // shouldn't be able to mass-create threats either.
  const capped = opts.urls.slice(0, 20);
  for (const u of capped) {
    if (!u.url) continue;
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
    };
    try {
      await insertThreat(env.DB, row);
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
