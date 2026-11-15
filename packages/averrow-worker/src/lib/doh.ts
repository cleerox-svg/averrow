// DoH (DNS-over-HTTPS) TXT lookup against Cloudflare's 1.1.1.1
// resolver. Used by the FC scheduled DMARC-ramp reminder to check
// the live DMARC policy without bundling a DNS library or burning a
// D1 row.
//
// Conservatively cached in KV for 1 hour so re-checks across FC
// ticks don't hammer the resolver (FC fires every minute).

import { parseDmarcRecord } from './dmarc-record';

/** Only the KV binding is used; a caller with no Worker env (the email
 *  posture scanner) passes `{}` and gets uncached lookups. `Env` satisfies
 *  this structurally. */
export interface DohCacheEnv {
  CACHE?: KVNamespace;
}

interface DohAnswer {
  name: string;
  type: number;
  TTL:  number;
  data: string;
}

interface DohResponse {
  Status:  number;
  Answer?: DohAnswer[];
}

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const TIMEOUT_MS   = 5_000;

/**
 * Resolve TXT records for the given name. Returns the array of
 * record strings with the outer quotes stripped. Empty array on
 * NXDOMAIN, timeout, or any other failure — caller treats absence
 * as "lookup unavailable" rather than crashing.
 *
 * @param env  Worker env. CACHE binding is used opportunistically;
 *             a missing CACHE just disables caching.
 * @param name DNS name to resolve. Caller should NOT URL-encode.
 * @param ttlSeconds KV cache TTL. Default 3600 (1 hour) — TXT
 *                   records are rarely-changing; cache aggressively
 *                   to keep DoH cost low across high-frequency callers.
 */
export async function dohTxtLookup(
  env: DohCacheEnv,
  name: string,
  ttlSeconds = 3_600,
): Promise<string[]> {
  return (await dohTxtLookupDetailed(env, name, ttlSeconds)).records;
}

/** Outcome of a TXT lookup: `ok` (NOERROR, possibly no TXT answers),
 *  `nxdomain` (the name does not exist), `error` (SERVFAIL, HTTP error,
 *  timeout, bad JSON — the resolver could not answer). */
export type DohTxtStatus = 'ok' | 'nxdomain' | 'error';

/**
 * dohTxtLookup with the failure mode kept: callers that must not read a
 * resolver failure as "no record" (DMARC RUA enrollment) branch on
 * `status`. Same KV cache as dohTxtLookup (positive answers only), so a
 * cache hit reports `ok`. `opts.timeoutMs` overrides the 5 s fetch timeout
 * (the SPF tree walk passes what is left of its own wall-clock budget).
 */
export async function dohTxtLookupDetailed(
  env: DohCacheEnv,
  name: string,
  ttlSeconds = 3_600,
  opts: { timeoutMs?: number } = {},
): Promise<{ status: DohTxtStatus; records: string[] }> {
  const cacheKey = `doh:txt:${name.toLowerCase()}`;
  if (env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey);
      if (cached !== null) {
        return { status: 'ok', records: JSON.parse(cached) as string[] };
      }
    } catch {
      // KV miss / parse error — fall through to live lookup.
    }
  }

  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=TXT`;
  let records: string[] = [];
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal:  AbortSignal.timeout(Math.max(1, Math.min(opts.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS))),
    });
    if (!res.ok) {
      console.warn(`[doh] ${name} TXT HTTP ${res.status}`);
      return { status: 'error', records: [] };
    }
    const data = (await res.json()) as DohResponse;
    // NOERROR=0, NXDOMAIN=3; anything else (SERVFAIL=2, REFUSED=5) is a
    // resolver failure, not an answer.
    if (data.Status === 3) return { status: 'nxdomain', records: [] };
    if (data.Status !== 0) return { status: 'error', records: [] };
    records = (data.Answer ?? [])
      .filter((a) => a.type === 16) // TXT
      .map((a) => stripDohQuotes(a.data));
  } catch (err) {
    console.warn(`[doh] ${name} TXT failed:`, err instanceof Error ? err.message : String(err));
    return { status: 'error', records: [] };
  }

  if (env.CACHE && records.length > 0) {
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(records), { expirationTtl: ttlSeconds });
    } catch {
      // KV transient — non-fatal.
    }
  }
  return { status: 'ok', records };
}

/**
 * DoH returns TXT records as `"value"` (outer double quotes) or
 * `"part1" "part2"` for split records. Strip the framing quotes and
 * join split parts so callers get the logical record string.
 */
export function stripDohQuotes(raw: string): string {
  // Match `"..."` segments and join. Falls back to the raw string
  // if the framing is unexpected.
  const matches = raw.match(/"([^"]*)"/g);
  if (!matches) return raw;
  return matches.map((m) => m.slice(1, -1)).join('');
}

/**
 * Pluck the `p=...` policy value out of a DMARC TXT record.
 * Returns null if the record doesn't look like DMARC or lacks a
 * policy. Lowercased.
 */
export function parseDmarcPolicy(txt: string): 'none' | 'quarantine' | 'reject' | null {
  // Shared RFC 9989 tag parser — the old `/p\s*=/` regex also matched
  // inside `np=` / `sp=` (e.g. `v=DMARC1; np=none; p=reject` read 'none').
  return parseDmarcRecord(txt.trim())?.p ?? null;
}
