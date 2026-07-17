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
import { cachedCount } from './cached-count';

// KV cache TTL — geographic data for a given IP changes on the order of
// weeks/months. 24h is a good balance of freshness and cache hit rate.
const KV_TTL_S = 24 * 60 * 60;

// Sentinel stored when D1 returns no row for an IP. Without this,
// `JSON.stringify(null)` round-trips through `KV.get(..., 'json')` as
// `null` — indistinguishable from a cache miss — so every subsequent
// lookup of an unresolvable IP falls through to D1. The result on
// 2026-05-12 was ~22M geoip-db reads in 6h, almost all of which were
// retries of IPs GeoLite2 doesn't cover (sinkholes, CDN, anycast).
// Reading as text + checking the sentinel lets us cache misses
// effectively.
const NULL_SENTINEL = "GEOIP_MISS";

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
  //
  // Read as TEXT (not json) so we can distinguish three states:
  //   raw === null              → cache miss, fall through to D1
  //   raw === NULL_SENTINEL     → cached miss (GeoLite2 doesn't cover this IP)
  //   raw === <stringified hit> → cached hit, parse + return
  //
  // Reading as 'json' would collapse the first two into the same
  // `null` value — the bug fixed here on 2026-05-12.
  try {
    const raw = await env.CACHE?.get(`geoip:mmdb:${ip}`, 'text');
    if (raw === NULL_SENTINEL) {
      addToMemoryLru(ip, null);
      return null;
    }
    if (raw !== null && raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as GeoIpLookupResult;
        addToMemoryLru(ip, parsed);
        return parsed;
      } catch {
        // Malformed cache entry — fall through to D1 and overwrite.
      }
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

  // Cache both sides — null answers stored as NULL_SENTINEL so the
  // read path can distinguish "cached miss" from "cache miss".
  // Without this, sinkhole / CDN / anycast IPs that GeoLite2 doesn't
  // cover would re-hit D1 every cartographer cycle forever.
  try {
    if (env.CACHE) {
      const payload = result === null ? NULL_SENTINEL : JSON.stringify(result);
      await env.CACHE.put(`geoip:mmdb:${ip}`, payload, { expirationTtl: KV_TTL_S });
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
    // PR-AM: COUNT(*) over geo_ip_ranges scans the full 5M-row reference
    // table. Pre-fix it ran 27 times/day from admin diagnostics surfaces,
    // burning ~100M D1 reads/day (#1 query on the platform's billing).
    // Wrapped with a 1-day TTL since the row count only changes on the
    // weekly GeoIP refresh — operator sees fresh values within a day of
    // each refresh, plenty for a status panel.
    const [count, lastRefresh, recentAttempts, runningStats] = await Promise.all([
      cachedCount(env, 'count.geo_ip_ranges.total', 24 * 60 * 60, async () => {
        const r = await db.prepare(`SELECT COUNT(*) AS n FROM geo_ip_ranges`).first<{ n: number }>();
        return r?.n ?? 0;
      }).then((n) => ({ n })),
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
      // Shadow-import progress WITHOUT scanning the shadow table.
      //
      // Previously this ran `COUNT(*) FROM geo_ip_ranges_new`. During a
      // refresh that table grows to 3.5M+ rows and is actively written,
      // so the full scan saturated D1 / timed out the worker. Production
      // 2026-05-16 19:45 UTC: an admin clicked the GeoIP card mid-refresh
      // and the worker died COUNTing the actively-written shadow table,
      // returning a plain-text 500 the UI couldn't parse — the detail
      // drill-down hung on "Loading detail…" forever. The 30s KV cache
      // we added then only bounded the *frequency* of the killer scan;
      // the cold-cache call still died, so the panel failed ~every 30s
      // for the whole ~50-min import.
      //
      // The import already checkpoints its progress into
      // geo_ip_refresh_log.last_committed_row (geoipRefresh.ts onProgress).
      // That's a single tiny-table row read — no shadow-table scan — and
      // gives the same "X / 3.5M rows imported so far" gauge. The shadow
      // table exists exactly while a refresh is 'running', so we derive
      // both presence and progress from the running log row.
      db.prepare(`
        SELECT COUNT(*) AS n,
               MIN(started_at) AS oldest,
               MAX(last_committed_row) AS progress
        FROM geo_ip_refresh_log
        WHERE status = 'running'
      `).first<{ n: number; oldest: string | null; progress: number | null }>(),
    ]);

    const oldestRunningAge = runningStats?.oldest
      ? Math.floor((Date.now() - Date.parse(runningStats.oldest + 'Z')) / 60_000)
      : null;
    const refreshRunning = (runningStats?.n ?? 0) > 0;
    // shadow_row_count is the in-flight import progress; only meaningful
    // while a refresh is running. null otherwise (no shadow table).
    const shadowProgress = refreshRunning ? (runningStats?.progress ?? null) : null;

    return {
      configured: true,
      row_count: count?.n ?? 0,
      shadow_row_count: shadowProgress,
      has_shadow_table: refreshRunning,
      any_running_refresh: refreshRunning,
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
