/**
 * WHOIS/RDAP Enrichment — Query domain registration data via RDAP.
 *
 * Resolves a per-TLD RDAP server via the IANA bootstrap (cached in
 * KV for 7d) and queries that server directly. Was rdap.org until
 * the 2026-05-16 audit found they started returning HTTP 403
 * "Host not in allowlist" to Cloudflare Workers, silently nulling
 * 100% of our registrar enrichment.
 *
 * Falls back gracefully on errors or rate limits. Non-blocking:
 * failures are logged but never block the pipeline.
 */

import { getRdapServerForDomain } from "./rdap-bootstrap";
import type { Env } from "../types";

export interface RDAPResult {
  registrar: string | null;
  registrationDate: string | null;
  expirationDate: string | null;
}

interface RDAPEntity {
  vcardArray?: [string, ...Array<[string, Record<string, string>, string, string]>];
  roles?: string[];
  handle?: string;
}

interface RDAPEvent {
  eventAction: string;
  eventDate: string;
}

interface RDAPResponse {
  entities?: RDAPEntity[];
  events?: RDAPEvent[];
}

/**
 * Query RDAP for a domain's registration data. Resolves the per-TLD
 * RDAP server via the IANA bootstrap (KV-cached) and queries it
 * directly. Returns null on any failure — caller must handle.
 *
 * Pass `env` so the bootstrap can be cached. The legacy single-arg
 * signature is preserved (env-less variants fall back to rdap.org
 * which is broken — kept only so existing callers compile while
 * they migrate).
 */
export async function rdapLookup(
  domain: string,
  envOrIsFirst?: Env | boolean,
  _isFirst = false,
): Promise<RDAPResult | null> {
  // Backwards-compat: the legacy 2nd arg was a boolean isFirst flag.
  // If callers pass an object (Env), treat it as the new signature.
  const env = typeof envOrIsFirst === "object" ? envOrIsFirst : null;
  try {
    let url: string;
    if (env) {
      const server = await getRdapServerForDomain(env, domain);
      if (!server) {
        // No RDAP server for this TLD — silently skip. Many ccTLDs
        // don't publish RDAP servers; this is expected.
        return null;
      }
      const base = server.endsWith("/") ? server : `${server}/`;
      url = `${base}domain/${encodeURIComponent(domain)}`;
    } else {
      // Legacy callers — keeps tests passing while they migrate.
      url = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
    }
    const res = await fetch(url, {
      headers: { Accept: "application/rdap+json" },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.error(`[whois] HTTP ${res.status} for ${domain} via ${url}`);
      return null;
    }

    const data = (await res.json()) as RDAPResponse;
    return parseRDAPResponse(data);
  } catch (err) {
    console.error(`[whois] fetch error for ${domain}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function parseRDAPResponse(data: RDAPResponse): RDAPResult {
  // Extract registrar from entities with "registrar" role
  let registrar: string | null = null;
  const registrarEntity = data.entities?.find((e) => e.roles?.includes("registrar"));
  if (registrarEntity?.vcardArray) {
    const fn = registrarEntity.vcardArray[1]?.find((v: unknown) => Array.isArray(v) && v[0] === "fn");
    if (Array.isArray(fn)) registrar = fn[3] as string ?? null;
  }
  if (!registrar && registrarEntity?.handle) {
    registrar = registrarEntity.handle;
  }

  // Extract dates from events
  let registrationDate: string | null = null;
  let expirationDate: string | null = null;
  for (const event of data.events ?? []) {
    if (event.eventAction === "registration") registrationDate = event.eventDate;
    if (event.eventAction === "expiration") expirationDate = event.eventDate;
  }

  return { registrar, registrationDate, expirationDate };
}

/**
 * Batch RDAP lookups with rate limiting.
 * Processes sequentially with delay to respect free API limits.
 * Non-blocking: individual failures are logged and skipped.
 */
export async function batchRDAPLookup(
  domains: string[],
  env?: Env,
): Promise<Map<string, RDAPResult>> {
  const results = new Map<string, RDAPResult>();
  const unique = [...new Set(domains)];
  let consecutiveFailures = 0;

  for (let i = 0; i < unique.length; i++) {
    const domain = unique[i]!;
    // env-aware call: routes through IANA bootstrap when env is
    // present. Legacy callers that omit env continue to hit
    // rdap.org and will get null — they should migrate.
    const result = env
      ? await rdapLookup(domain, env)
      : await rdapLookup(domain, i === 0);

    if (result) {
      results.set(domain, result);
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      // If first 3 consecutive lookups all fail, RDAP is likely down — bail early
      if (consecutiveFailures >= 3) {
        console.error(`[whois] ${consecutiveFailures} consecutive RDAP failures — service likely down, stopping batch`);
        break;
      }
    }
    // RDAP has strict rate limits — 1 req/sec is safe
    await new Promise((r) => setTimeout(r, 1000));
  }

  return results;
}
