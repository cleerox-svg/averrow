// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Observatory API Endpoints
// Powers the deck.gl + MapLibre GL threat map visualization
//
// Endpoints:
//   GET /api/observatory/nodes      — ScatterplotLayer hotspot clusters
//   GET /api/observatory/arcs       — ArcLayer attack corridors
//   GET /api/observatory/live       — most recent active threats (live feed)
//   GET /api/observatory/brand-arcs — Arcs targeting a specific brand
//   GET /api/observatory/stats      — Summary stats bar
//   GET /api/observatory/heatmap    — Heatmap points (geo cube buckets)
//   GET /api/observatory/operations — Active NEXUS clusters
//
// Auth: every route is wrapped in requireStaff at the route layer
// (routes/dashboard.ts). Handlers here do no auth of their own — the
// responses carry targeted brand names and malicious URLs, so never
// register one of these on a public route. Navigator calls them
// directly for KV pre-warm; the `observatory_*` cache keys are
// therefore staff-audience only.
//
// Query params are canonicalised BEFORE any cache key is built:
//   period      — allow-list 24h | 7d | 30d | 90d; anything else → 7d
//   source_feed — absent / '' / 'all' → one `all` key segment, no filter
//   limit       — integer, clamped per endpoint; NaN / missing → default
// so a garbage param can never mint a fresh cache key or an unbounded scan.

import { json } from "../lib/cors";
import { getDbContext, getReadSession, attachBookmark } from '../lib/db';
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import { cachedValue } from "../lib/cached-value";
import { readRefreshableCache, writeRefreshableCache } from "../lib/cache-refresh";
import { getCountryCentroid } from "../lib/country-centroids";
import type { Env } from "../types";

/** TTL for the stats tile's distinct-brands count over the brand cube. */
export const OBSERVATORY_BRANDS_DISTINCT_TTL_S = 3600;

// ── Brand HQ coordinates — real locations ────────────────────────────────────
// Last-resort arc target (after brands.hq_lat/hq_lng and hq_country). Format:
// [longitude, latitude]. Keyed by canonical_domain AND by brand-name slug;
// matched EXACTLY — the former substring match sent e.g. "Targetry" to
// Target's HQ and "Apple Bank" to Cupertino.
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

// ── Param parsing (shared by every endpoint) ─────────────────────────────────

export const OBSERVATORY_PERIODS = ["24h", "7d", "30d", "90d"] as const;
export type ObservatoryPeriod = (typeof OBSERVATORY_PERIODS)[number];

const PERIOD_HOURS: Record<ObservatoryPeriod, number> = {
  "24h": 24,
  "7d": 7 * 24,
  "30d": 30 * 24,
  "90d": 90 * 24,
};

/**
 * Canonical period. Unknown / missing values collapse to `7d` so a garbage
 * `?period=` neither mints its own KV key nor widens the window (the former
 * `all` → 10-year window is gone; nothing in the client sends it).
 */
export function parseObservatoryPeriod(raw: string | null): ObservatoryPeriod {
  return (OBSERVATORY_PERIODS as readonly string[]).includes(raw ?? "")
    ? (raw as ObservatoryPeriod)
    : "7d";
}

/**
 * Integer limit clamped to [1, max]. Missing, empty or non-numeric → `def`.
 * Bare `Math.min(max, parseInt(x))` let `?limit=-1` through as `LIMIT -1`
 * (unbounded in SQLite) and `?limit=abc` through as `LIMIT NaN`.
 */
export function parseObservatoryLimit(raw: string | null, def: number, max: number): number {
  if (raw === null || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(Math.floor(n), max));
}

/** Period → hours, for the allow-listed periods only. */
function periodToHours(period: ObservatoryPeriod): number {
  return PERIOD_HOURS[period];
}

// ── Cube window helpers ───────────────────────────────────────────────────────
// The cubes' hour_bucket column is a string-compared key in
// 'YYYY-MM-DD HH:00:00' form, so window boundaries must be snapped to the top
// of the hour or else an entire bucket's rows are silently excluded at the
// edge. The raw-threats fallbacks bind the SAME snapped start so the cube and
// fallback paths cover an identical window.

/**
 * Cube window-start hour bucket for a period, snapped to the top of the
 * current UTC hour. Returns 'YYYY-MM-DD HH:00:00'.
 */
export function snappedWindowStart(period: ObservatoryPeriod, now: Date = new Date()): string {
  const hours = periodToHours(period);
  const nowSnapped = new Date(now.getTime());
  nowSnapped.setUTCMinutes(0, 0, 0);
  const d = new Date(nowSnapped.getTime() - hours * 60 * 60 * 1000);
  // 'YYYY-MM-DDTHH:00:00.000Z' → 'YYYY-MM-DD HH:00:00'
  return d.toISOString().replace("T", " ").slice(0, 19);
}

interface SourceFilter {
  sql: string;
  params: unknown[];
}

/**
 * Canonical `source_feed` filter value: `null` means "every source".
 *
 * The ops client sends `source_feed=` (EMPTY string) for its "All Sources"
 * tab (averrow-ops `hooks/useObservatory.ts` — `source === 'all' ? '' :
 * source`), while Navigator's pre-warm and the MCP probe omit the param.
 * Building the KV key from the raw value split those into `…:` and
 * `…:all`, so every warm landed on a key the UI never read. Empty, absent
 * and a literal `all` therefore all collapse to `null` here, and both the
 * SQL filter and the cache-key segment derive from this one value.
 *
 * (`all` is included because it is the UI's own id for "every source"; left
 * raw it filtered `source_feed = 'all'` — zero rows — and cached that empty
 * payload under the very key the unfiltered landing page reads.)
 */
export function normalizeSourceFeed(raw: string | null): string | null {
  if (raw === null || raw === "" || raw === "all") return null;
  return raw;
}

/** KV-key segment for a source filter — `all` when unfiltered. */
export function sourceFeedCacheSegment(raw: string | null): string {
  return normalizeSourceFeed(raw) ?? "all";
}

function buildSourceFilter(rawSourceFeed: string | null, alias?: string): SourceFilter {
  const sourceFeed = normalizeSourceFeed(rawSourceFeed);
  if (!sourceFeed) return { sql: "", params: [] };
  const col = alias ? `${alias}.source_feed` : "source_feed";
  if (sourceFeed === "feeds") return { sql: ` AND ${col} != 'spam_trap'`, params: [] };
  if (sourceFeed === "spam_trap") return { sql: ` AND ${col} = 'spam_trap'`, params: [] };
  return { sql: ` AND ${col} = ?`, params: [sourceFeed] };
}

// ── Severity ranking ──────────────────────────────────────────────────────────
// MAX(severity) picked alphabetically: 'unknown' > 'medium' > 'low' > 'high'
// > 'critical', so a cell holding one critical and one medium threat was
// labelled medium. Rank from the per-severity sums instead.

export const SEVERITY_RANK = ["critical", "high", "medium", "low"] as const;
export type RankedSeverity = (typeof SEVERITY_RANK)[number] | "unknown";

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** Highest severity with a non-zero count; `unknown` when none of the four. */
export function topSeverity(counts: SeverityCounts): RankedSeverity {
  for (const s of SEVERITY_RANK) if ((counts[s] ?? 0) > 0) return s;
  return "unknown";
}

/** Per-severity SUM columns over a count expression (case-insensitive). */
function severitySumsSql(severityCol: string, countExpr: string): string {
  return SEVERITY_RANK.map(
    (s) => `SUM(CASE WHEN LOWER(${severityCol}) = '${s}' THEN ${countExpr} ELSE 0 END) AS ${s}`,
  ).join(",\n        ");
}

// ── Arc target resolution ─────────────────────────────────────────────────────

export type TargetPrecision = "hq" | "country";

export interface BrandTargetInput {
  name: string | null;
  canonical_domain: string | null;
  hq_lat: number | null;
  hq_lng: number | null;
  hq_country: string | null;
}

export interface ResolvedTarget {
  position: [number, number];
  precision: TargetPrecision;
}

function isUsableCoord(lat: number | null, lng: number | null): boolean {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false; // null-island sentinel
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/** Exact BRAND_HQ lookup: cleaned canonical domain, then name slug. */
function exactDictionaryHq(name: string | null, canonicalDomain: string | null): [number, number] | null {
  if (canonicalDomain) {
    const clean = canonicalDomain.trim().replace(/^www\./i, "").replace(/\.$/, "").toLowerCase();
    const hit = BRAND_HQ[clean];
    if (hit) return hit;
  }
  if (name) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const hit = slug ? BRAND_HQ[slug] : undefined;
    if (hit) return hit;
  }
  return null;
}

/**
 * Where an arc targeting this brand lands. Resolution order:
 *   1. EXACT BRAND_HQ dictionary match            → precision 'hq'
 *   2. brands.hq_lat / hq_lng                     → precision 'hq'
 *   3. centroid of brands.hq_country              → precision 'country'
 *   4. null — the caller drops the arc and counts it
 * The curated dictionary wins over hq_lat/hq_lng because the enricher
 * derives those from where the brand's domain resolves, which is often a
 * CDN edge rather than the headquarters.
 * Never the attacker's country, never random jitter: the former fallback
 * drew arcs from an attacker to the attacker's own continent.
 */
export function resolveBrandTarget(brand: BrandTargetInput): ResolvedTarget | null {
  const dict = exactDictionaryHq(brand.name, brand.canonical_domain);
  if (dict) return { position: [dict[0], dict[1]], precision: "hq" };
  if (isUsableCoord(brand.hq_lat, brand.hq_lng)) {
    return { position: [brand.hq_lng as number, brand.hq_lat as number], precision: "hq" };
  }
  const centroid = getCountryCentroid(brand.hq_country);
  if (centroid) return { position: [centroid[0], centroid[1]], precision: "country" };
  return null;
}

// ── Response caching ──────────────────────────────────────────────────────────

/** Response TTLs (seconds). Navigator refresh-warms ahead of expiry. */
export const OBSERVATORY_TTL_S = {
  nodes: 900,
  arcs: 7200,
  arcsFallback: 300,
  live: 60,
  brandArcs: 900,
  stats: 900,
  heatmap: 900,
  operations: 900,
} as const;

// ── GET /api/observatory/nodes ─────────────────────────────────────────────────
// Returns threat hotspot clusters for ScatterplotLayer.
//
// Reads threat_cube_geo (0.01° grid) and aggregates back up to a 0.1° grid at
// read time. Per cell:
//   - top_severity    — highest severity with a non-zero count (ranked, not
//                       alphabetical MAX)
//   - country_code    — the country with the most threats in the cell; the
//                       'XX' sentinel (NULL country in threats) is never
//                       picked, and a cell that is ALL 'XX' returns null
//   - top_threat_type — the threat type with the most threats in the cell
// Ties break alphabetically so the response is deterministic.
//
// `limit` (1..2000, default 2000) is honoured and part of the KV key.
export const NODES_MAX_LIMIT = 2000;

export async function handleObservatoryNodes(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  const url = new URL(request.url);
  const period = parseObservatoryPeriod(url.searchParams.get("period"));
  const limit = parseObservatoryLimit(url.searchParams.get("limit"), NODES_MAX_LIMIT, NODES_MAX_LIMIT);
  const windowStart = snappedWindowStart(period);
  const rawSource = url.searchParams.get("source_feed");
  const sourceFilter = buildSourceFilter(rawSource);

  try {
    // KV cache, 15 min. The geo cube's current + previous hour are rebuilt
    // by Navigator every 5 min; the 6-hourly cube_healer reconciles older
    // hours, so a 15-min-old 7-day aggregate is visually indistinguishable.
    const cacheKey = `observatory_nodes:${period}:${sourceFeedCacheSegment(rawSource)}:${limit}`;
    const cached = await readRefreshableCache(request, env.CACHE, cacheKey, OBSERVATORY_TTL_S.nodes);
    if (cached) {
      // Cache hit — record zero D1 reads so attribution still shows
      // request volume.
      recordD1Reads(env, "observatory_nodes", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();
    const rows = await session.prepare(NODES_SQL(sourceFilter.sql))
      .bind(windowStart, ...sourceFilter.params, limit)
      .all<NodeRow>();
    addToTally(tally, rows.meta);

    const data = { success: true, data: (rows.results ?? []).map(shapeNode) };
    await writeRefreshableCache(env.CACHE, cacheKey, data, OBSERVATORY_TTL_S.nodes);
    recordD1Reads(env, "observatory_nodes", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

interface NodeRow {
  lat: number; lng: number; threat_count: number;
  critical: number; high: number; medium: number; low: number;
  country_code: string | null; top_threat_type: string | null;
}

/**
 * Nodes query. `g` is referenced three times, so SQLite (≥3.35) materialises
 * it once — the cube window is scanned a single time. Binds: window start,
 * source params, limit.
 */
export function NODES_SQL(sourceSql: string): string {
  return `
      WITH g AS (
        SELECT
          ROUND(lat_bucket, 1) AS lat,
          ROUND(lng_bucket, 1) AS lng,
          country_code,
          threat_type,
          LOWER(severity) AS severity,
          SUM(threat_count) AS n
        FROM threat_cube_geo
        WHERE hour_bucket >= ?${sourceSql}
        GROUP BY 1, 2, 3, 4, 5
      ),
      cells AS (
        SELECT
          lat, lng,
          SUM(n) AS threat_count,
          ${severitySumsSql("severity", "n")}
        FROM g
        GROUP BY lat, lng
        ORDER BY threat_count DESC, lat, lng
        LIMIT ?
      ),
      cc AS (
        SELECT lat, lng, country_code,
          ROW_NUMBER() OVER (PARTITION BY lat, lng ORDER BY SUM(n) DESC, country_code) AS rn
        FROM g
        WHERE country_code != 'XX'
        GROUP BY lat, lng, country_code
      ),
      tt AS (
        SELECT lat, lng, threat_type,
          ROW_NUMBER() OVER (PARTITION BY lat, lng ORDER BY SUM(n) DESC, threat_type) AS rn
        FROM g
        GROUP BY lat, lng, threat_type
      )
      SELECT
        c.lat, c.lng, c.threat_count,
        c.critical, c.high, c.medium, c.low,
        cc.country_code,
        tt.threat_type AS top_threat_type
      FROM cells c
      LEFT JOIN cc ON cc.lat = c.lat AND cc.lng = c.lng AND cc.rn = 1
      LEFT JOIN tt ON tt.lat = c.lat AND tt.lng = c.lng AND tt.rn = 1
      ORDER BY c.threat_count DESC, c.lat, c.lng
    `;
}

function shapeNode(r: NodeRow) {
  return {
    lat: r.lat,
    lng: r.lng,
    threat_count: r.threat_count,
    top_severity: topSeverity(r),
    critical: r.critical,
    high: r.high,
    medium: r.medium,
    low: r.low,
    country_code: r.country_code ?? null,
    top_threat_type: r.top_threat_type ?? null,
  };
}

// ── Arc assembly (shared by /arcs and /brand-arcs) ────────────────────────────

export interface ArcRow extends SeverityCounts {
  source_lat: number | null;
  source_lng: number | null;
  threat_type: string;
  source_country: string | null;
  target_brand: string | null;
  target_domain: string | null;
  target_sector: string | null;
  hq_lat: number | null;
  hq_lng: number | null;
  hq_country: string | null;
  volume: number;
  first_seen: string | null;
  last_seen: string | null;
}

export interface ArcAssembly {
  arcs: Array<{
    sourcePosition: [number, number];
    targetPosition: [number, number];
    target_precision: TargetPrecision;
    threat_type: string;
    severity: RankedSeverity;
    source_region: string;
    target_brand: string;
    brand_name: string | null;
    volume: number;
    first_seen: string | null;
    last_seen: string | null;
  }>;
  /** Corridors whose brand has no hq_lat/lng, hq_country or exact HQ entry. */
  dropped_unknown_target: number;
  /** Corridors with no source centroid (never drawn at [0,0]). */
  dropped_no_source: number;
}

/** Turn grouped arc rows into drawable arcs; never invents an endpoint. */
export function assembleArcs(rows: ArcRow[]): ArcAssembly {
  const out: ArcAssembly = { arcs: [], dropped_unknown_target: 0, dropped_no_source: 0 };
  for (const row of rows) {
    if (!isUsableCoord(row.source_lat, row.source_lng)) {
      out.dropped_no_source++;
      continue;
    }
    const target = resolveBrandTarget({
      name: row.target_brand,
      canonical_domain: row.target_domain,
      hq_lat: row.hq_lat,
      hq_lng: row.hq_lng,
      hq_country: row.hq_country,
    });
    if (!target) {
      out.dropped_unknown_target++;
      continue;
    }
    out.arcs.push({
      sourcePosition: [row.source_lng as number, row.source_lat as number],
      targetPosition: target.position,
      target_precision: target.precision,
      threat_type: row.threat_type,
      severity: topSeverity(row),
      source_region: row.source_country && row.source_country !== "XX" ? row.source_country : "Unknown",
      target_brand: row.target_brand ?? "Unknown",
      brand_name: row.target_brand ?? null,
      volume: row.volume,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
    });
  }
  return out;
}

// ── GET /api/observatory/arcs ──────────────────────────────────────────────────
// Returns attack corridors for ArcLayer.
//
// PR-Z: reads threat_cube_arcs (grain: hour, country, brand, type, severity,
// source_feed) joined to brands by id. Grouped per (country, brand, type);
// severity is ranked from per-severity sums and the source position is the
// threat-count-weighted centroid of the per-hour cube centroids.
//
// Target placement — see resolveBrandTarget(). Arcs whose brand cannot be
// placed are DROPPED and counted in `dropped_unknown_target`; arcs without a
// source centroid are dropped and counted in `dropped_no_source`.
//
// Cube-empty fallback: if the cube returns 0 rows for an UNFILTERED window the
// handler falls back to a raw-threats GROUP BY so the globe is never blank
// during cube bootstrap. CLAUDE.md §8 flags raw GROUP BY over threats; this one
// is kept because it is (a) bounded — snapped window + status='active' via
// idx_threats_status_created, LIMIT 2500, (b) rare — the 7d cube is never
// empty in steady state, and (c) not reachable via a filter: a source_feed
// filter that matches nothing returns [] instead of paying the raw scan per
// garbage feed value. The fallback result caches for 5 min only.
export const ARCS_ROW_LIMIT = 2500;

export async function handleObservatoryArcs(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  const url = new URL(request.url);
  const period = parseObservatoryPeriod(url.searchParams.get("period"));
  const windowStart = snappedWindowStart(period);
  const rawSource = url.searchParams.get("source_feed");
  const cubeSourceFilter = buildSourceFilter(rawSource, "c");

  try {
    const cacheKey = `observatory_arcs:${period}:${sourceFeedCacheSegment(rawSource)}`;
    const cached = await readRefreshableCache(request, env.CACHE, cacheKey, OBSERVATORY_TTL_S.arcs);
    if (cached) {
      recordD1Reads(env, "observatory_arcs", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();
    const rows = await session.prepare(`
      SELECT
        ROUND(SUM(c.source_lat * c.threat_count) / SUM(CASE WHEN c.source_lat IS NOT NULL THEN c.threat_count END), 1) AS source_lat,
        ROUND(SUM(c.source_lng * c.threat_count) / SUM(CASE WHEN c.source_lng IS NOT NULL THEN c.threat_count END), 1) AS source_lng,
        c.threat_type,
        c.country_code              AS source_country,
        b.name                      AS target_brand,
        b.canonical_domain          AS target_domain,
        b.sector                    AS target_sector,
        b.hq_lat                    AS hq_lat,
        b.hq_lng                    AS hq_lng,
        b.hq_country                AS hq_country,
        SUM(c.threat_count)         AS volume,
        ${severitySumsSql("c.severity", "c.threat_count")},
        MIN(c.first_seen)           AS first_seen,
        MAX(c.last_seen)            AS last_seen
      FROM threat_cube_arcs c
      JOIN brands b ON b.id = c.target_brand_id
      WHERE c.hour_bucket >= ?${cubeSourceFilter.sql}
      GROUP BY c.country_code, c.target_brand_id, c.threat_type
      ORDER BY volume DESC, c.country_code, c.target_brand_id, c.threat_type
      LIMIT ${ARCS_ROW_LIMIT}
    `).bind(windowStart, ...cubeSourceFilter.params).all<ArcRow>();
    addToTally(tally, rows.meta);

    let resultRows = rows.results ?? [];
    // TTL history: 1800s → 3600s (2026-05-16) → 7200s (platform-audit
    // 2026-07-26) to cut the arcs D1 spend; a 7-day aggregate tolerates 2h
    // staleness. Navigator's refresh-warm rewrites the unfiltered 7d/24h/30d
    // keys ahead of expiry (CACHE_REFRESH_MARGIN_S), so the landing page no
    // longer hits the cold gap when the 2h TTL lapses between warms.
    let cacheTtlSeconds: number = OBSERVATORY_TTL_S.arcs;
    let usedFallback = false;

    if (resultRows.length === 0 && normalizeSourceFeed(rawSource) === null) {
      usedFallback = true;
      cacheTtlSeconds = OBSERVATORY_TTL_S.arcsFallback;
      const fallback = await session.prepare(`
        SELECT
          ROUND(AVG(t.lat), 1) AS source_lat,
          ROUND(AVG(t.lng), 1) AS source_lng,
          COALESCE(t.threat_type, 'unknown') AS threat_type,
          COALESCE(t.country_code, 'XX') AS source_country,
          b.name AS target_brand,
          b.canonical_domain AS target_domain,
          b.sector AS target_sector,
          b.hq_lat AS hq_lat,
          b.hq_lng AS hq_lng,
          b.hq_country AS hq_country,
          COUNT(*) AS volume,
          ${severitySumsSql("t.severity", "1")},
          MIN(t.created_at) AS first_seen,
          MAX(t.created_at) AS last_seen
        FROM threats t
        JOIN brands b ON b.id = t.target_brand_id
        WHERE t.lat IS NOT NULL AND t.lng IS NOT NULL
          AND t.target_brand_id IS NOT NULL
          AND t.status = 'active'
          AND t.created_at >= ?
        GROUP BY COALESCE(t.country_code, 'XX'), t.target_brand_id, COALESCE(t.threat_type, 'unknown')
        ORDER BY volume DESC
        LIMIT ${ARCS_ROW_LIMIT}
      `).bind(windowStart).all<ArcRow>();
      addToTally(tally, fallback.meta);
      resultRows = fallback.results ?? [];
    }

    const assembled = assembleArcs(resultRows);
    const data = {
      success: true,
      data: assembled.arcs,
      dropped_unknown_target: assembled.dropped_unknown_target,
      dropped_no_source: assembled.dropped_no_source,
      _fallback: usedFallback || undefined,
    };
    await writeRefreshableCache(env.CACHE, cacheKey, data, cacheTtlSeconds);
    recordD1Reads(env, "observatory_arcs", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ── GET /api/observatory/live ──────────────────────────────────────────────────
// Returns the most recent active threats with full geo data.
// `limit` 1..50 (default 20). TTL 60s: the side panel polls every 15s, so a
// longer TTL made the "live" ticker visibly stale; 60s still collapses the
// polling of every open panel onto one D1 read per minute per key.
export async function handleObservatoryLive(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  const url = new URL(request.url);
  const rawSource = url.searchParams.get("source_feed");
  const sourceFilter = buildSourceFilter(rawSource, "t");
  const limit = parseObservatoryLimit(url.searchParams.get("limit"), 20, 50);

  try {
    const cacheKey = `observatory_live:${sourceFeedCacheSegment(rawSource)}:${limit}`;
    const cached = await readRefreshableCache(request, env.CACHE, cacheKey, OBSERVATORY_TTL_S.live);
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
    await writeRefreshableCache(env.CACHE, cacheKey, data, OBSERVATORY_TTL_S.live);
    recordD1Reads(env, "observatory_live", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ── GET /api/observatory/brand-arcs ───────────────────────────────────────────
// Returns arcs targeting one brand (≤40 corridors, grouped per attacking
// country × threat type from threat_cube_arcs).
//
//   brand_id     required (400 when missing or >128 chars); 404 when unknown
//   period       allow-listed (see parseObservatoryPeriod)
//   source_feed  same canonicalisation as the other endpoints
//
// KV-cached 15 min under `observatory_brand_arcs:<brand_id>:<period>:<source>`
// — staff-global like every observatory key (requireStaff route, no org
// scope). Unknown brand ids 404 BEFORE any cache write, so they never mint
// keys.
//
// Target placement — resolveBrandTarget(); if the brand cannot be placed the
// response carries `data: []`, `target_precision: null` and the corridor count
// in `dropped_unknown_target`.
//
// Cube-empty fallback (unfiltered only): raw threats grouped by the SAME
// (country, threat type) grain as the cube path, over the same snapped
// window. Bounded by idx_threats_brand_created (one brand × window), LIMIT 40.
export const BRAND_ARCS_ROW_LIMIT = 40;
const BRAND_ID_MAX_LEN = 128;

export async function handleObservatoryBrandArcs(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  const url = new URL(request.url);
  const brandId = url.searchParams.get("brand_id");
  const period = parseObservatoryPeriod(url.searchParams.get("period"));
  const windowStart = snappedWindowStart(period);
  const rawSource = url.searchParams.get("source_feed");

  if (!brandId || brandId.length > BRAND_ID_MAX_LEN) {
    return attachBookmark(json({ success: false, error: "brand_id required" }, 400, origin), session);
  }

  try {
    const cacheKey = `observatory_brand_arcs:${brandId}:${period}:${sourceFeedCacheSegment(rawSource)}`;
    const cached = await readRefreshableCache(request, env.CACHE, cacheKey, OBSERVATORY_TTL_S.brandArcs);
    if (cached) {
      recordD1Reads(env, "observatory_brand_arcs", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();
    tally.queries += 1; // .first() exposes no meta
    const brand = await session.prepare(
      "SELECT id, name, canonical_domain, hq_lat, hq_lng, hq_country FROM brands WHERE id = ? LIMIT 1"
    ).bind(brandId).first<{
      id: string; name: string; canonical_domain: string | null;
      hq_lat: number | null; hq_lng: number | null; hq_country: string | null;
    }>();

    if (!brand) {
      recordD1Reads(env, "observatory_brand_arcs", tally);
      return attachBookmark(json({ success: false, error: "Brand not found" }, 404, origin), session);
    }

    const sourceFilter = buildSourceFilter(rawSource);
    const rows = await session.prepare(`
      SELECT
        ROUND(SUM(source_lat * threat_count) / SUM(CASE WHEN source_lat IS NOT NULL THEN threat_count END), 1) AS source_lat,
        ROUND(SUM(source_lng * threat_count) / SUM(CASE WHEN source_lng IS NOT NULL THEN threat_count END), 1) AS source_lng,
        threat_type,
        country_code              AS source_country,
        SUM(threat_count)         AS volume,
        ${severitySumsSql("severity", "threat_count")},
        MIN(first_seen)           AS first_seen,
        MAX(last_seen)            AS last_seen
      FROM threat_cube_arcs
      WHERE target_brand_id = ?
        AND hour_bucket >= ?${sourceFilter.sql}
      GROUP BY country_code, threat_type
      ORDER BY volume DESC, country_code, threat_type
      LIMIT ${BRAND_ARCS_ROW_LIMIT}
    `).bind(brandId, windowStart, ...sourceFilter.params).all<BrandArcRow>();
    addToTally(tally, rows.meta);

    let resultRows = rows.results ?? [];
    let usedFallback = false;
    let ttl: number = OBSERVATORY_TTL_S.brandArcs;

    if (resultRows.length === 0 && normalizeSourceFeed(rawSource) === null) {
      usedFallback = true;
      ttl = OBSERVATORY_TTL_S.arcsFallback;
      const fallback = await session.prepare(`
        SELECT
          ROUND(AVG(t.lat), 1) AS source_lat,
          ROUND(AVG(t.lng), 1) AS source_lng,
          COALESCE(t.threat_type, 'unknown') AS threat_type,
          COALESCE(t.country_code, 'XX') AS source_country,
          COUNT(*) AS volume,
          ${severitySumsSql("t.severity", "1")},
          MIN(t.created_at) AS first_seen,
          MAX(t.created_at) AS last_seen
        FROM threats t
        WHERE t.target_brand_id = ?
          AND t.created_at >= ?
          AND t.lat IS NOT NULL AND t.lng IS NOT NULL
          AND t.status = 'active'
        GROUP BY COALESCE(t.country_code, 'XX'), COALESCE(t.threat_type, 'unknown')
        ORDER BY volume DESC
        LIMIT ${BRAND_ARCS_ROW_LIMIT}
      `).bind(brandId, windowStart).all<BrandArcRow>();
      addToTally(tally, fallback.meta);
      resultRows = fallback.results ?? [];
    }

    const assembled = assembleArcs(resultRows.map((r) => ({
      ...r,
      target_brand: brand.name,
      target_domain: brand.canonical_domain,
      target_sector: null,
      hq_lat: brand.hq_lat,
      hq_lng: brand.hq_lng,
      hq_country: brand.hq_country,
    })));
    const target = resolveBrandTarget(brand);

    const data = {
      success: true,
      data: assembled.arcs.map((a) => ({
        sourcePosition: a.sourcePosition,
        targetPosition: a.targetPosition,
        target_precision: a.target_precision,
        threat_type: a.threat_type,
        severity: a.severity,
        source_region: a.source_region,
        volume: a.volume,
        country_code: a.source_region === "Unknown" ? null : a.source_region,
        first_seen: a.first_seen,
        last_seen: a.last_seen,
      })),
      brand: { id: brand.id, name: brand.name },
      target_precision: target?.precision ?? null,
      dropped_unknown_target: assembled.dropped_unknown_target,
      dropped_no_source: assembled.dropped_no_source,
      _fallback: usedFallback || undefined,
    };
    await writeRefreshableCache(env.CACHE, cacheKey, data, ttl);
    recordD1Reads(env, "observatory_brand_arcs", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

interface BrandArcRow extends SeverityCounts {
  source_lat: number | null;
  source_lng: number | null;
  threat_type: string;
  source_country: string | null;
  volume: number;
  first_seen: string | null;
  last_seen: string | null;
}

// ── GET /api/observatory/stats ─────────────────────────────────────────────────
// Returns summary stats for the stats bar. Every tile is cube-served:
//   - threats_mapped   → threat_cube_geo SUM(threat_count). The geo cube only
//                        holds ACTIVE threats WITH lat/lng.
//   - threats_total    → threat_cube_status SUM(threat_count) WHERE
//                        status='active', same source_feed filter. Same
//                        population as threats_mapped minus the geo
//                        requirement, so `geo_coverage_pct` = mapped / total
//                        is a true geo-coverage ratio (it previously divided by
//                        every status and ignored source_feed).
//   - countries        → threat_cube_geo COUNT(DISTINCT country_code), the
//                        'XX' (unknown country) sentinel excluded
//   - active_campaigns → campaigns table (not threats)
//   - brands_monitored → threat_cube_brand COUNT(DISTINCT target_brand_id),
//                        behind its own 1h cachedValue
export async function handleObservatoryStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  const url = new URL(request.url);
  const period = parseObservatoryPeriod(url.searchParams.get("period"));
  const windowStart = snappedWindowStart(period);
  const sourceFeed = url.searchParams.get("source_feed");
  const sf = buildSourceFilter(sourceFeed);

  try {
    // KV cache, 15 min (stats move only when feeds/cubes move).
    const cacheKey = `observatory_stats:${period}:${sourceFeedCacheSegment(sourceFeed)}`;
    const cached = await readRefreshableCache(request, env.CACHE, cacheKey, OBSERVATORY_TTL_S.stats);
    if (cached) {
      recordD1Reads(env, "observatory_stats", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();
    let brandsDistinctQueried = false;
    const [threats, threatsTotal, countries, campaigns, brands] = await Promise.all([
      session.prepare(
        `SELECT COALESCE(SUM(threat_count), 0) AS n FROM threat_cube_geo WHERE hour_bucket >= ?${sf.sql}`
      ).bind(windowStart, ...sf.params).first<{ n: number }>(),
      session.prepare(
        `SELECT COALESCE(SUM(threat_count), 0) AS n FROM threat_cube_status WHERE hour_bucket >= ? AND status = 'active'${sf.sql}`
      ).bind(windowStart, ...sf.params).first<{ n: number }>(),
      session.prepare(
        `SELECT COUNT(DISTINCT country_code) AS n FROM threat_cube_geo WHERE hour_bucket >= ? AND country_code != 'XX'${sf.sql}`
      ).bind(windowStart, ...sf.params).first<{ n: number }>(),
      session.prepare(
        // status='active' alone over-reports — 48% of "active" campaigns
        // had no threat update in 7+ days at audit time (2026-05-16).
        // Recent last_seen gate keeps the Observatory tile honest.
        `SELECT COUNT(*) AS n FROM campaigns
          WHERE status = 'active' AND last_seen >= datetime('now', '-7 days')`
      ).first<{ n: number }>(),
      // DISTINCT over the brand cube window is the expensive read here
      // (~14M rows/day when recomputed on every stats miss, per period ×
      // source_feed). It moves slowly, so it gets its own 1h cachedValue
      // keyed by the canonical window length + source_feed segment (the
      // query filters on source_feed, so the segment must be in the key).
      cachedValue<{ n: number } | null>(
        env,
        `observatory.brands_distinct:${periodToHours(period)}h:${sourceFeedCacheSegment(sourceFeed)}`,
        OBSERVATORY_BRANDS_DISTINCT_TTL_S,
        () => {
          brandsDistinctQueried = true;
          return session.prepare(
            `SELECT COUNT(DISTINCT target_brand_id) AS n FROM threat_cube_brand WHERE hour_bucket >= ?${sf.sql}`
          ).bind(windowStart, ...sf.params).first<{ n: number }>();
        },
      ),
    ]);
    // .first() doesn't expose meta — count queries but not rows_read.
    // The brand-cube DISTINCT only counts when its cachedValue missed.
    tally.queries += brandsDistinctQueried ? 5 : 4;

    const mapped = threats?.n ?? 0;
    const total = threatsTotal?.n ?? 0;
    // Clamp: the two cubes are rebuilt by separate statements, so a
    // mid-rebuild read can momentarily see mapped > total.
    const coveragePct = total > 0 ? Math.min(100, Math.round((mapped / total) * 100)) : null;

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

    await writeRefreshableCache(env.CACHE, cacheKey, data, OBSERVATORY_TTL_S.stats);
    recordD1Reads(env, "observatory_stats", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ── GET /api/observatory/heatmap ───────────────────────────────────────────
// Global threat heatmap for the Observatory heatmap layer (staff-only, like
// every route here — see the file header).
//
// Served from threat_cube_geo (ACTIVE, geolocated threats only), bucketed to
// a 0.1° grid per severity × threat type. Each point carries
// `weight` = SUM(threat_count) for that bucket. Ordered by weight DESC with
// coordinate/severity/type tie-breaks, so a truncated response (`limit`) is
// always the heaviest buckets, deterministically. Previously this read up to
// 10K raw threat rows with no ORDER BY, no status filter and no source_feed.
//
// Points at exactly (0,0) are excluded (null-island sentinel).
export const HEATMAP_MAX_LIMIT = 10000;

export async function handleObservatoryHeatmap(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  const url = new URL(request.url);
  const period = parseObservatoryPeriod(url.searchParams.get("period"));
  const limit = parseObservatoryLimit(url.searchParams.get("limit"), HEATMAP_MAX_LIMIT, HEATMAP_MAX_LIMIT);
  const windowStart = snappedWindowStart(period);
  const rawSource = url.searchParams.get("source_feed");
  const sf = buildSourceFilter(rawSource);

  try {
    // Key built from the CANONICAL period, source segment and clamped limit
    // so out-of-range params can't amplify cache misses.
    const cacheKey = `observatory_heatmap:${period}:${sourceFeedCacheSegment(rawSource)}:${limit}`;
    const cached = await readRefreshableCache(request, env.CACHE, cacheKey, OBSERVATORY_TTL_S.heatmap);
    if (cached) {
      recordD1Reads(env, "observatory_heatmap", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();
    const rows = await session.prepare(HEATMAP_SQL(sf.sql))
      .bind(windowStart, ...sf.params, limit)
      .all<{ lat: number; lng: number; severity: string; threat_type: string; weight: number }>();
    addToTally(tally, rows.meta);

    const data = { success: true, data: rows.results ?? [] };
    await writeRefreshableCache(env.CACHE, cacheKey, data, OBSERVATORY_TTL_S.heatmap);
    recordD1Reads(env, "observatory_heatmap", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

/** Heatmap query. Binds: window start, source params, limit. */
export function HEATMAP_SQL(sourceSql: string): string {
  return `
      SELECT
        ROUND(lat_bucket, 1) AS lat,
        ROUND(lng_bucket, 1) AS lng,
        LOWER(severity) AS severity,
        threat_type,
        SUM(threat_count) AS weight
      FROM threat_cube_geo
      WHERE hour_bucket >= ?
        AND NOT (lat_bucket = 0 AND lng_bucket = 0)${sourceSql}
      GROUP BY 1, 2, 3, 4
      ORDER BY weight DESC, lat, lng, severity, threat_type
      LIMIT ?
    `;
}

// ── GET /api/observatory/operations ─────────────────────────────────────────
// Lightweight operations list for the Observatory sidebar (staff-only, like
// every route here). `limit` 1..10 (default 5).
export async function handleObservatoryOperations(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const limit = parseObservatoryLimit(url.searchParams.get("limit"), 5, 10);

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
    const cached = await readRefreshableCache(request, env.CACHE, cacheKey, OBSERVATORY_TTL_S.operations);
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
    await writeRefreshableCache(env.CACHE, cacheKey, data, OBSERVATORY_TTL_S.operations);
    recordD1Reads(env, "observatory_operations", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}
