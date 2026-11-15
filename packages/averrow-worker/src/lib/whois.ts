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

import { getRdapServerForDomain, resolveRdapServer } from "./rdap-bootstrap";
import { validDnsName } from "./dnsbl-doh";
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

/** Whether a domain is registered, as far as RDAP can say. */
export type DomainRegistration = "registered" | "unregistered" | "unknown";

/** Byte cap on an RDAP error body (a 404 is a few hundred bytes). */
const RDAP_ERROR_BODY_MAX_BYTES = 8 * 1024;
/** Byte cap on an RDAP domain object. */
const RDAP_DOMAIN_BODY_MAX_BYTES = 256 * 1024;

/** Body text, or null when it is larger than `maxBytes` or unreadable. */
async function readCappedText(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Registered / unregistered / unknown for ONE domain. A false
 * "unregistered" scores a brand's SPF 0 under a CRITICAL "anyone can
 * register it" recommendation, so every doubt is `unknown`:
 *   - the RDAP base must come from the IANA bootstrap (never the static
 *     fallback table) and be https;
 *   - redirects are not followed (`redirect: 'manual'`); any 3xx is unknown;
 *   - "unregistered" needs HTTP 404 AND an RDAP answer: content-type
 *     application/rdap+json, or a (size-capped) JSON body with errorCode 404.
 *     A plain-HTML / proxy 404 is unknown;
 *   - "registered" needs HTTP 200 with an RDAP domain object.
 * Timeouts, 429 / 5xx, other statuses, a TLD with no bootstrap server,
 * unparseable bodies and invalid names are unknown. `timeoutMs` bounds
 * bootstrap + request together. Never throws.
 */
export async function rdapDomainRegistration(
  env: Env,
  domain: string,
  timeoutMs: number,
): Promise<DomainRegistration> {
  const name = validDnsName(domain);
  if (name === null || timeoutMs < 1) return "unknown";
  const deadline = Date.now() + timeoutMs;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server = await Promise.race([
      resolveRdapServer(env, name),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    if (!server || server.source !== "bootstrap") return "unknown";
    if (!server.base.toLowerCase().startsWith("https://")) return "unknown";
    const remaining = deadline - Date.now();
    if (remaining < 1) return "unknown";
    const base = server.base.endsWith("/") ? server.base : `${server.base}/`;
    const signal = AbortSignal.timeout(remaining);
    const res = await fetch(`${base}domain/${encodeURIComponent(name)}`, {
      headers: { Accept: "application/rdap+json" },
      redirect: "manual",
      signal,
    });
    if (res.status >= 300 && res.status < 400) return "unknown";
    if (res.status === 404) {
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("application/rdap+json")) return "unregistered";
      const body = parseJsonObject(await readCappedText(res, RDAP_ERROR_BODY_MAX_BYTES));
      return body && body.errorCode === 404 ? "unregistered" : "unknown";
    }
    if (res.status !== 200) return "unknown";
    const body = parseJsonObject(await readCappedText(res, RDAP_DOMAIN_BODY_MAX_BYTES));
    return body && body.objectClassName === "domain" ? "registered" : "unknown";
  } catch {
    return "unknown";
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
