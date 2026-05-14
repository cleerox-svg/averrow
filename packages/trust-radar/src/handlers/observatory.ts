// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Observatory API Endpoints
// Powers the deck.gl + MapLibre GL threat map visualization
//
// Endpoints:
//   GET /api/observatory/nodes      — ScatterplotLayer hotspot clusters
//   GET /api/observatory/arcs       — ArcLayer attack corridors
//   GET /api/observatory/live       — 20 most recent threats (live feed)
//   GET /api/observatory/brand-arcs — Arcs targeting a specific brand
//   GET /api/observatory/stats      — Summary stats bar

import { json } from "../lib/cors";
import { getDbContext, getReadSession, attachBookmark } from '../lib/db';
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import type { Env } from "../types";

// ── Brand HQ coordinates — real locations ────────────────────────────────────
// Used as arc target positions. Format: [longitude, latitude]
// Keyed by canonical_domain AND by brand-name slug for flexible matching.
const BRAND_HQ: Record<string, [number, number]> = {
  // Fintech
  'paypal.com':        [-121.9687,  37.3790],
  'paypal':            [-121.9687,  37.3790],
  'stripe.com':        [-122.4194,  37.7749],
  'stripe':            [-122.4194,  37.7749],
  'visa.com':          [-122.1430,  37.4419],
  'visa':              [-122.1430,  37.4419],
  'mastercard.com':    [ -73.9840,  40.7549],
  'mastercard':        [ -73.9840,  40.7549],
  // Tech Giants
  'google.com':        [-122.0841,  37.4220],
  'google':            [-122.0841,  37.4220],
  'microsoft.com':     [-122.1391,  47.6423],
  'microsoft':         [-122.1391,  47.6423],
  'apple.com':         [-122.0090,  37.3346],
  'apple':             [-122.0090,  37.3346],
  'amazon.com':        [-122.3321,  47.6062],
  'amazon':            [-122.3321,  47.6062],
  'meta.com':          [-122.1477,  37.4847],
  'meta':              [-122.1477,  37.4847],
  'facebook.com':      [-122.1477,  37.4847],
  'facebook':          [-122.1477,  37.4847],
  'netflix.com':       [-121.9626,  37.2585],
  'netflix':           [-121.9626,  37.2585],
  'twitter.com':       [-122.4194,  37.7749],
  'twitter':           [-122.4194,  37.7749],
  // E-commerce
  'shopify.com':       [ -75.6972,  45.4215],
  'shopify':           [ -75.6972,  45.4215],
  'ebay.com':          [-122.0839,  37.3861],
  'ebay':              [-122.0839,  37.3861],
  'allegro.pl':        [  16.9252,  52.4064],
  'allegro':           [  16.9252,  52.4064],
  // Enterprise / Cloud
  'docusign.com':      [-122.0554,  37.3890],
  'docusign':          [-122.0554,  37.3890],
  'salesforce.com':    [-122.4194,  37.7749],
  'salesforce':        [-122.4194,  37.7749],
  'okta.com':          [-122.4194,  37.7749],
  'okta':              [-122.4194,  37.7749],
  'cloudflare.com':    [-122.4194,  37.7749],
  'cloudflare':        [-122.4194,  37.7749],
  'dropbox.com':       [-122.4194,  37.7749],
  'dropbox':           [-122.4194,  37.7749],
  'slack.com':         [-122.4194,  37.7749],
  'slack':             [-122.4194,  37.7749],
  'adobe.com':         [-117.2000,  32.9000],
  'adobe':             [-117.2000,  32.9000],
  // Social
  'instagram.com':     [-122.1477,  37.4847],
  'instagram':         [-122.1477,  37.4847],
  'linkedin.com':      [-122.0839,  37.3861],
  'linkedin':          [-122.0839,  37.3861],
  'tiktok.com':        [-122.0839,  37.3861],
  'tiktok':            [-122.0839,  37.3861],
  // Gaming
  'roblox.com':        [-122.0530,  37.5630],
  'roblox':            [-122.0530,  37.5630],
  'github.com':        [-122.3918,  37.7820],
  'github':            [-122.3918,  37.7820],
  // Retail
  'walmart.com':       [ -94.2088,  36.3729],
  'walmart':           [ -94.2088,  36.3729],
  'target.com':        [ -93.3420,  44.8600],
  'target':            [ -93.3420,  44.8600],
  // Financial
  'chase.com':         [ -73.9840,  40.7549],
  'chase':             [ -73.9840,  40.7549],
  'wellsfargo.com':    [-122.4194,  37.7749],
  'wellsfargo':        [-122.4194,  37.7749],
  'bankofamerica.com': [ -80.8431,  35.2271],
  'bankofamerica':     [ -80.8431,  35.2271],
  'citibank.com':      [ -73.9840,  40.7549],
  'citibank':          [ -73.9840,  40.7549],
  'hsbc.com':          [  -0.1000,  51.5000],
  'hsbc':              [  -0.1000,  51.5000],
  'barclays.com':      [  -0.1000,  51.5000],
  'barclays':          [  -0.1000,  51.5000],
  // Logistics
  'dhl.com':           [   8.7000,  50.1000],
  'dhl':               [   8.7000,  50.1000],
  'fedex.com':         [ -90.0000,  35.1000],
  'fedex':             [ -90.0000,  35.1000],
  'ups.com':           [ -84.3000,  33.8000],
  'ups':               [ -84.3000,  33.8000],
  // Telecom
  'att.com':           [ -96.7970,  32.7767],
  'att':               [ -96.7970,  32.7767],
  'verizon.com':       [ -74.0060,  40.7128],
  'verizon':           [ -74.0060,  40.7128],
  // Additional brands from threat data
  'files.fm':          [  24.1059,  56.9460],
  'zdnet.com':         [ -74.0060,  40.7128],
  'jd.com':            [ 116.4074,  39.9042],
  'lowes.com':         [ -80.8504,  35.5276],
  '1e100.net':         [-122.0841,  37.4220],  // Google infra → Mountain View
  'httpwg.org':        [-122.4194,  37.7749],  // W3C/IETF working group → SF
};

// Continent-based fallback coords [lng, lat] — ensures arcs always draw
const CONTINENT_DEFAULTS: Record<string, [number, number]> = {
  'US': [-122.4194,  37.7749],  // SF
  'GB': [  -0.1278,  51.5074],  // London
  'DE': [  13.4050,  52.5200],  // Berlin
  'FR': [   2.3522,  48.8566],  // Paris
  'JP': [ 139.6503,  35.6762],  // Tokyo
  'CN': [ 116.4074,  39.9042],  // Beijing
  'AU': [ 151.2093, -33.8688],  // Sydney
  'CA': [ -79.3832,  43.6532],  // Toronto
  'IN': [  77.2090,  28.6139],  // New Delhi
  'BR': [ -46.6333, -23.5505],  // São Paulo
  'SG': [ 103.8198,   1.3521],  // Singapore
  'NL': [   4.9041,  52.3676],  // Amsterdam
};

function getContinentFallback(country?: string | null): [number, number] {
  if (!country) return [-122.4194, 37.7749]; // default SF
  return CONTINENT_DEFAULTS[country] ?? [-122.4194, 37.7749];
}

function getBrandCoords(brandName: string | null, canonicalDomain?: string | null, originCountry?: string | null): [number, number] {
  // Try canonical domain first (most precise)
  if (canonicalDomain) {
    const clean = canonicalDomain.replace(/^www\./, "").toLowerCase();
    if (BRAND_HQ[clean]) return BRAND_HQ[clean];
    // Partial match on domain
    for (const [k, coords] of Object.entries(BRAND_HQ)) {
      if (!k.includes(".")) continue;
      if (clean === k || clean.endsWith("." + k) || k.endsWith("." + clean.split(".")[0])) {
        return coords;
      }
    }
  }
  if (!brandName) return getContinentFallback(originCountry);
  // Try brand name slug
  const key = brandName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (BRAND_HQ[key]) return BRAND_HQ[key];
  // Partial match on brand name
  for (const [k, coords] of Object.entries(BRAND_HQ)) {
    if (k.includes(".")) continue;
    if (key.includes(k) || k.includes(key)) return coords;
  }
  // Fallback — continent default, NOT null
  return getContinentFallback(originCountry);
}

function periodToInterval(period: string): string {
  if (period === "24h") return "-1 days";
  if (period === "30d") return "-30 days";
  if (period === "90d") return "-90 days";
  if (period === "all") return "-3650 days";
  return "-7 days"; // default 7d
}

// ── Cube window helpers ───────────────────────────────────────────────────────
// Used by handlers that query threat_cube_geo. The cube's hour_bucket column is
// a string-compared key in 'YYYY-MM-DD HH:00:00' form, so window boundaries
// must be snapped to the top of the hour or else an entire bucket's rows are
// silently excluded at the edge.
//
// The snappedWindowStart helper is duplicated from parity-checker.ts by design
// (Phase 5 design principle #4). Consolidation into a shared lib module is
// deferred to a future cleanup phase — parity-checker and Navigator are both
// in a stability freeze and cannot be touched in this PR.

/** Period → hours, matching periodToInterval() semantics. */
function periodToHours(period: string): number {
  if (period === "24h") return 24;
  if (period === "30d") return 30 * 24;
  if (period === "90d") return 90 * 24;
  if (period === "all") return 3650 * 24;
  return 7 * 24; // default 7d
}

/**
 * Compute the cube window-start hour bucket for a given period, snapped to
 * the top of the current UTC hour. Returns 'YYYY-MM-DD HH:00:00'.
 *
 * Snapping up to the hour widens the query window by up to 59 minutes vs the
 * raw datetime('now', ?) predicate, which is within the parity-checker's
 * observed drift envelope (<0.02%).
 */
function snappedWindowStart(period: string): string {
  const hours = periodToHours(period);
  const nowSnapped = new Date();
  nowSnapped.setUTCMinutes(0, 0, 0);
  nowSnapped.setUTCMilliseconds(0);
  const d = new Date(nowSnapped.getTime() - hours * 60 * 60 * 1000);
  // 'YYYY-MM-DDTHH:00:00.000Z' → 'YYYY-MM-DD HH:00:00'
  return d.toISOString().replace("T", " ").slice(0, 19);
}

interface SourceFilter {
  sql: string;
  params: unknown[];
}

function buildSourceFilter(sourceFeed: string | null, alias?: string): SourceFilter {
  if (!sourceFeed) return { sql: "", params: [] };
  const col = alias ? `${alias}.source_feed` : "source_feed";
  if (sourceFeed === "feeds") return { sql: ` AND ${col} != 'spam_trap'`, params: [] };
  if (sourceFeed === "spam_trap") return { sql: ` AND ${col} = 'spam_trap'`, params: [] };
  return { sql: ` AND ${col} = ?`, params: [sourceFeed] };
}

// ── GET /api/observatory/nodes ─────────────────────────────────────────────────
// Returns threat hotspot clusters for ScatterplotLayer.
//
// Phase 5: now reads from threat_cube_geo. The cube is stored at 0.01° grid
// resolution; this handler aggregates back up to the original 0.1° grid at
// read time by rounding lat_bucket / lng_bucket. Response shape is unchanged.
//
// top_severity and top_threat_type use MAX() over the cube's PK columns —
// deterministic (alphabetical) vs the pre-cube "arbitrary row" SQLite
// behaviour. country_code may return the 'XX' sentinel that cube-builder
// writes for NULL country rows.
export async function handleObservatoryNodes(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "7d";
  const windowStart = snappedWindowStart(period);
  const sourceFilter = buildSourceFilter(url.searchParams.get("source_feed"));

  try {
    // KV cache: nodes query aggregates threat_cube_geo — cache for 15
    // minutes. Bumped from 5min as part of D1-budget cleanup; the cube
    // is rebuilt every 10 min by Navigator so 15min staleness is at
    // worst one tick old, and Navigator-driven cache warms now miss
    // ~3x less often.
    const cacheKey = `observatory_nodes:${period}:${url.searchParams.get("source_feed") ?? "all"}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      // Cache hit — record zero D1 reads so attribution still shows
      // request volume.
      recordD1Reads(env, "observatory_nodes", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();
    const rows = await session.prepare(`
      SELECT
        ROUND(lat_bucket, 1) AS lat,
        ROUND(lng_bucket, 1) AS lng,
        SUM(threat_count) AS threat_count,
        MAX(severity) AS top_severity,
        SUM(CASE WHEN severity = 'critical' THEN threat_count ELSE 0 END) AS critical,
        SUM(CASE WHEN severity = 'high'     THEN threat_count ELSE 0 END) AS high,
        SUM(CASE WHEN severity = 'medium'   THEN threat_count ELSE 0 END) AS medium,
        SUM(CASE WHEN severity = 'low'      THEN threat_count ELSE 0 END) AS low,
        MAX(country_code) AS country_code,
        MAX(threat_type) AS top_threat_type
      FROM threat_cube_geo
      WHERE hour_bucket >= ?${sourceFilter.sql}
      GROUP BY ROUND(lat_bucket, 1), ROUND(lng_bucket, 1)
      ORDER BY threat_count DESC
      LIMIT 200
    `).bind(windowStart, ...sourceFilter.params).all<{
      lat: number; lng: number; threat_count: number; top_severity: string | null;
      critical: number; high: number; medium: number; low: number;
      country_code: string | null; top_threat_type: string | null;
    }>();
    addToTally(tally, rows.meta);

    const data = { success: true, data: rows.results ?? [] };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 900 });
    recordD1Reads(env, "observatory_nodes", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ── GET /api/observatory/arcs ──────────────────────────────────────────────────
// Returns attack corridors for ArcLayer
//
// PR-Z: reads from threat_cube_arcs instead of scanning the raw threats
// table joined to brands. Pre-PR-Z this was the single largest D1 spender
// for trust-radar's surfaces (~14.8M reads/24h, scanning ~43K of 7-day
// partial-index rows per uncached call). The cube reduces it to a small
// hour-bucket SELECT joined to brands by id (~hundreds of rows max).
//
// The cube's grain — (hour_bucket, country_code, target_brand_id,
// threat_type, severity, source_feed) — exactly matches what the previous
// query produced after its GROUP BY (country, brand, type), so there's no
// visual fidelity loss. source_lat/source_lng are the country-bucket
// centroid (better than the previous arbitrary-pick).
export async function handleObservatoryArcs(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "7d";
  const windowStart = snappedWindowStart(period);
  const sourceFilter = buildSourceFilter(url.searchParams.get("source_feed"), "c");

  try {
    // KV cache: 30 min TTL (was 15). Globe doesn't visibly change in
    // 15 min and the cube refresh cadence is also 5 min, so a longer
    // TTL halves the re-compute frequency with no observable lag.
    const cacheKey = `observatory_arcs:${period}:${url.searchParams.get("source_feed") ?? "all"}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "observatory_arcs", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();
    // LIMIT 2500 (was 10K). The globe can't legibly render more than ~2K
    // arcs anyway — overdraw collapses individual arcs into a blob.
    const rows = await session.prepare(`
      SELECT
        ROUND(AVG(c.source_lat), 1) AS source_lat,
        ROUND(AVG(c.source_lng), 1) AS source_lng,
        c.threat_type,
        MAX(c.severity)             AS severity,
        c.country_code              AS source_country,
        b.name                      AS target_brand,
        b.canonical_domain          AS target_domain,
        b.sector                    AS target_sector,
        SUM(c.threat_count)         AS volume,
        MIN(c.first_seen)           AS first_seen,
        MAX(c.last_seen)            AS last_seen
      FROM threat_cube_arcs c
      JOIN brands b ON b.id = c.target_brand_id
      WHERE c.hour_bucket >= ?${sourceFilter.sql}
      GROUP BY c.country_code, c.target_brand_id, c.threat_type, b.name, b.canonical_domain, b.sector
      ORDER BY volume DESC
      LIMIT 2500
    `).bind(windowStart, ...sourceFilter.params).all<{
      source_lat: number | null; source_lng: number | null; threat_type: string;
      severity: string | null; source_country: string | null;
      target_brand: string | null; target_domain: string | null;
      target_sector: string | null; volume: number;
      first_seen: string; last_seen: string;
    }>();
    addToTally(tally, rows.meta);

    const resultRows = rows.results ?? [];

    const arcs = resultRows
      .map(row => {
        const targetCoords = getBrandCoords(row.target_brand, row.target_domain, row.source_country);
        const jitter: [number, number] = [
          targetCoords[0] + (Math.random() - 0.5) * 0.5,
          targetCoords[1] + (Math.random() - 0.5) * 0.5,
        ];
        return {
          sourcePosition: [row.source_lng ?? 0, row.source_lat ?? 0] as [number, number],
          targetPosition: jitter,
          threat_type: row.threat_type,
          severity: row.severity ?? "low",
          source_region: row.source_country ?? "Unknown",
          target_brand: row.target_brand ?? "Unknown",
          brand_name: row.target_brand ?? null,
          volume: row.volume,
          first_seen: row.first_seen,
          last_seen: row.last_seen,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    const data = { success: true, data: arcs };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 1800 });
    recordD1Reads(env, "observatory_arcs", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ── GET /api/observatory/live ──────────────────────────────────────────────────
// Returns 20 most recent active threats with full geo data
export async function handleObservatoryLive(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  const url = new URL(request.url);
  const sourceFilter = buildSourceFilter(url.searchParams.get("source_feed"), "t");
  const limit = Math.min(50, parseInt(url.searchParams.get("limit") ?? "20", 10));

  try {
    // KV cache: live feed query. PR-Z bumped 2 → 5 min so the TTL aligns
    // with Navigator's pre-warm cadence — at 2 min the pre-warm half the
    // time hit a stale entry that had just expired, paying the scan cost
    // again. 5 min keeps the "live" ticker visibly fresh while letting
    // pre-warm always serve.
    const cacheKey = `observatory_live:${url.searchParams.get("source_feed") ?? "all"}:${limit}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "observatory_live", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();
    const rows = await session.prepare(`
      SELECT
        t.id,
        t.malicious_domain,
        t.malicious_url,
        t.ioc_value,
        t.threat_type,
        t.severity,
        t.lat,
        t.lng,
        t.country_code,
        t.created_at,
        b.name AS target_brand
      FROM threats t
      LEFT JOIN brands b ON b.id = t.target_brand_id
      WHERE t.lat IS NOT NULL AND t.lng IS NOT NULL
        AND t.status = 'active'${sourceFilter.sql}
      ORDER BY t.created_at DESC
      LIMIT ?
    `).bind(...sourceFilter.params, limit).all<{
      id: string; malicious_domain: string | null; malicious_url: string | null;
      ioc_value: string | null; threat_type: string; severity: string | null;
      lat: number; lng: number; country_code: string | null;
      created_at: string; target_brand: string | null;
    }>();
    addToTally(tally, rows.meta);

    const data = { success: true, data: rows.results ?? [] };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
    recordD1Reads(env, "observatory_live", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ── GET /api/observatory/brand-arcs ───────────────────────────────────────────
// Returns arcs targeting a specific brand.
//
// PR-Z: reads from threat_cube_arcs. Original query bucketed at 0.1°
// lat/lng; the cube grain is country-level. For a brand panel (LIMIT
// 40 corridors max) the visualization is unchanged — at country
// resolution a brand typically maps to 10-30 distinct attacking
// countries, well below the 40-row cap. The 0.1° bucketing of the
// previous query was effectively the same since attacking IPs cluster
// inside national geographies.
export async function handleObservatoryBrandArcs(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  const url = new URL(request.url);
  const brandId = url.searchParams.get("brand_id");
  const period = url.searchParams.get("period") ?? "7d";
  const windowStart = snappedWindowStart(period);

  if (!brandId) {
    return attachBookmark(json({ success: false, error: "brand_id required" }, 400, origin), session);
  }

  try {
    // Get brand name + domain for coordinate lookup
    const brand = await session.prepare(
      "SELECT id, name, canonical_domain FROM brands WHERE id = ? LIMIT 1"
    ).bind(brandId).first<{ id: string; name: string; canonical_domain: string | null }>();

    const targetCoords = getBrandCoords(brand?.name ?? null, brand?.canonical_domain) ?? [-74.0, 40.7];

    const rows = await session.prepare(`
      SELECT
        ROUND(AVG(source_lat), 1) AS source_lat,
        ROUND(AVG(source_lng), 1) AS source_lng,
        threat_type,
        MAX(severity)             AS severity,
        country_code              AS source_country,
        SUM(threat_count)         AS volume
      FROM threat_cube_arcs
      WHERE target_brand_id = ?
        AND hour_bucket >= ?
      GROUP BY country_code, threat_type
      ORDER BY volume DESC
      LIMIT 40
    `).bind(brandId, windowStart).all<{
      source_lat: number | null; source_lng: number | null; threat_type: string;
      severity: string | null; source_country: string | null; volume: number;
    }>();

    const arcs = (rows.results ?? []).map(row => ({
      sourcePosition: [row.source_lng ?? 0, row.source_lat ?? 0] as [number, number],
      targetPosition: [
        targetCoords[0] + (Math.random() - 0.5) * 1,
        targetCoords[1] + (Math.random() - 0.5) * 1,
      ] as [number, number],
      threat_type: row.threat_type,
      severity: row.severity ?? "low",
      source_region: row.source_country ?? "Unknown",
      volume: row.volume,
      country_code: row.source_country,
    }));

    return attachBookmark(json({
      success: true,
      data: arcs,
      brand: brand ? { id: brand.id, name: brand.name } : null,
    }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ── GET /api/observatory/stats ─────────────────────────────────────────────────
// Returns summary stats for the stats bar.
//
// Phase 5 partial swap:
//   - threats_mapped → threat_cube_geo (SUM(threat_count)). Note: the cube
//     only stores rows with lat/lng, so this value is strictly the count
//     of geolocated active threats — active threats with NULL lat/lng do
//     not contribute. When GeoIP coverage degrades (empty MMDB, ip-api
//     misses, etc.) this number drifts toward zero even though ingest is
//     healthy. Pair with `threats_total` to surface coverage as a ratio.
//   - threats_total → threat_cube_status (SUM(threat_count)). Every
//     ingested threat lands here regardless of geo. `geo_coverage_pct`
//     is mapped/total — operators see a coverage drop immediately
//     instead of a slow-bleeding tile.
//   - countries       → threat_cube_geo (COUNT(DISTINCT country_code))
//   - active_campaigns → unchanged (queries campaigns table, not threats)
//   - brands_monitored → stays on raw threats. The cube has no
//     target_brand_id dimension, so this query cannot be served from it.
//     Adding a brand-keyed cube is a future-phase scope decision.
export async function handleObservatoryStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "7d";
  const interval = periodToInterval(period);
  const windowStart = snappedWindowStart(period);
  const sourceFeed = url.searchParams.get("source_feed");
  const sf = buildSourceFilter(sourceFeed);

  try {
    // KV cache: observatory stats only change when feeds run — cache for 2 minutes.
    // Cache key is intentionally unchanged from the raw-sourced implementation;
    // existing cached entries will serve pre-swap values until TTL expires
    // (up to 2 minutes of stale raw-sourced values post-deploy).
    const cacheKey = `observatory_stats:${period}:${sourceFeed ?? "all"}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "observatory_stats", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();
    const [threats, threatsTotal, countries, campaigns, brands] = await Promise.all([
      session.prepare(
        `SELECT COALESCE(SUM(threat_count), 0) AS n FROM threat_cube_geo WHERE hour_bucket >= ?${sf.sql}`
      ).bind(windowStart, ...sf.params).first<{ n: number }>(),
      // Total threats over the same window — sourced from threat_cube_status
      // which has no lat/lng requirement. The ratio of (mapped / total)
      // surfaces geo-enrichment coverage on the home tile and lets the
      // operator notice GeoIP regressions before the mapped count drifts
      // toward zero unexplained.
      session.prepare(
        `SELECT COALESCE(SUM(threat_count), 0) AS n FROM threat_cube_status WHERE hour_bucket >= ?`
      ).bind(windowStart).first<{ n: number }>(),
      session.prepare(
        `SELECT COUNT(DISTINCT country_code) AS n FROM threat_cube_geo WHERE hour_bucket >= ?${sf.sql}`
      ).bind(windowStart, ...sf.params).first<{ n: number }>(),
      session.prepare(
        `SELECT COUNT(*) AS n FROM campaigns WHERE status = 'active'`
      ).first<{ n: number }>(),
      session.prepare(
        `SELECT COUNT(DISTINCT target_brand_id) AS n FROM threat_cube_brand WHERE hour_bucket >= ?${sf.sql}`
      ).bind(windowStart, ...sf.params).first<{ n: number }>(),
    ]);
    // .first() doesn't expose meta — count queries but not rows_read.
    // All five reads are now cube-served (geo cube × 2, status cube,
    // campaigns table, brand cube). DISTINCT target_brand_id moved from
    // threats → threat_cube_brand to kill the last full-table-scan path.
    tally.queries += 5;

    const mapped = threats?.n ?? 0;
    const total = threatsTotal?.n ?? 0;
    const coveragePct = total > 0 ? Math.round((mapped / total) * 100) : null;

    const data = {
      success: true,
      data: {
        threats_mapped: mapped,
        threats_total: total,
        geo_coverage_pct: coveragePct,
        countries: countries?.n ?? 0,
        active_campaigns: campaigns?.n ?? 0,
        brands_monitored: brands?.n ?? 0,
        period,
      },
    };

    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 900 });
    recordD1Reads(env, "observatory_stats", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ── GET /api/observatory/operations ─────────────────────────────────────────
// Lightweight unauthenticated operations list for the Observatory sidebar
export async function handleObservatoryOperations(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const limit = Math.min(10, parseInt(url.searchParams.get("limit") ?? "5", 10));

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      conditions.push("ic.status = ?");
      params.push(status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    // KV cache: lightweight query but fires on every Observatory mount — cache for 15 minutes.
    const cacheKey = `observatory_operations:${status ?? "all"}:${limit}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "observatory_operations", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();
    const rows = await session.prepare(`
      SELECT ic.id, ic.cluster_name, ic.threat_count,
             ic.status, ic.confidence_score, ic.agent_notes,
             ic.countries
      FROM infrastructure_clusters ic ${where}
      ORDER BY
        CASE ic.status
          WHEN 'accelerating' THEN 0
          WHEN 'pivot' THEN 1
          WHEN 'active' THEN 2
          ELSE 3
        END,
        ic.threat_count DESC
      LIMIT ?
    `).bind(...params).all();
    addToTally(tally, rows.meta);

    const data = { success: true, data: rows.results ?? [] };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 900 });
    recordD1Reads(env, "observatory_operations", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}
