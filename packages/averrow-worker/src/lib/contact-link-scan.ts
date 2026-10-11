// Link scanning for contact-form notification emails.
//
// The contact form is public and unauthenticated, so any link in a message
// is attacker-controlled. Before the staff email is built, every link in the
// message is checked; only links that pass every check that ran are rendered
// clickable. Anything flagged, or anything we could not check, is defanged
// (hxxps://example[.]com) so the mail client won't auto-link it either.
//
// Checks (no request is ever made to the link itself):
//   - structure: http(s) only, no user:pass@ prefix, no IP-literal host,
//     no punycode (homoglyph) host
//   - internal intel: active `threats` row on the host / registrable domain
//     or the exact URL; a registered, non-benign `lookalike_domains` row
//   - Google Safe Browsing (when GOOGLE_SAFE_BROWSING_KEY is set)
//   - domain age via RDAP: registered within NRD_MAX_AGE_DAYS → flagged;
//     an unknown age is noted but does not block
//
// Fails closed: a failed intel query, a Safe Browsing error, or the overall
// time budget running out leaves the link "unchecked" (not clickable).

import type { Env } from "../types";
import { checkGoogleSafeBrowsing } from "../feeds/googleSafeBrowsing";
import { NRD_MAX_AGE_DAYS } from "./domain-age";
import { registrableDomain } from "./registrable-domain";
import { rdapLookup } from "./whois";
import { logger } from "./logger";

export type LinkVerdict = "clean" | "flagged" | "unchecked";

export interface FoundLink {
  /** Exact text as it appears in the message. */
  raw: string;
  start: number;
  end: number;
  /** Absolute URL (bare domains get https://), or null if unparseable. */
  href: string | null;
  host: string | null;
}

export interface ScannedLink extends FoundLink {
  verdict: LinkVerdict;
  reasons: string[];
  /** Informational, never changes the verdict. */
  notes: string[];
}

export interface LinkScanReport {
  links: ScannedLink[];
  /** Which checks ran, for the email footer. */
  checks: string[];
}

/** Links past this many in one message are left unchecked. */
export const MAX_SCANNED_LINKS = 10;
/** Whole-scan wall-clock budget; the visitor is waiting on the response. */
export const LINK_SCAN_BUDGET_MS = 6000;

// A scheme URL, or a bare host (optionally www., port, path). The lookbehind
// and lookahead keep email addresses (first.last@example.com) out.
const LINK_RE =
  /\bhttps?:\/\/[^\s<>"'`]+|(?<![@\w.\-/])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![\w@-])(?::\d{2,5})?(?:\/[^\s<>"'`]*)?/gi;
const TRAILING_JUNK_RE = /[)\].,;:!?'"]+$/;

// File-name extensions that look like TLDs in prose ("Node.js", "report.pdf").
// .zip / .mov are real (and abused) TLDs, so they stay links.
const FILE_EXTENSIONS = new Set([
  "js", "ts", "jsx", "tsx", "py", "rb", "md", "txt", "json", "yaml", "yml", "xml",
  "html", "htm", "css", "csv", "pdf", "png", "jpg", "jpeg", "gif", "svg", "doc",
  "docx", "xls", "xlsx", "ppt", "pptx", "exe", "dll", "sh", "php", "java", "log",
]);

/** Find candidate links in a message, in order of appearance. */
export function findLinks(message: string): FoundLink[] {
  const out: FoundLink[] = [];
  for (const m of message.matchAll(LINK_RE)) {
    const raw = m[0].replace(TRAILING_JUNK_RE, "");
    if (raw.length < 4) continue;
    const hasScheme = /^https?:\/\//i.test(raw);
    if (!hasScheme) {
      const hostPart = raw.split(/[/:]/)[0]!.toLowerCase();
      const tld = hostPart.slice(hostPart.lastIndexOf(".") + 1);
      if (FILE_EXTENSIONS.has(tld)) continue;
    }
    let href: string | null = null;
    let host: string | null = null;
    try {
      const u = new URL(hasScheme ? raw : `https://${raw}`);
      href = u.href;
      host = u.hostname.toLowerCase();
    } catch {
      // keep it: an unparseable "link" is rendered defanged
    }
    const start = m.index ?? 0;
    out.push({ raw, start, end: start + raw.length, href, host });
  }
  return out;
}

/** hxxps://example[.]com/path — not clickable, not auto-linked. */
export function defangLink(raw: string): string {
  return raw.replace(/^http/i, "hxxp").replace(/\./g, "[.]");
}

/** Problems visible from the URL alone. */
function structuralReasons(link: FoundLink): string[] {
  if (!link.href || !link.host) return ["could not be parsed as a URL"];
  const u = new URL(link.href);
  const reasons: string[] = [];
  if (u.protocol !== "https:" && u.protocol !== "http:") reasons.push("not an http(s) link");
  if (u.username || u.password) reasons.push("hides its real destination behind a user@ prefix");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(link.host) || link.host.startsWith("[")) {
    reasons.push("points at a raw IP address");
  }
  if (link.host.split(".").some((l) => l.startsWith("xn--"))) {
    reasons.push("internationalised domain (possible look-alike characters)");
  }
  return reasons;
}

const keyOf = (host: string) => registrableDomain(host) ?? host;

interface IntelHits {
  domains: Map<string, string>; // domain → reason
  urls: Map<string, string>;    // url → reason
}

async function internalIntel(env: Env, hosts: string[], urls: string[]): Promise<IntelHits> {
  const domains = [...new Set(hosts.flatMap((h) => [h, keyOf(h)]))];
  const ph = (n: number) => Array(n).fill("?").join(",");
  const [byDomain, byUrl, lookalikes] = await Promise.all([
    env.DB.prepare(
      `SELECT malicious_domain AS d, threat_type AS t FROM threats
        WHERE status = 'active' AND malicious_domain IN (${ph(domains.length)}) LIMIT 50`,
    ).bind(...domains).all<{ d: string; t: string | null }>(),
    env.DB.prepare(
      `SELECT malicious_url AS u, threat_type AS t FROM threats
        WHERE status = 'active' AND malicious_url IN (${ph(urls.length)}) LIMIT 50`,
    ).bind(...urls).all<{ u: string; t: string | null }>(),
    env.DB.prepare(
      `SELECT domain AS d FROM lookalike_domains
        WHERE registered = 1 AND status != 'benign' AND domain IN (${ph(domains.length)}) LIMIT 50`,
    ).bind(...domains).all<{ d: string }>(),
  ]);
  const hits: IntelHits = { domains: new Map(), urls: new Map() };
  for (const r of byDomain.results ?? []) {
    hits.domains.set(r.d.toLowerCase(), `known active threat in Averrow intel (${r.t ?? "malicious"})`);
  }
  for (const r of lookalikes.results ?? []) {
    if (!hits.domains.has(r.d.toLowerCase())) {
      hits.domains.set(r.d.toLowerCase(), "registered look-alike of a monitored brand");
    }
  }
  for (const r of byUrl.results ?? []) hits.urls.set(r.u, `known active threat URL (${r.t ?? "malicious"})`);
  return hits;
}

async function domainAgeDays(env: Env, domain: string, now: number): Promise<number | null> {
  const r = await rdapLookup(domain, env);
  if (!r?.registrationDate) return null;
  const ms = Date.parse(r.registrationDate);
  if (!Number.isFinite(ms) || ms > now) return null;
  return Math.floor((now - ms) / 86_400_000);
}

async function runScan(
  env: Env,
  links: FoundLink[],
  senderEmail: string | null,
  now: number,
): Promise<LinkScanReport> {
  const scanned: ScannedLink[] = links.map((l) => ({ ...l, verdict: "clean", reasons: [], notes: [] }));
  const unchecked = (l: ScannedLink, why: string) => {
    if (l.verdict === "clean") l.verdict = "unchecked";
    l.reasons.push(why);
  };

  scanned.forEach((l, i) => {
    if (i >= MAX_SCANNED_LINKS) return unchecked(l, `not checked (only the first ${MAX_SCANNED_LINKS} links are)`);
    const s = structuralReasons(l);
    if (s.length) { l.verdict = "flagged"; l.reasons.push(...s); }
  });
  const toCheck = scanned.filter((l, i) => i < MAX_SCANNED_LINKS && l.verdict === "clean");
  const checks = ["link structure"];
  if (toCheck.length === 0) return { links: scanned, checks };

  const hosts = [...new Set(toCheck.map((l) => l.host!))];
  const hrefs = [...new Set(toCheck.map((l) => l.href!))];
  const regDomains = [...new Set(hosts.map(keyOf))];
  const gsbConfigured = Boolean(env.GOOGLE_SAFE_BROWSING_KEY);

  const [intel, gsb, ages] = await Promise.all([
    internalIntel(env, hosts, hrefs).catch((err: unknown) => {
      logger.warn("contact-link-scan-intel-failed", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }),
    gsbConfigured
      ? checkGoogleSafeBrowsing(hrefs, env).catch((err: unknown) => {
          logger.warn("contact-link-scan-gsb-failed", { error: err instanceof Error ? err.message : String(err) });
          return null;
        })
      : Promise.resolve(null),
    Promise.all(regDomains.map((d) => domainAgeDays(env, d, now).catch(() => null))),
  ]);
  checks.push("Averrow threat intel", gsbConfigured ? "Google Safe Browsing" : "Google Safe Browsing (not configured)", "domain age (RDAP)");
  const ageByDomain = new Map(regDomains.map((d, i) => [d, ages[i] ?? null]));
  const senderKey = senderEmail?.includes("@") ? keyOf(senderEmail.split("@").pop()!.toLowerCase()) : null;

  for (const l of toCheck) {
    const host = l.host!;
    const reg = keyOf(host);
    if (!intel) unchecked(l, "threat-intel lookup failed");
    else {
      const hit = intel.urls.get(l.href!) ?? intel.domains.get(host) ?? intel.domains.get(reg);
      if (hit) { l.verdict = "flagged"; l.reasons.push(hit); }
    }
    if (gsbConfigured) {
      const r = gsb?.[hrefs.indexOf(l.href!)];
      if (!r || r.checked === false) unchecked(l, "Google Safe Browsing did not answer");
      else if (r.flagged) { l.verdict = "flagged"; l.reasons.push(`Google Safe Browsing: ${r.threatType ?? "flagged"}`); }
    }
    const age = ageByDomain.get(reg) ?? null;
    if (age === null) l.notes.push("domain age unknown");
    else if (age <= NRD_MAX_AGE_DAYS) { l.verdict = "flagged"; l.reasons.push(`domain registered ${age} day${age === 1 ? "" : "s"} ago`); }
    else l.notes.push(`domain registered ${age >= 730 ? `${Math.floor(age / 365)} years` : `${age} days`} ago`);
    if (senderKey && senderKey !== reg) l.notes.push(`different domain from the sender's email (${senderKey})`);
  }
  return { links: scanned, checks };
}

/**
 * Scan the links in a contact message. Never throws; with no links it makes
 * no queries or requests at all.
 */
export async function scanContactLinks(
  env: Env,
  message: string,
  senderEmail: string | null,
  now = Date.now(),
): Promise<LinkScanReport> {
  const links = findLinks(message);
  if (links.length === 0) return { links: [], checks: [] };
  const allUnchecked = (why: string): LinkScanReport => ({
    links: links.map((l) => ({ ...l, verdict: "unchecked", reasons: [why], notes: [] })),
    checks: [],
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<LinkScanReport>((resolve) => {
    timer = setTimeout(() => resolve(allUnchecked("link check timed out")), LINK_SCAN_BUDGET_MS);
  });
  try {
    return await Promise.race([runScan(env, links, senderEmail, now), timeout]);
  } catch (err) {
    logger.warn("contact-link-scan-failed", { error: err instanceof Error ? err.message : String(err) });
    return allUnchecked("link check failed");
  } finally {
    clearTimeout(timer);
  }
}
