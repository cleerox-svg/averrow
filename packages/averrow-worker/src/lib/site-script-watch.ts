/**
 * Site Script Watch — client-side supply-chain monitoring of a brand's OWN
 * website (Magecart / polyfill.io class of compromise).
 *
 * PR1: pure logic + one read helper. No agent, cron, route or alert uses
 * this yet. Schema: migrations/0337_site_script_watch.sql.
 *
 *   normaliseScriptUrl     URL → { host, path_norm } (query + fragment dropped)
 *   isFirstPartyHost       host equals / sits under the brand's canonical domain
 *   diffSiteScan           scan vs stored inventory → new_host / body_changed
 *   matchHostsAgainstThreats  hosts → ACTIVE threats (exact + parent domains)
 *
 * Host normalisation, parent-domain expansion and the shared-hosting list are
 * the ones the official-domain triage uses (lib/safeDomains.ts), so the two
 * features agree on what "a subdomain of X" means.
 */

import type { D1Database, D1DatabaseSession } from "@cloudflare/workers-types";
import {
  SHARED_HOSTING_DOMAINS,
  hostAndParents,
  isUnderSharedHosting,
  normalizeHost,
} from "./safeDomains";

// ─── Normalisation ──────────────────────────────────────────────────

/** Longest path_norm stored; longer paths are truncated (keeps the UNIQUE key bounded). */
export const SITE_SCRIPT_PATH_MAX = 1024;

export interface NormalisedScriptUrl {
  /** Lowercase hostname, no trailing dot, no port. IPv6 literals keep their brackets. */
  host: string;
  /** URL path only: query string and fragment dropped (they carry cache-busters). */
  path_norm: string;
}

/**
 * Normalise a script `src`. Relative URLs resolve against `baseUrl` (the
 * scanned page) when given. Returns null for anything that is not an
 * absolute http(s) URL with a host (data:, blob:, javascript:, garbage).
 * The port is dropped: inventory is keyed on host + path.
 */
export function normaliseScriptUrl(raw: string, baseUrl?: string): NormalisedScriptUrl | null {
  const input = raw.trim();
  if (!input) return null;
  let url: URL;
  try {
    url = baseUrl ? new URL(input, baseUrl) : new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return null;
  const path = url.pathname || "/";
  return { host, path_norm: path.length > SITE_SCRIPT_PATH_MAX ? path.slice(0, SITE_SCRIPT_PATH_MAX) : path };
}

// ─── First-party classification ─────────────────────────────────────

/**
 * Is `host` first-party for a brand whose canonical domain is
 * `canonicalDomain`? True when it equals the canonical domain or is a
 * subdomain of it. A leading `www.` on the canonical domain is ignored.
 *
 * Same rule as the official-domain triage: when the canonical domain is, or
 * sits under, a shared-hosting domain (acme.github.io, myshopify.com) only
 * an EXACT match counts, because subdomains there belong to other tenants.
 */
export function isFirstPartyHost(host: string, canonicalDomain: string): boolean {
  const h = normalizeHost(host);
  const canon = normalizeHost(canonicalDomain).replace(/^www\./, "");
  if (!h || !canon) return false;
  if (h === canon) return true;
  if (isUnderSharedHosting(canon)) return false;
  return h.endsWith(`.${canon}`);
}

// ─── Shared script CDNs ─────────────────────────────────────────────

/**
 * Public script CDNs: a host here serves many unrelated sites, so its first
 * appearance on a brand's page says nothing about the brand on its own. A
 * host matches an entry when it equals it or is a subdomain of it.
 * Deliberately NOT here: tag managers / analytics (a new one is worth a
 * look) and polyfill.io (the 2024 compromise this feature exists for).
 */
export const WELL_KNOWN_SCRIPT_CDNS: ReadonlySet<string> = new Set([
  "cdnjs.cloudflare.com",
  "jsdelivr.net",
  "unpkg.com",
  "ajax.googleapis.com",
  "fonts.googleapis.com",
  "gstatic.com",
  "code.jquery.com",
  "bootstrapcdn.com",
  "ajax.aspnetcdn.com",
  "cdn.shopify.com",
  "akamaihd.net",
  "esm.sh",
  "skypack.dev",
]);

/** Is `host` a well-known script CDN (or a subdomain of one)? */
export function isWellKnownScriptCdn(host: string): boolean {
  const labels = normalizeHost(host).split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (WELL_KNOWN_SCRIPT_CDNS.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

/** Shared infrastructure: a shared-hosting domain or a public script CDN. */
export function isSharedScriptHost(host: string): boolean {
  return isUnderSharedHosting(host) || isWellKnownScriptCdn(host);
}

// ─── Scan diff ──────────────────────────────────────────────────────

/** One script observed on a scan. sha256 null = body not fetched. */
export interface ScannedScript {
  url: string;
  sha256: string | null;
}

/** The stored inventory columns the diff needs (site_script_inventory). */
export interface InventoryRow {
  script_host: string;
  path_norm: string;
  last_sha256: string | null;
}

/** A script after normalisation and de-duplication, ready to upsert. */
export interface ObservedScript {
  host: string;
  path_norm: string;
  sha256: string | null;
  is_first_party: boolean;
  /** Public CDN / shared-hosting host. */
  shared: boolean;
}

export type SiteScriptFindingKind = "new_host" | "body_changed" | "ioc_match";

/** A diff finding (ioc_match comes from matchHostsAgainstThreats, not the diff). */
export interface SiteScriptDiffFinding {
  kind: "new_host" | "body_changed";
  host: string;
  path_norm: string;
  evidence: {
    url: string;
    sha256: string | null;
    prev_sha256?: string | null;
  };
}

export interface SiteScanDiff {
  /** Distinct (host, path_norm) scripts in this scan, first occurrence wins. */
  observed: ObservedScript[];
  findings: SiteScriptDiffFinding[];
  /** True when nothing was compared (first scan): no findings are produced. */
  baseline: boolean;
  /** Inputs dropped by normaliseScriptUrl (non-http(s), unparseable). */
  rejected: number;
}

export interface DiffSiteScanOptions {
  /** Brand's canonical domain, for first-party classification. */
  canonicalDomain: string;
  /** Page URL, to resolve relative script srcs. */
  pageUrl?: string;
  /**
   * First-ever scan for the brand. Defaults to "no stored inventory". The
   * baseline scan only builds the inventory and produces no findings.
   */
  baseline?: boolean;
}

/**
 * Diff one scan against the brand's stored inventory.
 *
 *   new_host     — an EXTERNAL script host with no inventory row for the
 *                  brand. Not raised for shared hosts (public script CDNs,
 *                  SHARED_HOSTING_DOMAINS): they are inventoried, and their
 *                  scripts still produce body_changed, but a CDN appearing on
 *                  the page is not by itself evidence of anything. One
 *                  finding per host, on its first new path.
 *   body_changed — same host + path_norm, both hashes known, different.
 *                  First-party scripts included (injected first-party JS is
 *                  the classic skimmer).
 *
 * A path never seen before on an already-known host produces no finding.
 */
export function diffSiteScan(
  scripts: readonly ScannedScript[],
  inventory: readonly InventoryRow[],
  opts: DiffSiteScanOptions,
): SiteScanDiff {
  const observed: ObservedScript[] = [];
  const seen = new Map<string, ObservedScript>();
  const firstUrl = new Map<string, string>();
  let rejected = 0;

  for (const s of scripts) {
    const n = normaliseScriptUrl(s.url, opts.pageUrl);
    if (!n) {
      rejected++;
      continue;
    }
    const key = `${n.host}\u0000${n.path_norm}`;
    const prior = seen.get(key);
    if (prior) {
      // Same script loaded twice (cache-buster variants): keep the first
      // known body.
      if (prior.sha256 === null && s.sha256) prior.sha256 = s.sha256;
      continue;
    }
    const o: ObservedScript = {
      host: n.host,
      path_norm: n.path_norm,
      sha256: s.sha256 || null,
      is_first_party: isFirstPartyHost(n.host, opts.canonicalDomain),
      shared: isSharedScriptHost(n.host),
    };
    seen.set(key, o);
    firstUrl.set(key, s.url);
    observed.push(o);
  }

  const baseline = opts.baseline ?? inventory.length === 0;
  if (baseline) return { observed, findings: [], baseline: true, rejected };

  const knownHosts = new Set<string>();
  const knownPaths = new Map<string, string | null>();
  for (const r of inventory) {
    const host = normalizeHost(r.script_host);
    knownHosts.add(host);
    knownPaths.set(`${host}\u0000${r.path_norm}`, r.last_sha256);
  }

  const findings: SiteScriptDiffFinding[] = [];
  const newHostRaised = new Set<string>();
  for (const o of observed) {
    const key = `${o.host}\u0000${o.path_norm}`;
    const url = firstUrl.get(key) ?? "";
    if (!knownHosts.has(o.host)) {
      if (!o.is_first_party && !o.shared && !newHostRaised.has(o.host)) {
        newHostRaised.add(o.host);
        findings.push({ kind: "new_host", host: o.host, path_norm: o.path_norm, evidence: { url, sha256: o.sha256 } });
      }
      continue;
    }
    if (!knownPaths.has(key)) continue;
    const prev = knownPaths.get(key) ?? null;
    if (prev && o.sha256 && prev !== o.sha256) {
      findings.push({
        kind: "body_changed",
        host: o.host,
        path_norm: o.path_norm,
        evidence: { url, sha256: o.sha256, prev_sha256: prev },
      });
    }
  }
  return { observed, findings, baseline: false, rejected };
}

// ─── IOC match against active threats ───────────────────────────────

/** Max lookup keys bound per statement (D1 caps a statement at 100 binds). */
export const SITE_SCRIPT_MATCH_CHUNK = 90;

export interface HostThreatMatch {
  /** The input host (normalised). */
  host: string;
  /** The threats.malicious_domain that matched: the host itself or one of its parents. */
  matched_value: string;
  match_kind: "exact" | "parent";
  threat_id: string;
}

/**
 * Lookup keys for one host: the host itself, plus its parent domains down to
 * the registrable domain. Hosts under shared hosting / public CDNs match
 * exactly only (their parents are the provider's domain, not the
 * operator's), and a key that is itself a shared-hosting domain or CDN is
 * never looked up — a feed listing `cdn.jsdelivr.net` would otherwise flag
 * every site that uses it.
 */
export function threatLookupKeys(host: string): string[] {
  const h = normalizeHost(host);
  if (!h || h.includes(" ")) return [];
  const isNoiseKey = (k: string): boolean => SHARED_HOSTING_DOMAINS.has(k) || isWellKnownScriptCdn(k);
  if (isSharedScriptHost(h)) return isNoiseKey(h) ? [] : [h];
  const keys = new Set<string>([h]);
  for (const k of hostAndParents(h)) if (!isNoiseKey(k)) keys.add(k);
  return [...keys];
}

/**
 * The lookup statement for `n` keys; values are always bound.
 *
 * Only `malicious_domain` is probed: it is the only threats host column with
 * an index (idx_threats_domain). `ioc_value`'s index (0001) went with 0013's
 * table rebuild and was never restored (see 0312's header), so an
 * `ioc_value IN (…)` probe would scan the whole table.
 *
 * `+status` (unary plus) is load-bearing: without it SQLite picks
 * idx_threats_status_created and walks every ACTIVE threat instead of
 * seeking idx_threats_domain for the few bound values (pinned by the
 * EXPLAIN QUERY PLAN test).
 */
export function threatMatchSql(n: number): string {
  const placeholders = Array.from({ length: n }, () => "?").join(", ");
  return (
    "SELECT malicious_domain AS matched_value, MIN(id) AS threat_id FROM threats " +
    `WHERE malicious_domain IN (${placeholders}) AND +status = 'active' ` +
    "GROUP BY malicious_domain"
  );
}

/**
 * Match hosts against ACTIVE threats on `threats.malicious_domain` (exact
 * value match, idx_threats_domain), including each host's parent domains
 * (see threatLookupKeys). One row per (host, matched value) with the lowest
 * matching threat id. Values are always bound, ≤ SITE_SCRIPT_MATCH_CHUNK per
 * statement. Pass a read session.
 */
export async function matchHostsAgainstThreats(
  db: D1Database | D1DatabaseSession,
  hosts: readonly string[],
): Promise<HostThreatMatch[]> {
  // key → the input hosts it was derived from.
  const keyHosts = new Map<string, Set<string>>();
  for (const raw of hosts) {
    const host = normalizeHost(raw);
    for (const k of threatLookupKeys(host)) {
      const set = keyHosts.get(k) ?? new Set<string>();
      set.add(host);
      keyHosts.set(k, set);
    }
  }
  const keys = [...keyHosts.keys()];
  if (keys.length === 0) return [];

  const out: HostThreatMatch[] = [];
  for (let i = 0; i < keys.length; i += SITE_SCRIPT_MATCH_CHUNK) {
    const chunk = keys.slice(i, i + SITE_SCRIPT_MATCH_CHUNK);
    const res = await db
      .prepare(threatMatchSql(chunk.length))
      .bind(...chunk)
      .all<{ matched_value: string; threat_id: string }>();
    for (const row of res.results ?? []) {
      for (const host of keyHosts.get(row.matched_value) ?? []) {
        out.push({
          host,
          matched_value: row.matched_value,
          match_kind: row.matched_value === host ? "exact" : "parent",
          threat_id: row.threat_id,
        });
      }
    }
  }
  return out;
}
