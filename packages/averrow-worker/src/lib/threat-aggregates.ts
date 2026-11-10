// Threats catalog aggregate — slice-aware narrative numbers.
//
// Powers the "What's happening across threats" surface that frames
// the list, NOT just a count of rows. Six narrative axes the page
// must answer (operator language, not column names):
//
//   1. CONFIRMED        — high-confidence threats (score >= 70)
//   2. CORRELATED       — linked into a campaign or shared infra
//   3. ATTRIBUTED       — ASN resolves to a known threat actor
//   4. MULTI-BRAND      — patterns hitting multiple brands at once
//   5. EVOLVING         — surging week-over-week (growing signals)
//   6. ADDRESSED        — remediated vs still-active
//
// Operators land and instantly see "1,420 active · 380 confirmed ·
// 62% correlated into 14 campaigns · 3 of those campaigns are
// hitting 5+ brands · phishing surged +47% this week · 84% addressed."
//
// All filters from handleListThreats are honored so the aggregates
// reflect the analyst's current slice. Wrapped in cachedValue (30min;
// 3h + single-flight refill for the unfiltered, unscoped slice). The
// unfiltered slice's whole-table numbers (headline counts, severity / type /
// status mix, top countries) come from ONE shared base scan cached 8h
// (`threatAggregateBase`), and `new_24h` from threat_cube_status — never the
// former five full-table GROUP BYs per refill (D1 spike 2026-11-09/10).
// Fail-soft per section (softSection): a failed read empties only its
// section and is listed in `degraded_sections`. A degraded refill never
// replaces a complete cached entry: the complete one is kept and re-stamped
// for THREAT_AGGREGATE_DEGRADED_TTL_S (60s back-off); with none (cold key) the
// degraded result is cached for 60s. Throws only if every read failed.

import type { Env } from '../types';
import type { OrgScope } from '../middleware/auth';
import { cachedValue, seedValue } from './cached-value';
import { logger } from './logger';
import { scopeCacheSegment } from './scope-cache-key';
import { runSequential, softSection, type SectionErrors } from './run-sequential';

/** KV TTL for the per-slice threat aggregate (raised 300 → 1800, D1 read spend 2026-10). */
export const THREAT_AGGREGATE_TTL_S = 1800;

/**
 * KV TTL for the unfiltered, unscoped slice (the default Threats page). Every
 * query in that slice is a full scan of `threats`, so a miss costs ~20M rows;
 * its numbers are platform-wide and move slowly. 2026-11-08 D1 overload.
 */
export const THREAT_AGGREGATE_UNFILTERED_TTL_S = 10800;

/**
 * KV freshness for a DEGRADED result (one or more sections failed and fell
 * back to empty/zero). Short so a transient `D1 DB is overloaded` doesn't
 * pin zeros for the 30 min / 3 h slice TTL. 2026-11-09.
 */
export const THREAT_AGGREGATE_DEGRADED_TTL_S = 60;

/**
 * Single-flight for the unfiltered refill (lib/cached-value.ts
 * `singleFlight`, stale-while-revalidate): one request recomputes while
 * others are served the expired entry. Only a cold key (no entry at all)
 * makes others wait, up to THREAT_AGGREGATE_SINGLE_FLIGHT_WAIT_MS, before
 * computing themselves (fail-open). A miss with several staff tabs open
 * used to send the ~12-scan refill once per tab.
 */
export const THREAT_AGGREGATE_LOCK_TTL_S = 120;
export const THREAT_AGGREGATE_SINGLE_FLIGHT_WAIT_MS = 10_000;
export const THREAT_AGGREGATE_SINGLE_FLIGHT_POLL_MS = 1_000;

/**
 * Shared base of the unfiltered, unscoped slice: every whole-table number the
 * aggregate shows (headline counts, severity / type / status mix, top
 * countries), computed by ONE `NOT INDEXED` scan of `threats` (~1.55M rows)
 * and cached 8h with single-flight. Before 2026-11-10 each unfiltered refill
 * ran five separate full-table reads for these (headline + severity + status
 * + type + country ≈ 10–12M rows, severity alone ~3.1M via an index walk);
 * prod D1 analytics showed ~20M unmetered rows per refill and 4–9 refills an
 * hour in the 2026-11-09 04:00 / 21:00 spikes (retries / degraded polling on
 * a cold key). The numbers it holds move slowly; `new_24h` is NOT taken from
 * it (6h would be too stale) but from threat_cube_status.
 *
 * Why not the cubes for these: threat_cube_status / _geo start at the first
 * rebuilt hour (prod: 2026-03-30, ~100K older threats missing) and are healed
 * only 2d/14d back, so their status split drifts (prod 2026-11-10: cube
 * remediated 122 vs 1,366 live); they carry no confidence_score or
 * campaign_id (the `confirmed` / `correlated` headline numbers would still
 * need a full scan); and _geo is active + lat/lng only.
 *
 * Cost (prod EXPLAIN + run, 2026-11-10): `SCAN t` + temp B-tree, 2,716
 * groups, rows_read ~3.1M (the GROUP BY sorter doubles the 1.55M table
 * rows), ~10s. Refreshed off the request path by cube_healer every 6h
 * (`refreshThreatAggregateBase`), so ≤ 4 scans (~12M rows) a day; the TTL is
 * 8h so a live read finds it fresh between two healer runs and only computes
 * it inline if the healer missed a run (single-flight then serves the stale
 * copy to everyone else; KV keeps it 2× TTL).
 */
export const THREAT_AGGREGATE_BASE_KEY = 'threats.aggregate_base.v1';

/** Response sections the base scan feeds besides `headline` (degraded together with it). */
const BASE_FED_SECTIONS = ['by_severity', 'by_type', 'by_status', 'top_countries'] as const;
export const THREAT_AGGREGATE_BASE_TTL_S = 28800;

/** The whole-table base scan (see THREAT_AGGREGATE_BASE_KEY). Exported for tests. */
export const THREAT_AGGREGATE_BASE_SQL = `
  SELECT t.status AS status, t.severity AS severity, t.threat_type AS threat_type,
         t.country_code AS country_code,
         COUNT(*) AS n,
         SUM(CASE WHEN t.confidence_score >= 70 THEN 1 ELSE 0 END) AS confirmed,
         SUM(CASE WHEN t.campaign_id IS NOT NULL THEN 1 ELSE 0 END) AS correlated_by_campaign
  FROM threats t NOT INDEXED
  GROUP BY t.status, t.severity, t.threat_type, t.country_code`;

/**
 * Threats created in the last 24h, from threat_cube_status (rebuilt for the
 * current + previous hour every 5 min by Navigator). The window is
 * hour-snapped, so it covers 24h plus the part of the oldest hour bucket
 * before the cut (≤ 25h) — the unfiltered `new_24h` was an exact 24h scan of
 * the whole table. Seeks idx_cube_status_hour.
 */
export const THREAT_AGGREGATE_NEW_24H_CUBE_SQL = `
  SELECT COALESCE(SUM(threat_count), 0) AS n
  FROM threat_cube_status
  WHERE hour_bucket >= strftime('%Y-%m-%d %H:00:00', 'now', '-24 hours')`;

/** Reduced form of the base scan — what is cached under THREAT_AGGREGATE_BASE_KEY. */
export interface ThreatAggregateBase {
  total:                  number;
  confirmed:              number;
  correlated_by_campaign: number;
  active:                 number;
  addressed:              number;
  by_severity:   Array<{ severity: string; count: number }>;
  /** Top 8, like the filtered slice's `LIMIT 8`. */
  by_type:       Array<{ type: string; count: number }>;
  by_status:     Array<{ status: string; count: number }>;
  /** Top 10 non-null, non-'XX' countries, like the filtered slice's query. */
  top_countries: Array<{ country: string; count: number }>;
}

interface ThreatAggregateBaseRow {
  status: string | null; severity: string | null; threat_type: string | null;
  country_code: string | null; n: number; confirmed: number | null; correlated_by_campaign: number | null;
}

/** Sum `n` per key (NULL kept as its own key, as SQL GROUP BY does), count DESC, ties by key. */
function rankBy(rows: ThreatAggregateBaseRow[], key: (r: ThreatAggregateBaseRow) => string | null): Array<[string, number]> {
  const sums = new Map<string | null, number>();
  for (const r of rows) {
    const k = key(r);
    sums.set(k, (sums.get(k) ?? 0) + (r.n ?? 0));
  }
  // The response types declare string keys; a NULL group is returned as null
  // exactly like the former per-dimension GROUP BY did.
  return [...sums.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([k, n]) => [k as string, n]);
}

/** Fold the base scan's (status, severity, type, country) groups into the cached base. Exported for tests. */
export function reduceThreatAggregateBase(rows: ThreatAggregateBaseRow[]): ThreatAggregateBase {
  let total = 0, confirmed = 0, correlated = 0, active = 0, addressed = 0;
  for (const r of rows) {
    total += r.n ?? 0;
    confirmed += r.confirmed ?? 0;
    correlated += r.correlated_by_campaign ?? 0;
    if (r.status === 'active') active += r.n ?? 0;
    if (r.status === 'down' || r.status === 'remediated') addressed += r.n ?? 0;
  }
  return {
    total, confirmed, correlated_by_campaign: correlated, active, addressed,
    by_severity: rankBy(rows, (r) => r.severity).map(([severity, count]) => ({ severity, count })),
    by_type: rankBy(rows, (r) => r.threat_type).slice(0, 8).map(([type, count]) => ({ type, count })),
    by_status: rankBy(rows, (r) => r.status).map(([status, count]) => ({ status, count })),
    top_countries: rankBy(rows.filter((r) => r.country_code !== null && r.country_code !== 'XX'), (r) => r.country_code)
      .slice(0, 10).map(([country, count]) => ({ country, count })),
  };
}

async function computeThreatAggregateBase(db: AggregateReadDb): Promise<ThreatAggregateBase> {
  const r = await db.prepare(THREAT_AGGREGATE_BASE_SQL).all<ThreatAggregateBaseRow>();
  return reduceThreatAggregateBase(r.results ?? []);
}

/**
 * Recompute the base and write it to KV (cube_healer, every 6h). Throws on a
 * failed scan and leaves the previous entry in place.
 */
export async function refreshThreatAggregateBase(env: Env, db: AggregateReadDb): Promise<ThreatAggregateBase> {
  const base = await computeThreatAggregateBase(db);
  await seedValue(env, THREAT_AGGREGATE_BASE_KEY, base, THREAT_AGGREGATE_BASE_TTL_S);
  return base;
}

/**
 * The shared, cached base of the unfiltered slice (see
 * THREAT_AGGREGATE_BASE_KEY). One key for every caller — it only exists for
 * the unscoped, unfiltered slice. A failed scan throws and caches nothing.
 */
export async function threatAggregateBase(env: Env, db: AggregateReadDb): Promise<ThreatAggregateBase> {
  return cachedValue<ThreatAggregateBase>(env, THREAT_AGGREGATE_BASE_KEY, THREAT_AGGREGATE_BASE_TTL_S, () => computeThreatAggregateBase(db), {
    singleFlight: {
      lockTtlSeconds: THREAT_AGGREGATE_LOCK_TTL_S,
      waitMs: THREAT_AGGREGATE_SINGLE_FLIGHT_WAIT_MS,
      pollMs: THREAT_AGGREGATE_SINGLE_FLIGHT_POLL_MS,
    },
  });
}

/** Anything with `prepare` — `env.DB` or a read-replica `D1DatabaseSession`. */
export type AggregateReadDb = Pick<D1Database, 'prepare'>;

// The aggregate's D1 queries run one after another (lib/run-sequential.ts).
// A cache miss here used to send ~13 full-table GROUP BYs to D1 at once,
// which on the unfiltered slice tripped `D1 DB is overloaded` (prod,
// 2026-11-08) for every other request. Re-exported for existing importers.
export { runSequential };

export interface ThreatAggregateFilters {
  severity?:  string;
  type?:      string;
  status?:    string;
  source?:    string;
  search?:    string;
  brand_id?:  string;
  actor_id?:  string;
  country?:   string;
  /** ISO date (YYYY-MM-DD) — filter to threats created_at >= since. */
  since?:     string;
}

export interface ThreatAggregate {
  // ── Headline narrative numbers ──
  total:            number;
  confirmed:        number;       // confidence_score >= 70
  correlated:       number;       // in a campaign OR attributed to actor
  attributed:       number;       // actor attribution via threat_actor_infrastructure
  unattributed:     number;       // total - attributed
  active:           number;       // status = 'active'
  addressed:        number;       // status IN ('down','remediated')
  remediation_rate: number;       // addressed / total (0..1)
  new_24h:          number;

  // ── Mix breakdowns ──
  by_severity:    Array<{ severity: string; count: number }>;
  by_type:        Array<{ type: string; count: number }>;
  by_status:      Array<{ status: string; count: number }>;

  // ── Multi-brand patterns ──
  // Campaigns / actors / providers that are hitting ≥2 brands in the
  // current slice. Operator question: "what's hitting multiple
  // brands at once → what's coordinated."
  multi_brand_campaigns: Array<{ id: string; name: string; brand_count: number; threat_count: number; status: string }>;
  multi_brand_actors:    Array<{ id: string; name: string; brand_count: number; threat_count: number }>;
  multi_brand_providers: Array<{ id: string; name: string; asn: string | null; brand_count: number; threat_count: number }>;

  // ── Evolving signals (week-over-week deltas on top types/actors) ──
  // Compares last 7 days vs the 7 days before. "Phishing surged +47%."
  surging_signals: Array<{
    kind:         'type' | 'campaign';
    id?:          string;
    label:        string;
    current_7d:   number;
    previous_7d:  number;
    delta_pct:    number;
  }>;

  // ── Top-of-pile leaderboards (with favicon/avatar source) ──
  top_countries:  Array<{ country: string; count: number }>;
  top_brands:     Array<{ brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; count: number }>;
  top_providers:  Array<{ provider_id: string; name: string; asn: string | null; count: number }>;
  top_actors:     Array<{ actor_id: string; actor_name: string; count: number }>;
  top_campaigns:  Array<{ campaign_id: string; name: string; threat_count: number; brand_count: number; status: string }>;

  // ── Fail-soft telemetry (additive) ──
  // Sections whose read failed and were replaced by an empty/zero fallback
  // (e.g. `headline`, `by_type`, `surging_types`). Empty when every read
  // succeeded. Absent on entries cached before 2026-11-09.
  degraded_sections?: string[];
}

function buildWhere(filters: ThreatAggregateFilters, scope?: OrgScope | null): {
  where: string;
  params: unknown[];
  empty: boolean;
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (scope) {
    if (scope.brand_ids.length === 0) {
      return { where: '', params: [], empty: true };
    }
    const placeholders = scope.brand_ids.map(() => '?').join(', ');
    conditions.push(`t.target_brand_id IN (${placeholders})`);
    params.push(...scope.brand_ids);
  }

  if (filters.severity) { conditions.push('t.severity = ?');         params.push(filters.severity); }
  if (filters.type)     { conditions.push('t.threat_type = ?');      params.push(filters.type); }
  if (filters.status)   { conditions.push('t.status = ?');           params.push(filters.status); }
  if (filters.source)   { conditions.push('t.source_feed = ?');      params.push(filters.source); }
  if (filters.brand_id) { conditions.push('t.target_brand_id = ?');  params.push(filters.brand_id); }
  if (filters.country)  { conditions.push('t.country_code = ?');     params.push(filters.country); }
  if (filters.since)    { conditions.push('t.created_at >= ?');      params.push(filters.since); }
  if (filters.search) {
    conditions.push('(t.malicious_domain LIKE ? OR t.malicious_url LIKE ? OR t.ip_address LIKE ? OR t.ioc_value LIKE ?)');
    const pat = `%${filters.search}%`;
    params.push(pat, pat, pat, pat);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    empty: false,
  };
}

function emptyAgg(): ThreatAggregate {
  return {
    total: 0, confirmed: 0, correlated: 0, attributed: 0, unattributed: 0,
    active: 0, addressed: 0, remediation_rate: 0, new_24h: 0,
    by_severity: [], by_type: [], by_status: [],
    multi_brand_campaigns: [], multi_brand_actors: [], multi_brand_providers: [],
    surging_signals: [],
    top_countries: [], top_brands: [], top_providers: [], top_actors: [], top_campaigns: [],
    degraded_sections: [],
  };
}

export async function threatAggregate(
  env: Env,
  filters: ThreatAggregateFilters,
  scope?: OrgScope | null,
  /** Read path (handler passes its read-replica session). Defaults to env.DB. */
  readDb?: AggregateReadDb,
): Promise<ThreatAggregate> {
  const { where, params, empty } = buildWhere(filters, scope);
  if (empty) return emptyAgg();
  const db: AggregateReadDb = readDb ?? env.DB;
  // No filter, no actor and no org scope (a scope always sets `where`): the
  // slice is "every threat", so leaderboards with a pre-computed source of
  // the same quantity read it instead of a full-table GROUP BY (counts may
  // lag the live table — see the per-query notes below).
  const unfiltered = !where && !filters.actor_id;

  // Actor filter as a semi-join, not a JOIN: threat_actor_infrastructure has
  // no unique (threat_actor_id, asn), so a JOIN repeated each threat once per
  // matching infrastructure row and inflated every count in the slice. Its
  // bind leads, so `queryParams` = [actor_id, ...params].
  const actorCond = 't.asn IN (SELECT asn FROM threat_actor_infrastructure WHERE threat_actor_id = ?)';
  const sliceWhere = filters.actor_id
    ? `WHERE ${[actorCond, where.replace(/^WHERE /, '')].filter(Boolean).join(' AND ')}`
    : where;
  // Extra JOINs must sit before WHERE: `${fromClause} JOIN ...` produced
  // `... WHERE ... JOIN ...` (syntax error) whenever a filter or scope set
  // `where`. Extra joins carry no binds, so `queryParams` order holds.
  const fromWith = (extraJoin = '') => `FROM threats t ${extraJoin} ${sliceWhere}`;
  const fromClause = fromWith();
  const queryParams = filters.actor_id
    ? [filters.actor_id, ...params]
    : params;

  const scopeHash = await scopeCacheSegment(scope);
  const cacheKey = [
    'threat-agg', scopeHash,
    filters.severity ?? '', filters.type ?? '', filters.status ?? '',
    filters.source ?? '', filters.brand_id ?? '', filters.actor_id ?? '',
    filters.country ?? '', filters.since ?? '', filters.search ?? '',
  ].join(':');

  // 30 min (was 5): ~20 GROUP BY/JOIN queries over threats per miss, and
  // the narrative numbers move slowly. Not Navigator-warmed, so there is
  // no warm cadence to keep under the TTL.
  const ttl = unfiltered ? THREAT_AGGREGATE_UNFILTERED_TTL_S : THREAT_AGGREGATE_TTL_S;
  const singleFlight = unfiltered
    ? {
        lockTtlSeconds: THREAT_AGGREGATE_LOCK_TTL_S,
        waitMs: THREAT_AGGREGATE_SINGLE_FLIGHT_WAIT_MS,
        pollMs: THREAT_AGGREGATE_SINGLE_FLIGHT_POLL_MS,
      }
    : undefined;
  return cachedValue<ThreatAggregate>(env, cacheKey, ttl, async () => {
    // Fail-soft (2026-11-09): every read is a softSection. A failed read
    // (e.g. `D1 DB is overloaded`) degrades only its section to an
    // empty/zero fallback and is listed in `degraded_sections` (see the
    // keepExistingWhen / ttlFor options below for how it is cached).
    // Only when EVERY attempted read failed does compute throw (→ 500, and
    // nothing is cached).
    const sectionErrors: SectionErrors = {};
    // A Set: the unfiltered headline is two reads (base + cube) in one section.
    const attempted = new Set<string>();
    const soft = <T>(section: string, fallback: T, fn: () => Promise<T>): (() => Promise<T>) => {
      attempted.add(section);
      return softSection(sectionErrors, section, fallback, fn);
    };
    type Rows<T> = { results: T[] };
    const noRows = <T>(): Rows<T> => ({ results: [] });
    const rowsOf = <T>(r: { results?: T[] } | null | undefined): Rows<T> => ({ results: r?.results ?? [] });
    const fromBase = <T>(rows: T[] | undefined) => async (): Promise<Rows<T>> => ({ results: rows ?? [] });

    type Headline = {
      total: number; confirmed: number; correlated_by_campaign: number;
      active: number; addressed: number; new_24h: number;
    };
    // Unfiltered: the shared 8h base scan feeds the headline AND the
    // severity / type / status / country sections (no per-refill full-table
    // GROUP BYs); new_24h comes from threat_cube_status. A failed base scan
    // degrades every section it feeds, under their usual names.
    let base: ThreatAggregateBase | null = null;
    let headline: Headline | null;
    if (unfiltered) {
      base = await soft('headline', null, () => threatAggregateBase(env, db))();
      for (const section of BASE_FED_SECTIONS) {
        attempted.add(section);
        if (!base) sectionErrors[`${section}_error`] = sectionErrors.headline_error ?? 'base scan failed';
      }
      const new24 = await soft('headline', null, () =>
        db.prepare(THREAT_AGGREGATE_NEW_24H_CUBE_SQL).first<{ n: number }>())();
      headline = base ? { ...base, new_24h: new24?.n ?? 0 } : null;
    } else {
    // Headline counts in one query
    headline = await soft('headline', null, () => db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN t.confidence_score >= 70 THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN t.campaign_id IS NOT NULL THEN 1 ELSE 0 END) AS correlated_by_campaign,
        SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN t.status IN ('down','remediated') THEN 1 ELSE 0 END) AS addressed,
        SUM(CASE WHEN t.created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS new_24h
      ${fromClause}
    `).bind(...queryParams).first<Headline>())();
    }

    // Attribution count
    let attributed = 0;
    if (filters.actor_id) {
      attributed = headline?.total ?? 0;
    } else {
      // Semi-join form of "threats whose ASN belongs to any actor".
      // Equivalent to the former COUNT(DISTINCT t.id) over a JOIN (t.id is
      // the PK), but the `t.asn IN (...)` term lets SQLite seek the partial
      // idx_threats_asn (migration 0277 — IN implies asn IS NOT NULL)
      // regardless of table stats, instead of scanning threats per
      // threat_actor_infrastructure row (~70M reads/24h across the
      // three ASN-joined queries in this function).
      const attrRow = await soft('attributed', null, () => db.prepare(`
        SELECT COUNT(*) AS attributed
        FROM threats t
        ${where ? `${where} AND` : 'WHERE'} t.asn IN (SELECT asn FROM threat_actor_infrastructure)
      `).bind(...params).first<{ attributed: number }>())();
      attributed = attrRow?.attributed ?? 0;
    }

    const total = headline?.total ?? 0;
    const correlated = Math.max(headline?.correlated_by_campaign ?? 0, attributed);
    const active = headline?.active ?? 0;
    const addressed = headline?.addressed ?? 0;
    const remediation_rate = total > 0 ? addressed / total : 0;

    // Unfiltered slice: by_severity / by_type / by_status / top_countries come
    // from the shared base scan above; top_brands / top_providers from
    // pre-computed counters of the same all-time, all-status quantity
    // (maintained counters, so they can lag the live table by hours). The
    // rest stay on threats:
    //  - campaigns / actors / multi-brand rows: no pre-computed source
    //    (multi_brand_providers needs COUNT(DISTINCT target_brand_id) per
    //    provider; no cube carries provider × brand).
    type BrandRow = { brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; count: number };
    type ProviderRow = { provider_id: string; name: string; asn: string | null; count: number };
    type ActorRow = { actor_id: string; actor_name: string; count: number };
    type CampaignRow = { campaign_id: string; name: string; status: string; threat_count: number; brand_count: number };
    type MbCampaignRow = { id: string; name: string; status: string; threat_count: number; brand_count: number };
    type MbActorRow = { id: string; name: string; threat_count: number; brand_count: number };
    type MbProviderRow = { id: string; name: string; asn: string | null; threat_count: number; brand_count: number };
    type SurgeTypeRow = { label: string; current_7d: number; previous_7d: number };
    type SurgeCampaignRow = { id: string; label: string; current_7d: number; previous_7d: number };

    const [bySev, byType, byStatus, geo, brands, providers, actors, campaigns,
           mbCampaigns, mbActors, mbProviders, surgeTypes, surgeCampaigns] = await runSequential([
      unfiltered ? fromBase(base?.by_severity) : soft('by_severity', noRows<{ severity: string; count: number }>(), async () => rowsOf(await db.prepare(
        `SELECT t.severity AS severity, COUNT(*) AS count ${fromClause}
                      GROUP BY t.severity ORDER BY count DESC`)
        .bind(...queryParams).all<{ severity: string; count: number }>())),
      unfiltered ? fromBase(base?.by_type) : soft('by_type', noRows<{ type: string; count: number }>(), async () => rowsOf(await db.prepare(
        `SELECT t.threat_type AS type, COUNT(*) AS count ${fromClause}
                      GROUP BY t.threat_type ORDER BY count DESC LIMIT 8`)
        .bind(...queryParams).all<{ type: string; count: number }>())),
      unfiltered ? fromBase(base?.by_status) : soft('by_status', noRows<{ status: string; count: number }>(), async () => rowsOf(await db.prepare(
        `SELECT t.status AS status, COUNT(*) AS count ${fromClause}
                      GROUP BY t.status ORDER BY count DESC`)
        .bind(...queryParams).all<{ status: string; count: number }>())),
      unfiltered ? fromBase(base?.top_countries) : soft('top_countries', noRows<{ country: string; count: number }>(), async () => rowsOf(await db.prepare(
        `SELECT t.country_code AS country, COUNT(*) AS count
                      ${fromClause} ${sliceWhere ? 'AND' : 'WHERE'} t.country_code IS NOT NULL AND t.country_code != 'XX'
                      GROUP BY t.country_code ORDER BY count DESC LIMIT 10`)
        .bind(...queryParams).all<{ country: string; count: number }>())),
      // Unfiltered: brands.threat_count is COUNT(*) of ALL linked threats,
      // every status (lib/brand-count-reconciler.ts, 6-hourly + incremental
      // bumps) — the same quantity this GROUP BY computes for an empty
      // slice, but NOT live: some brand-link writers skip the incremental
      // bump, so a count can lag by up to the 6h reconcile.
      // idx_brands_threat_count serves the ORDER BY … LIMIT.
      soft('top_brands', noRows<BrandRow>(), async () => rowsOf(await (unfiltered
        ? db.prepare(`SELECT b.id AS brand_id, b.name AS brand_name,
                             b.canonical_domain, b.logo_url, b.threat_count AS count
                      FROM brands b
                      WHERE b.threat_count > 0
                      ORDER BY b.threat_count DESC LIMIT 8`)
        : db.prepare(`SELECT t.target_brand_id AS brand_id, b.name AS brand_name,
                             b.canonical_domain, b.logo_url, COUNT(*) AS count
                      ${fromWith('JOIN brands b ON b.id = t.target_brand_id')}
                      GROUP BY t.target_brand_id, b.name, b.canonical_domain, b.logo_url
                      ORDER BY count DESC LIMIT 8`).bind(...queryParams)
        ).all<BrandRow>())),
      // Unfiltered: hosting_providers.total_threat_count is COUNT(*) of
      // threats on the provider, every status (lib/provider-counts.ts,
      // enrichment Stage 5 every 4h) — same quantity as the GROUP BY for an
      // empty slice but up to ~4h behind it (no incremental writer), and
      // what /api/dashboard's worst-providers already reads.
      // ~20K-row provider scan instead of a ~1.84M-row threats GROUP BY.
      soft('top_providers', noRows<ProviderRow>(), async () => rowsOf(await (unfiltered
        ? db.prepare(`SELECT hp.id AS provider_id, hp.name AS name, hp.asn AS asn,
                             hp.total_threat_count AS count
                      FROM hosting_providers hp
                      WHERE hp.total_threat_count > 0
                      ORDER BY hp.total_threat_count DESC LIMIT 8`)
        : db.prepare(`SELECT t.hosting_provider_id AS provider_id, hp.name AS name, hp.asn AS asn,
                             COUNT(*) AS count
                      ${fromWith('JOIN hosting_providers hp ON hp.id = t.hosting_provider_id')}
                      GROUP BY t.hosting_provider_id, hp.name, hp.asn
                      ORDER BY count DESC LIMIT 8`).bind(...queryParams)
        ).all<ProviderRow>())),
      soft('top_actors', noRows<ActorRow>(), async () => rowsOf(await db.prepare(
        `SELECT tai.threat_actor_id AS actor_id, ta.name AS actor_name,
                             COUNT(DISTINCT t.id) AS count
                      FROM threats t
                      JOIN threat_actor_infrastructure tai ON tai.asn = t.asn
                      JOIN threat_actors ta ON ta.id = tai.threat_actor_id
                      ${where}
                      GROUP BY tai.threat_actor_id, ta.name
                      ORDER BY count DESC LIMIT 6`)
        .bind(...params).all<ActorRow>())),
      soft('top_campaigns', noRows<CampaignRow>(), async () => rowsOf(await db.prepare(
        `SELECT t.campaign_id AS campaign_id, c.name AS name, c.status AS status,
                             COUNT(*) AS threat_count, COUNT(DISTINCT t.target_brand_id) AS brand_count
                      ${fromWith('JOIN campaigns c ON c.id = t.campaign_id')}
                      GROUP BY t.campaign_id, c.name, c.status
                      ORDER BY threat_count DESC LIMIT 6`)
        .bind(...queryParams).all<CampaignRow>())),

      // ── Multi-brand patterns (brand_count >= 2 in the slice) ──
      soft('multi_brand_campaigns', noRows<MbCampaignRow>(), async () => rowsOf(await db.prepare(
        `SELECT t.campaign_id AS id, c.name AS name, c.status AS status,
                             COUNT(*) AS threat_count, COUNT(DISTINCT t.target_brand_id) AS brand_count
                      ${fromWith('JOIN campaigns c ON c.id = t.campaign_id')}
                      GROUP BY t.campaign_id, c.name, c.status
                      HAVING COUNT(DISTINCT t.target_brand_id) >= 2
                      ORDER BY brand_count DESC, threat_count DESC LIMIT 5`)
        .bind(...queryParams).all<MbCampaignRow>())),
      soft('multi_brand_actors', noRows<MbActorRow>(), async () => rowsOf(await db.prepare(
        `SELECT tai.threat_actor_id AS id, ta.name AS name,
                             COUNT(DISTINCT t.id) AS threat_count,
                             COUNT(DISTINCT t.target_brand_id) AS brand_count
                      FROM threats t
                      JOIN threat_actor_infrastructure tai ON tai.asn = t.asn
                      JOIN threat_actors ta ON ta.id = tai.threat_actor_id
                      ${where}
                      GROUP BY tai.threat_actor_id, ta.name
                      HAVING COUNT(DISTINCT t.target_brand_id) >= 2
                      ORDER BY brand_count DESC, threat_count DESC LIMIT 5`)
        .bind(...params).all<MbActorRow>())),
      soft('multi_brand_providers', noRows<MbProviderRow>(), async () => rowsOf(await db.prepare(
        `SELECT t.hosting_provider_id AS id, hp.name AS name, hp.asn AS asn,
                             COUNT(*) AS threat_count,
                             COUNT(DISTINCT t.target_brand_id) AS brand_count
                      ${fromWith('JOIN hosting_providers hp ON hp.id = t.hosting_provider_id')}
                      GROUP BY t.hosting_provider_id, hp.name, hp.asn
                      HAVING COUNT(DISTINCT t.target_brand_id) >= 2
                      ORDER BY brand_count DESC, threat_count DESC LIMIT 5`)
        .bind(...queryParams).all<MbProviderRow>())),

      // ── Surging week-over-week: types (ignores slice's `since` for the
      //   comparison window — surge is always last 7d vs prior 7d). ──
      // INDEXED BY idx_threats_created_brand (created_at, target_brand_id;
      // migration 0087): without the pin prod's planner picks
      // `SCAN t USING INDEX idx_threats_type` — the whole index plus a row
      // lookup on all ~1.55M threats — instead of `SEARCH (created_at>?)`
      // over the ~87K-row 14-day window (EXPLAIN QUERY PLAN, 2026-11-09).
      soft('surging_types', noRows<SurgeTypeRow>(), async () => rowsOf(await db.prepare(`
        SELECT
          t.threat_type AS label,
          SUM(CASE WHEN t.created_at >= datetime('now','-7 days')  THEN 1 ELSE 0 END) AS current_7d,
          SUM(CASE WHEN t.created_at <  datetime('now','-7 days')
                AND t.created_at >= datetime('now','-14 days') THEN 1 ELSE 0 END) AS previous_7d
        FROM threats t INDEXED BY idx_threats_created_brand
        WHERE t.created_at >= datetime('now','-14 days')
        GROUP BY t.threat_type
        HAVING current_7d > 0
        ORDER BY (current_7d - previous_7d) DESC
        LIMIT 5
      `).all<SurgeTypeRow>())),
      // Same 14-day created_at window, same pin: threats is driven by the
      // window range and campaigns is a PK lookup per row.
      soft('surging_campaigns', noRows<SurgeCampaignRow>(), async () => rowsOf(await db.prepare(`
        SELECT
          t.campaign_id AS id, c.name AS label,
          SUM(CASE WHEN t.created_at >= datetime('now','-7 days')  THEN 1 ELSE 0 END) AS current_7d,
          SUM(CASE WHEN t.created_at <  datetime('now','-7 days')
                AND t.created_at >= datetime('now','-14 days') THEN 1 ELSE 0 END) AS previous_7d
        FROM threats t INDEXED BY idx_threats_created_brand
        JOIN campaigns c ON c.id = t.campaign_id
        WHERE t.created_at >= datetime('now','-14 days')
        GROUP BY t.campaign_id, c.name
        HAVING current_7d > 0
        ORDER BY (current_7d - previous_7d) DESC
        LIMIT 5
      `).all<SurgeCampaignRow>())),
    ]);

    // Section names (without the `_error` suffix softSection appends).
    const degraded_sections = Object.keys(sectionErrors).map((k) => k.replace(/_error$/, ''));
    const allFailed = attempted.size > 0 && degraded_sections.length === attempted.size;
    if (degraded_sections.length > 0) {
      // Log the messages (never put them in the response): a deterministic SQL
      // bug in one section must be tellable from a D1 overload.
      (allFailed ? logger.error : logger.warn)('threat_aggregate_sections_degraded', {
        cache_key: cacheKey,
        sections: degraded_sections,
        errors: sectionErrors,
      });
    }
    if (allFailed) {
      // Nothing succeeded: fail the request (handler → 500) instead of
      // caching an all-empty aggregate.
      throw new Error(`threat aggregate: every section failed (${Object.values(sectionErrors)[0] ?? 'unknown error'})`);
    }

    // Compose surging signals from type + campaign rows
    const surgeFromTypes = surgeTypes.results.map(r => ({
      kind: 'type' as const,
      label: r.label,
      current_7d: r.current_7d,
      previous_7d: r.previous_7d,
      delta_pct: r.previous_7d > 0
        ? Math.round(((r.current_7d - r.previous_7d) / r.previous_7d) * 100)
        : (r.current_7d > 0 ? 100 : 0),
    }));
    const surgeFromCampaigns = surgeCampaigns.results.map(r => ({
      kind: 'campaign' as const,
      id: r.id,
      label: r.label,
      current_7d: r.current_7d,
      previous_7d: r.previous_7d,
      delta_pct: r.previous_7d > 0
        ? Math.round(((r.current_7d - r.previous_7d) / r.previous_7d) * 100)
        : (r.current_7d > 0 ? 100 : 0),
    }));
    const surging_signals = [...surgeFromTypes, ...surgeFromCampaigns]
      .filter(s => s.current_7d >= 3)        // ignore noise
      .sort((a, b) => b.delta_pct - a.delta_pct)
      .slice(0, 8);

    return {
      total,
      confirmed:        headline?.confirmed ?? 0,
      correlated,
      attributed,
      unattributed:     Math.max(0, total - attributed),
      active,
      addressed,
      remediation_rate,
      new_24h:          headline?.new_24h ?? 0,
      by_severity:      bySev.results,
      by_type:          byType.results,
      by_status:        byStatus.results,
      multi_brand_campaigns: mbCampaigns.results,
      multi_brand_actors:    mbActors.results,
      multi_brand_providers: mbProviders.results,
      surging_signals,
      top_countries:    geo.results,
      top_brands:       brands.results,
      top_providers:    providers.results,
      top_actors:       actors.results,
      top_campaigns:    campaigns.results,
      degraded_sections,
    };
  }, {
    singleFlight,
    // Never replace a complete entry (fresh or expired: entries stay in KV for
    // 2x their TTL, i.e. up to 6h unfiltered / 1h per slice) with a degraded
    // refill. The older complete numbers are returned and re-stamped fresh for
    // THREAT_AGGREGATE_DEGRADED_TTL_S, so during an overload the next refill
    // backs off 60s instead of re-running every read on the next request. The
    // re-stamp keeps the original write time, so the entry still expires 2x
    // TTL after it was computed. A degraded body is written only when there is
    // no complete entry to fall back to (cold key). Consequence: a filtered
    // slice (no singleFlight) can serve numbers up to 2x its TTL old (1h)
    // while its refills keep degrading.
    keepExistingWhen: (v) => (v.degraded_sections?.length ?? 0) > 0,
    // A degraded result that IS written (cold key) is pre-aged to read as
    // expired after THREAT_AGGREGATE_DEGRADED_TTL_S, with expirationTtl 2x
    // that (120s): single-flight's stale serving can show it for ~120s at
    // most, never the slice TTL. Also the back-off length above.
    ttlFor: (v) => (v.degraded_sections?.length ? THREAT_AGGREGATE_DEGRADED_TTL_S : ttl),
  });
}
