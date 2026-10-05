// Safe domain lookup helper for threat pipeline integration

import type { D1Database } from "@cloudflare/workers-types";
import { registrableDomain } from "./domain-utils";

/** Load all safe domains into a Set for O(1) lookup during a cron cycle */
export async function loadSafeDomainSet(db: D1Database): Promise<Set<string>> {
  const rows = await db.prepare("SELECT domain FROM brand_safe_domains").all<{ domain: string }>();
  const set = new Set<string>();
  for (const r of rows.results) {
    set.add(r.domain.toLowerCase());
    // Also add www. variant for matching (but not for wildcards)
    if (!r.domain.startsWith("www.") && !r.domain.startsWith("*.")) {
      set.add("www." + r.domain.toLowerCase());
    }
  }
  return set;
}

/** Check if a domain is in the safe set, supporting wildcards.
 *  - Exact match: "lowes.com" matches "lowes.com"
 *  - Wildcard match: "*.lowes.com" matches "sub.lowes.com", "a.b.lowes.com"
 */
export function isSafeDomain(domain: string, safeSet: Set<string>): boolean {
  const d = domain.toLowerCase().replace(/\.$/, "");

  // Exact match
  if (safeSet.has(d)) return true;

  // Check without www
  const noWww = d.replace(/^www\./, "");
  if (noWww !== d && safeSet.has(noWww)) return true;

  // Wildcard match: for "sub.lowes.com", check "*.lowes.com"
  // For "a.b.lowes.com", check "*.b.lowes.com" then "*.lowes.com"
  const parts = d.split(".");
  for (let i = 1; i < parts.length; i++) {
    const wildcard = "*." + parts.slice(i).join(".");
    if (safeSet.has(wildcard)) return true;
  }

  return false;
}

// ─── Official-domain lookup (lookalike false-positive guard) ─────────
//
// The lookalike pipeline generates permutations of a brand's domain and
// alerts when one is registered. A permutation can be ANOTHER brand's own
// official domain — zoom.com is a TLD swap of zoom.us, cloud.com an
// omission of icloud.com, ing.com an omission of bing.com — and those are
// not squats. This block answers "is this host some brand's official
// domain?" from `brand_safe_domains` (any brand) and `brands.
// canonical_domain` (any brand). It is shared by the seeder (filter at
// seed time) and the alert triage rule (dismiss at alert time) so the two
// cannot drift.
//
// Both columns are written lowercase without a trailing dot
// (handlers/safeDomains.ts `cleanDomain`; prod verified 2026-10-05: 0
// mixed-case rows in either), so the lookup binds lowercase keys against
// the plain binary indexes `idx_safe_domains_domain` (migration 0015) and
// the unique `idx_brands_domain` (migration 0042).

/**
 * Registrable domains whose SUBDOMAINS are handed to third parties
 * (private public-suffix entries). `paypal-login.github.io` is NOT owned
 * by GitHub, so a parent / wildcard match on one of these must never
 * clear a lookalike. An EXACT match (the host is `github.io` itself)
 * still does. Deliberately a fixed list: a missing entry can only cause a
 * false dismissal of a subdomain-shaped lookalike under that platform,
 * and dnstwist permutations are registrable-level names, so the exposure
 * is limited to producers that alert on arbitrary hosts.
 */
export const SHARED_HOSTING_DOMAINS: ReadonlySet<string> = new Set([
  "github.io", "gitlab.io", "blogspot.com", "wordpress.com", "wixsite.com",
  "weebly.com", "squarespace.com", "myshopify.com", "herokuapp.com",
  "azurewebsites.net", "cloudapp.net", "sharepoint.com", "windows.net",
  "cloudfront.net", "amazonaws.com", "appspot.com", "web.app", "firebaseapp.com",
  "netlify.app", "vercel.app", "pages.dev", "workers.dev", "r2.dev",
  "trycloudflare.com", "glitch.me", "repl.co", "onrender.com", "fly.dev",
  "ngrok.io", "ngrok-free.app", "duckdns.org", "000webhostapp.com",
  "godaddysites.com", "webflow.io", "notion.site", "carrd.co", "framer.app",
]);

/** Lowercase, trim, strip a scheme / path / port and a trailing dot. */
export function normalizeHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.+$/, "");
}

/**
 * The host itself plus every parent down to (and including) its
 * registrable domain. Never goes above the registrable domain, so a bare
 * public suffix (`com`, `co.uk`) is never a lookup key.
 */
export function hostAndParents(host: string): string[] {
  const h = normalizeHost(host);
  if (!h || h.includes(" ")) return [];
  const reg = registrableDomain(h);
  if (!reg) return [];
  const labels = h.split(".");
  const regLabels = reg.split(".").length;
  const out: string[] = [];
  for (let i = 0; labels.length - i >= regLabels; i++) out.push(labels.slice(i).join("."));
  return out;
}

/** One row returned by `loadOfficialDomainMatches`. */
export interface OfficialDomainRow {
  /** The stored key that matched — may be a `*.` wildcard entry. */
  domain: string;
  brand_id: string;
  brand_name: string | null;
  source: "safe_domain" | "canonical_domain";
}

/** The resolved match for one host. */
export interface OfficialDomainMatch {
  /** The official domain the host is (or is under). */
  official_domain: string;
  brand_id: string;
  brand_name: string | null;
  source: "safe_domain" | "canonical_domain";
  /** true = the host IS the official domain; false = a subdomain of it. */
  exact: boolean;
}

/**
 * PURE. Decide whether `host` is some brand's official domain, given the
 * rows the lookup returned (rows for other hosts in a batch are ignored).
 *
 *   exact       host == safe domain / canonical domain (www. ignored)
 *   subdomain   host is under a safe/canonical domain, or under a `*.x`
 *               wildcard entry — only when x is NOT shared hosting.
 *
 * Exact beats subdomain; canonical beats safe_domain; then brand_id order,
 * so the chosen brand is deterministic.
 */
export function matchOfficialDomain(
  host: string,
  rows: readonly OfficialDomainRow[],
): OfficialDomainMatch | null {
  const h = normalizeHost(host);
  const parents = hostAndParents(h);
  if (parents.length === 0) return null;
  const bare = h.replace(/^www\./, "");

  const candidates: OfficialDomainMatch[] = [];
  for (const r of rows) {
    const key = normalizeHost(r.domain);
    let official: string;
    let exact: boolean;
    if (key.startsWith("*.")) {
      official = key.slice(2);
      // A wildcard covers strict subdomains only.
      if (official === h || !parents.includes(official)) continue;
      exact = false;
    } else {
      if (!parents.includes(key)) continue;
      official = key;
      exact = key === h || key === bare;
    }
    if (!exact && SHARED_HOSTING_DOMAINS.has(official)) continue;
    candidates.push({ official_domain: official, brand_id: r.brand_id, brand_name: r.brand_name, source: r.source, exact });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    Number(b.exact) - Number(a.exact) ||
    Number(b.source === "canonical_domain") - Number(a.source === "canonical_domain") ||
    (a.brand_id < b.brand_id ? -1 : a.brand_id > b.brand_id ? 1 : 0));
  return candidates[0] ?? null;
}

/** Plain keys per statement. Each plain key binds up to 3 params (safe
 *  exact, safe wildcard, canonical), so 33 keeps a statement at <=99. */
export const OFFICIAL_DOMAIN_KEYS_PER_QUERY = 33;

/**
 * Fetch every `brand_safe_domains` / `brands.canonical_domain` row that
 * could match any of `hosts` (the hosts and their parents, plus `*.`
 * wildcard forms of the parents). One indexed statement per 33 distinct
 * keys — a single alert is always one statement. Pass the rows and a
 * host to `matchOfficialDomain`.
 */
export async function loadOfficialDomainMatches(
  db: D1Database,
  hosts: readonly string[],
): Promise<OfficialDomainRow[]> {
  const keys = Array.from(new Set(hosts.flatMap((h) => hostAndParents(h))));
  const out: OfficialDomainRow[] = [];
  for (let i = 0; i < keys.length; i += OFFICIAL_DOMAIN_KEYS_PER_QUERY) {
    const chunk = keys.slice(i, i + OFFICIAL_DOMAIN_KEYS_PER_QUERY);
    const safeKeys = [...chunk, ...chunk.map((k) => `*.${k}`)];
    const ph = (n: number) => Array.from({ length: n }, () => "?").join(",");
    const res = await db.prepare(
      `SELECT s.domain AS domain, s.brand_id AS brand_id, b.name AS brand_name,
              'safe_domain' AS source
         FROM brand_safe_domains s
         LEFT JOIN brands b ON b.id = s.brand_id
        WHERE s.domain IN (${ph(safeKeys.length)})
       UNION ALL
       SELECT b.canonical_domain AS domain, b.id AS brand_id, b.name AS brand_name,
              'canonical_domain' AS source
         FROM brands b
        WHERE b.canonical_domain IN (${ph(chunk.length)})`,
    ).bind(...safeKeys, ...chunk).all<OfficialDomainRow>();
    out.push(...(res.results ?? []));
  }
  return out;
}
