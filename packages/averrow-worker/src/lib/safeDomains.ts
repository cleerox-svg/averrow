// Safe domain lookup helper for threat pipeline integration

import type { D1Database } from "@cloudflare/workers-types";
import { registrableDomain } from "./domain-utils";
import { IDP_TENANT_HOSTS } from "./idp-impersonation";

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
// omission of icloud.com — and those are not squats. This block answers
// "is this host some brand's official domain, and do we TRUST that?". It
// is shared by the seeder (benign at seed time) and the alert triage rule
// (dismiss at alert time) so the two cannot drift.
//
// ── TRUST IS A HEURISTIC, and only the trusted set may dismiss ──────────
//
// Neither table is an allowlist by construction (audited 2026-10-05):
//   * brand_safe_domains: 10,015 of 10,019 rows are `auto_detected`
//     copies of brands.canonical_domain (+ www./*. variants) — no trust of
//     their own. Only `manual` / `csv_upload` rows are a human decision
//     (written through requireStaffMutation routes, handlers/safeDomains.ts).
//   * brands.canonical_domain has UNTRUSTED writers: the analyst agent
//     creates brands whose canonical_domain IS the phishing domain
//     (`ai_attributed`, 119 in prod, e.g. icloudflnd.info); the
//     unauthenticated public monitor/assess endpoints insert any submitted
//     domain (`self_service` / `public_assess`) — an attacker could
//     allowlist paypa1.com; and the Tranco catalog itself contains
//     typosquats (cloudfare.com rank 55,323, goole.com, twiter.com).
//
// TRUSTED (may dismiss / mark benign):
//   brand_safe_domains.source IN ('manual','csv_upload')
//   OR brands.canonical_domain where the brand's source is NOT in
//      ('ai_attributed','public_assess','self_service') (NULL source —
//      e.g. the analyst writer, which stamps none — is not trusted unless
//      another clause admits it) AND
//      (tier = 'customer' OR source IN ('manual','curated')
//       OR tranco_rank <= 20000)
// Everything else that matches is only a POSSIBLE owner: the alert is
// kept and the owner is recorded as unverified.
//
// Both columns are written lowercase without a trailing dot (prod
// verified 2026-10-05: 0 mixed-case rows), so the lookup binds lowercase
// keys against the binary indexes `idx_safe_domains_domain` (0015) and the
// unique `idx_brands_domain` (0042).

/** Safe-domain sources that are a human decision. */
export const TRUSTED_SAFE_DOMAIN_SOURCES = ["manual", "csv_upload"] as const;
/** Brand sources whose canonical_domain is never trusted. */
export const UNTRUSTED_BRAND_SOURCES = ["ai_attributed", "public_assess", "self_service"] as const;
/** Brand sources whose canonical_domain is trusted. */
export const TRUSTED_BRAND_SOURCES = ["manual", "curated"] as const;
/** Tranco rank at or below which a brand's canonical_domain is trusted. */
export const TRUSTED_TRANCO_RANK_MAX = 20000;

const sqlList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

/** SQL: 1 when the `b` (brands) row's canonical_domain is trusted. Built
 *  from the constants above only — no runtime input is interpolated.
 *
 *  TRUST INVARIANT for the `tier = 'customer'` clause: it is sound only
 *  while NO runtime code path writes `tier = 'customer'` onto a brand whose
 *  canonical_domain a tenant (or anyone unauthenticated) supplied. Today the
 *  only writer is migration 0156 (a one-off backfill from org_brands); no
 *  handler sets it (verified 2026-10-05: `grep "SET tier"` = 0156 only).
 *  A future "customer adds a brand" flow that sets tier='customer' from a
 *  submitted domain would let a tenant allowlist a typosquat platform-wide
 *  — it must either not set this tier or this clause must change. Same for
 *  `source IN ('manual','curated')`: written only by staff/seed paths. */
export const TRUSTED_BRAND_CANONICAL_SQL =
  `CASE WHEN COALESCE(b.source, '') IN (${sqlList(UNTRUSTED_BRAND_SOURCES)}) THEN 0 ` +
  `WHEN b.tier = 'customer' OR b.source IN (${sqlList(TRUSTED_BRAND_SOURCES)}) ` +
  `OR b.tranco_rank <= ${TRUSTED_TRANCO_RANK_MAX} THEN 1 ELSE 0 END`;

/** SQL: 1 when the `s` (brand_safe_domains) row is a human decision. */
export const TRUSTED_SAFE_DOMAIN_SQL =
  `CASE WHEN s.source IN (${sqlList(TRUSTED_SAFE_DOMAIN_SOURCES)}) THEN 1 ELSE 0 END`;

/**
 * Domains whose SUBDOMAINS are handed to third parties (private public-
 * suffix style). `paypal-login.github.io` is NOT owned by GitHub, so the
 * subdomain branch never applies when the matched key is, or sits under,
 * one of these. An exact match still can.
 */
export const SHARED_HOSTING_DOMAINS: ReadonlySet<string> = new Set([
  "github.io", "gitlab.io", "gitbook.io", "readthedocs.io", "webflow.io",
  "blogspot.com", "wordpress.com", "tumblr.com", "wixsite.com", "weebly.com",
  "weeblysite.com", "squarespace.com", "myshopify.com", "godaddysites.com",
  "000webhostapp.com", "herokuapp.com", "elasticbeanstalk.com", "amazonaws.com",
  "cloudfront.net", "azurewebsites.net", "azureedge.net", "azurestaticapps.net",
  "cloudapp.net", "windows.net", "onmicrosoft.com", "sharepoint.com",
  "force.com", "appspot.com", "cloudfunctions.net", "run.app", "web.app",
  "firebaseapp.com", "netlify.app", "vercel.app", "pages.dev", "workers.dev",
  "r2.dev", "trycloudflare.com", "deno.dev", "surge.sh", "glitch.me", "repl.co",
  "onrender.com", "fly.dev", "ngrok.io", "ngrok-free.app", "duckdns.org",
  "notion.site", "carrd.co", "framer.app", "zapier.app", "wasmer.app",
  "slack.com", "zendesk.com", "atlassian.net", "my.id", "biz.id", "o-r.kr",
  // Dynamic-DNS / free-subdomain / tunnel providers: anyone can mint a
  // name under these in minutes.
  "ddns.net", "hopto.org", "zapto.org", "no-ip.com", "no-ip.org", "no-ip.biz",
  "mooo.com", "dynu.net", "freedns.afraid.org", "ngrok.app", "localtunnel.me",
  // Identity-provider tenant hosts: acme-sso.okta.com is an attacker's
  // tenant, never an "official subdomain" of Okta / OneLogin / Auth0
  // (docs/IDP_IMPERSONATION_PLAN_2026-10.md). Same table the classifier uses.
  ...Object.keys(IDP_TENANT_HOSTS),
]);

/** Is `domain` a shared-hosting domain or under one? */
export function isUnderSharedHosting(domain: string): boolean {
  const labels = normalizeHost(domain).split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (SHARED_HOSTING_DOMAINS.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

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
  /** 1 = in the trusted set (see the block comment), 0 = possible owner only. */
  trusted: number;
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

export interface OfficialDomainResolution {
  /** A TRUSTED match (exact, or subdomain of a non-shared-hosting key). */
  trusted: OfficialDomainMatch | null;
  /** When no trusted match: an UNTRUSTED exact match — a possible owner. */
  possible: OfficialDomainMatch | null;
}

const byPreference = (a: OfficialDomainMatch, b: OfficialDomainMatch) =>
  Number(b.exact) - Number(a.exact) ||
  Number(b.source === "canonical_domain") - Number(a.source === "canonical_domain") ||
  (a.brand_id < b.brand_id ? -1 : a.brand_id > b.brand_id ? 1 : 0);

/**
 * PURE. Resolve `host` against the rows the lookup returned (rows for
 * other hosts in a batch are ignored).
 *
 *   exact       host == key (www. ignored). Trusted or possible.
 *   subdomain   host under key, or under a `*.key` wildcard row. TRUSTED
 *               keys only, and never when the key is or sits under a
 *               shared-hosting domain.
 *
 * Exact beats subdomain; canonical beats safe_domain; then brand_id
 * order, so the chosen brand is deterministic.
 */
export function resolveOfficialDomain(
  host: string,
  rows: readonly OfficialDomainRow[],
): OfficialDomainResolution {
  const h = normalizeHost(host);
  const parents = hostAndParents(h);
  const none: OfficialDomainResolution = { trusted: null, possible: null };
  if (parents.length === 0) return none;
  const bare = h.replace(/^www\./, "");

  const trusted: OfficialDomainMatch[] = [];
  const possible: OfficialDomainMatch[] = [];
  for (const r of rows) {
    const key = normalizeHost(r.domain);
    const isTrusted = Number(r.trusted) === 1;
    let official: string;
    let exact: boolean;
    if (key.startsWith("*.")) {
      official = key.slice(2);
      // A wildcard covers strict subdomains only.
      if (official === h || official === bare || !parents.includes(official)) continue;
      exact = false;
    } else {
      if (!parents.includes(key)) continue;
      official = key;
      exact = key === h || key === bare;
    }
    const m: OfficialDomainMatch = {
      official_domain: official, brand_id: r.brand_id, brand_name: r.brand_name, source: r.source, exact,
    };
    if (exact) {
      (isTrusted ? trusted : possible).push(m);
    } else if (isTrusted && !isUnderSharedHosting(official)) {
      trusted.push(m);
    }
  }
  trusted.sort(byPreference);
  possible.sort(byPreference);
  const t = trusted[0] ?? null;
  return { trusted: t, possible: t ? null : possible[0] ?? null };
}

/** Plain keys per statement. Each plain key binds up to 3 params (safe
 *  exact, safe wildcard, canonical), so 33 keeps a statement at <=99. */
export const OFFICIAL_DOMAIN_KEYS_PER_QUERY = 33;

/**
 * Fetch every `brand_safe_domains` / `brands.canonical_domain` row that
 * could match any of `hosts` (the hosts and their parents, plus `*.`
 * wildcard forms), with its `trusted` flag computed in SQL. One indexed
 * statement per 33 distinct keys — a single alert is always one
 * statement. Pass the rows and a host to `resolveOfficialDomain`.
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
              'safe_domain' AS source, ${TRUSTED_SAFE_DOMAIN_SQL} AS trusted
         FROM brand_safe_domains s
         LEFT JOIN brands b ON b.id = s.brand_id
        WHERE s.domain IN (${ph(safeKeys.length)})
       UNION ALL
       SELECT b.canonical_domain AS domain, b.id AS brand_id, b.name AS brand_name,
              'canonical_domain' AS source, ${TRUSTED_BRAND_CANONICAL_SQL} AS trusted
         FROM brands b
        WHERE b.canonical_domain IN (${ph(chunk.length)})`,
    ).bind(...safeKeys, ...chunk).all<OfficialDomainRow>();
    out.push(...(res.results ?? []));
  }
  return out;
}

/** The note recorded on a lookalike row / alert for a trusted match. */
export function officialDomainNote(host: string, m: OfficialDomainMatch): string {
  const brand = m.brand_name ?? m.brand_id;
  return m.exact
    ? `auto: ${host} is the official domain of ${brand}`
    : `auto: ${host} is a subdomain of ${m.official_domain}, the official domain of ${brand}`;
}
