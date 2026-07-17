// DoH (DNS-over-HTTPS) TXT lookup against Cloudflare's 1.1.1.1
// resolver. Used by the FC scheduled DMARC-ramp reminder to check
// the live DMARC policy without bundling a DNS library or burning a
// D1 row.
//
// Conservatively cached in KV for 1 hour so re-checks across FC
// ticks don't hammer the resolver (FC fires every minute).

import type { Env } from '../types';

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
  env: Env,
  name: string,
  ttlSeconds = 3_600,
): Promise<string[]> {
  const cacheKey = `doh:txt:${name.toLowerCase()}`;
  if (env.CACHE) {
    try {
      const cached = await env.CACHE.get(cacheKey);
      if (cached !== null) {
        return JSON.parse(cached) as string[];
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
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[doh] ${name} TXT HTTP ${res.status}`);
      return [];
    }
    const data = (await res.json()) as DohResponse;
    if (data.Status !== 0) {
      // NOERROR=0; anything else (NXDOMAIN=3, SERVFAIL=2) → empty.
      return [];
    }
    records = (data.Answer ?? [])
      .filter((a) => a.type === 16) // TXT
      .map((a) => stripDohQuotes(a.data));
  } catch (err) {
    console.warn(`[doh] ${name} TXT failed:`, err instanceof Error ? err.message : String(err));
    return [];
  }

  if (env.CACHE && records.length > 0) {
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(records), { expirationTtl: ttlSeconds });
    } catch {
      // KV transient — non-fatal.
    }
  }
  return records;
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
  if (!/v\s*=\s*DMARC1/i.test(txt)) return null;
  const m = /p\s*=\s*(none|quarantine|reject)/i.exec(txt);
  if (!m || !m[1]) return null;
  return m[1].toLowerCase() as 'none' | 'quarantine' | 'reject';
}
