/**
 * GeoIP MMDB-style lookup — third-tier geo provider.
 *
 * Cartographer's enrichment pipeline used to be:
 *   Phase 0: ip-api.com batch  → fast but ~7% lat/lng yield on
 *                                malicious IPs
 *   Phase 1: ipinfo.io fallback → similar census data, similar
 *                                gaps for sinkhole / anycast / CDN
 *
 * Both providers source from the same census-style geolocation
 * datasets, so they converge on the same coverage holes. The fix
 * is a different DATA SOURCE — MaxMind GeoLite2 (or db-ip Lite),
 * loaded into a dedicated D1 database and queried as a single
 * indexed range scan.
 *
 * Why a separate D1 (binding GEOIP_DB):
 *   - 5M IP ranges × hot lookup path would inflate the main DB's
 *     read budget (today ~2.2M reads/24h on `trust-radar-v2`).
 *   - Refresh writes (millions of rows on a monthly cadence)
 *     would steal the main DB's writer.
 *   - Sizing/scaling is independent — we can shard or migrate to
 *     a different store without touching the main DB.
 *
 * Operational state:
 *   - GEOIP_DB binding: declared in wrangler.toml, optional in Env
 *     interface so non-prod / older deploys still typecheck.
 *   - When the binding is missing OR the table is empty, lookup()
 *     returns null and the caller falls through to the next phase.
 *   - This module is read-only — refresh logic lives in the
 *     `geoip_refresh` agent.
 */

import type { Env } from '../types';

// KV cache TTL — geographic data for a given IP changes on the order of
// weeks/months. 24h is a good balance of freshness and cache hit rate.
const KV_TTL_S = 24 * 60 * 60;

// In-memory LRU bound — Workers don't persist across invocations, but
// within a single hot invocation (e.g. cartographer's Phase 0.5 loop
// over 500 IPs) repeated lookups hit this. Bounded so a malicious or
// pathological caller can't blow our 128MB budget.
const MEMORY_LRU_MAX = 1000;
const memoryLru = new Map<string, GeoIpLookupResult | null>();

export interface GeoIpLookupResult {
  ip: string;
  countryCode: string | null;
  countryName: string | null;
  region: string | null;
  city: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  asn: string | null;
  asnOrg: string | null;
  source: string;     // which dataset produced this row
}

/**
 * Look up an IPv4 address against the local GeoIP D1.
 *
 * Returns null when:
 *   - GEOIP_DB binding is unset (separate D1 not provisioned)
 *   - The IP doesn't match any range in the table
 *   - Anything throws — never let a geo lookup take down a caller
 */
export async function lookupGeoMmdb(env: Env, ip: string): Promise<GeoIpLookupResult | null> {
  // Phase guard — graceful no-op if the operator hasn't created the
  // GEOIP_DB yet (separate D1 instance, separate binding).
  const db = env.GEOIP_DB;
  if (!db) return null;

  // Validate IPv4 shape; this module is IPv4-only for now (the
  // GeoLite2 City CSV ships IPv6 separately and we don't yet
  // ingest the v6 half).
  const ipInt = ipv4ToInt(ip);
  if (ipInt == null) return null;

  // Memory LRU first — fastest path for repeated lookups within
  // one Worker invocation.
  const memHit = memoryLru.get(ip);
  if (memHit !== undefined) return memHit;

  // KV second — cross-invocation cache.
  try {
    const cached = await env.CACHE?.get(`geoip:mmdb:${ip}`, 'json') as GeoIpLookupResult | null;
    if (cached !== null) {
      addToMemoryLru(ip, cached);
      return cached;
    }
  } catch {
    // KV read failure is non-fatal — fall through to D1.
  }

  // D1 lookup — single indexed seek against PRIMARY KEY(start_ip_int).
  let result: GeoIpLookupResult | null = null;
  try {
    const row = await db.prepare(`
      SELECT start_ip_int, end_ip_int, country_code, country_name,
             region, city, postal_code, lat, lng, asn, asn_org, source
      FROM geo_ip_ranges
      WHERE start_ip_int <= ?
      ORDER BY start_ip_int DESC
      LIMIT 1
    `).bind(ipInt).first<{
      start_ip_int: number;
      end_ip_int: number;
      country_code: string | null;
      country_name: string | null;
      region: string | null;
      city: string | null;
      postal_code: string | null;
      lat: number | null;
      lng: number | null;
      asn: string | null;
      asn_org: string | null;
      source: string;
    }>();

    // Range validation: the row with the largest start_ip_int <= our IP
    // is only a hit if its end_ip_int contains the IP too. Otherwise
    // we're between two adjacent ranges (gap), which means the source
    // dataset doesn't cover this address.
    if (row && row.end_ip_int >= ipInt) {
      result = {
        ip,
        countryCode: row.country_code,
        countryName: row.country_name,
        region: row.region,
        city: row.city,
        postalCode: row.postal_code,
        lat: row.lat,
        lng: row.lng,
        asn: row.asn,
        asnOrg: row.asn_org,
        source: row.source,
      };
    }
  } catch (err) {
    console.error('[geoip-mmdb] lookup error:', err instanceof Error ? err.message : String(err));
    return null;
  }

  // Cache both sides — null answers count too, otherwise we hammer
  // D1 every time a sinkhole IP gets retried.
  try {
    if (env.CACHE) {
      await env.CACHE.put(`geoip:mmdb:${ip}`, JSON.stringify(result), { expirationTtl: KV_TTL_S });
    }
  } catch {
    // KV write failure is non-fatal.
  }

  addToMemoryLru(ip, result);
  return result;
}

/**
 * Stats summary for the diagnostics endpoint and admin dashboard.
 * Exposes what the GeoIP DB looks like to the operator without
 * coupling diagnostics.ts to D1 directly.
 *
 * The fields with the `shadow_*` prefix surface the in-progress
 * refresh: when a Workflow is loading new data into
 * `geo_ip_ranges_new` (the atomic-swap shadow table), we can show
 * "X / 3.5M rows imported so far" instead of "configured but
 * 0 rows" while the operator waits ~30 min for the import to land.
 *
 * `recent_attempts` returns the last 5 refresh log rows so the
 * operator (or platform-diagnostics audit) can spot a stuck
 * 'running' row that's been there for hours, or a sequence of
 * `failed` rows that suggests MaxMind is rejecting the key.
 */
export async function getGeoMmdbStatus(env: Env): Promise<{
  configured: boolean;
  row_count: number | null;
  shadow_row_count: number | null;
  has_shadow_table: boolean;
  any_running_refresh: boolean;
  oldest_running_refresh_age_min: number | null;
  recent_attempts: Array<{
    id: string;
    status: string;
    source_version: string | null;
    rows_written: number;
    started_at: string;
    completed_at: string | null;
    duration_ms: number | null;
    error_message: string | null;
  }>;
  last_refresh_at: string | null;
  last_refresh_status: string | null;
  last_refresh_source: string | null;
  last_refresh_rows_written: number | null;
  last_refresh_duration_ms: number | null;
  last_refresh_error: string | null;
}> {
  const db = env.GEOIP_DB;
  if (!db) {
    return {
      configured: false,
      row_count: null,
      shadow_row_count: null,
      has_shadow_table: false,
      any_running_refresh: false,
      oldest_running_refresh_age_min: null,
      recent_attempts: [],
      last_refresh_at: null,
      last_refresh_status: null,
      last_refresh_source: null,
      last_refresh_rows_written: null,
      last_refresh_duration_ms: null,
      last_refresh_error: null,
    };
  }

  try {
    const [count, shadowCount, lastRefresh, recentAttempts, runningStats] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n FROM geo_ip_ranges`).first<{ n: number }>(),
      // Shadow table only exists while a Workflow is mid-import.
      // When the swap step runs, geo_ip_ranges_new is renamed to
      // geo_ip_ranges and this query throws. We catch and report
      // null for shadow_row_count when that happens.
      db
        .prepare(`SELECT COUNT(*) AS n FROM geo_ip_ranges_new`)
        .first<{ n: number }>()
        .catch(() => null),
      db.prepare(`
        SELECT completed_at, status, source, rows_written, duration_ms, error_message
        FROM geo_ip_refresh_log
        ORDER BY started_at DESC
        LIMIT 1
      `).first<{
        completed_at: string | null;
        status: string;
        source: string;
        rows_written: number;
        duration_ms: number | null;
        error_message: string | null;
      }>(),
      db.prepare(`
        SELECT id, status, source_version, rows_written, started_at,
               completed_at, duration_ms, error_message
        FROM geo_ip_refresh_log
        ORDER BY started_at DESC
        LIMIT 5
      `).all<{
        id: string;
        status: string;
        source_version: string | null;
        rows_written: number;
        started_at: string;
        completed_at: string | null;
        duration_ms: number | null;
        error_message: string | null;
      }>(),
      db.prepare(`
        SELECT COUNT(*) AS n,
               MIN(started_at) AS oldest
        FROM geo_ip_refresh_log
        WHERE status = 'running'
      `).first<{ n: number; oldest: string | null }>(),
    ]);

    const oldestRunningAge = runningStats?.oldest
      ? Math.floor((Date.now() - Date.parse(runningStats.oldest + 'Z')) / 60_000)
      : null;

    return {
      configured: true,
      row_count: count?.n ?? 0,
      shadow_row_count: shadowCount?.n ?? null,
      has_shadow_table: shadowCount !== null,
      any_running_refresh: (runningStats?.n ?? 0) > 0,
      oldest_running_refresh_age_min: oldestRunningAge,
      recent_attempts: recentAttempts.results ?? [],
      last_refresh_at: lastRefresh?.completed_at ?? null,
      last_refresh_status: lastRefresh?.status ?? null,
      last_refresh_source: lastRefresh?.source ?? null,
      last_refresh_rows_written: lastRefresh?.rows_written ?? null,
      last_refresh_duration_ms: lastRefresh?.duration_ms ?? null,
      last_refresh_error: lastRefresh?.error_message ?? null,
    };
  } catch (err) {
    return {
      configured: true,
      row_count: null,
      shadow_row_count: null,
      has_shadow_table: false,
      any_running_refresh: false,
      oldest_running_refresh_age_min: null,
      recent_attempts: [],
      last_refresh_at: null,
      last_refresh_status: 'error',
      last_refresh_source: null,
      last_refresh_rows_written: null,
      last_refresh_duration_ms: null,
      last_refresh_error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Internals ─────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

function addToMemoryLru(ip: string, result: GeoIpLookupResult | null): void {
  // Simple LRU via Map insertion order — delete + re-insert promotes.
  if (memoryLru.has(ip)) memoryLru.delete(ip);
  memoryLru.set(ip, result);
  while (memoryLru.size > MEMORY_LRU_MAX) {
    // Map iteration is insertion order — first key is oldest.
    const oldest = memoryLru.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    memoryLru.delete(oldest);
  }
}
