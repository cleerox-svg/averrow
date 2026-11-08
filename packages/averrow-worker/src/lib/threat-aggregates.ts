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
// 3h + single-flight refill for the unfiltered, unscoped slice).

import type { Env } from '../types';
import type { OrgScope } from '../middleware/auth';
import { cachedValue } from './cached-value';
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
 * KV TTL for a DEGRADED aggregate (one or more section reads failed, see
 * `degraded_sections`). Short so the next page view retries the failed reads
 * soon, yet long enough that an overloaded D1 isn't hit with a full refill on
 * every view. cachedValue's `ttlFor` writes it with `expirationTtl` 2× this
 * (120s), which also bounds how long single-flight can serve it stale.
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

  /**
   * Sections whose read failed and hold their empty fallback instead of data
   * (`headline`, `attribution`, `by_severity`, `by_type`, `by_status`,
   * `top_countries`, `top_brands`, `top_providers`, `top_actors`,
   * `top_campaigns`, `multi_brand`, `surging`). Omitted when every read
   * succeeded. `headline` here means the headline numbers are zeros because
   * they could not be read — not a real empty slice. Cached only
   * THREAT_AGGREGATE_DEGRADED_TTL_S.
   */
  degraded_sections?: string[];
}

/** Section names the aggregate can report in `degraded_sections`. */
export type ThreatAggregateSection =
  | 'headline' | 'attribution' | 'by_severity' | 'by_type' | 'by_status'
  | 'top_countries' | 'top_brands' | 'top_providers' | 'top_actors'
  | 'top_campaigns' | 'multi_brand' | 'surging';

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
    // Every read is fail-soft (lib/run-sequential.ts `softSection`): a
    // `D1 DB is overloaded` / timeout on one query degrades that section to
    // its empty fallback and names it in `degraded_sections`, instead of
    // throwing the whole aggregate into a 500 (prod 2026-11-08: every hero
    // tile + the Coordination panel showed "Couldn't load", and nothing was
    // cached, so each page view re-ran the full refill).
    const errors: SectionErrors = {};
    const soft = <T>(section: ThreatAggregateSection, fallback: T, fn: () => Promise<T>) =>
      softSection(errors, section, fallback, fn);
    /** `.all()` rows of one section, `[]` when the read fails. */
    const rows = <R>(section: ThreatAggregateSection, stmt: () => D1PreparedStatement) =>
      soft<R[]>(section, [], async () => (await stmt().all<R>()).results ?? []);

    type HeadlineRow = {
      total: number; confirmed: number; correlated_by_campaign: number;
      active: number; addressed: number; new_24h: number;
    };
    type BrandRow = {
      brand_id: string; brand_name: string; canonical_domain: string;
      logo_url: string | null; count: number;
    };
    type ProviderRow = { provider_id: string; name: string; asn: string | null; count: number };
    type CampaignRow = {
      campaign_id: string; name: string; status: string;
      threat_count: number; brand_count: number;
    };
    type SurgeRow = { label: string; current_7d: number; previous_7d: number };

    // Headline counts in one query
    const headline = await soft<HeadlineRow | null>('headline', null, () => db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN t.confidence_score >= 70 THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN t.campaign_id IS NOT NULL THEN 1 ELSE 0 END) AS correlated_by_campaign,
        SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN t.status IN ('down','remediated') THEN 1 ELSE 0 END) AS addressed,
        SUM(CASE WHEN t.created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS new_24h
      ${fromClause}
    `).bind(...queryParams).first<HeadlineRow>())();

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
      const attrRow = await soft<{ attributed: number } | null>('attribution', null, () => db.prepare(`
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

    // Unfiltered slice: only top_brands / top_providers have a pre-computed
    // source of the same all-time, all-status quantity (maintained
    // counters, so they can lag the live table by hours). The rest stay on
    // threats:
    //  - by_severity / by_status: threat_cube_status has the right
    //    dimensions but only covers rebuilt hour buckets (healed 2d/14d, see
    //    handlers/public.ts — its SUM under-counts the all-time total), and
    //    it maps NULL severity/status to 'unknown'.
    //  - top_countries: threat_cube_geo is status='active' + lat/lng only.
    //  - campaigns / actors / multi-brand rows: no pre-computed source
    //    (multi_brand_providers needs COUNT(DISTINCT target_brand_id) per
    //    provider; no cube carries provider × brand).
    const [bySev, byType, byStatus, geo, brands, providers, actors, campaigns,
           mbCampaigns, mbActors, mbProviders, surgeTypes, surgeCampaigns] = await runSequential([
      rows<{ severity: string; count: number }>('by_severity', () => db.prepare(`SELECT t.severity AS severity, COUNT(*) AS count ${fromClause}
                      GROUP BY t.severity ORDER BY count DESC`)
        .bind(...queryParams)),
      rows<{ type: string; count: number }>('by_type', () => db.prepare(`SELECT t.threat_type AS type, COUNT(*) AS count ${fromClause}
                      GROUP BY t.threat_type ORDER BY count DESC LIMIT 8`)
        .bind(...queryParams)),
      rows<{ status: string; count: number }>('by_status', () => db.prepare(`SELECT t.status AS status, COUNT(*) AS count ${fromClause}
                      GROUP BY t.status ORDER BY count DESC`)
        .bind(...queryParams)),
      rows<{ country: string; count: number }>('top_countries', () => db.prepare(`SELECT t.country_code AS country, COUNT(*) AS count
                      ${fromClause} ${sliceWhere ? 'AND' : 'WHERE'} t.country_code IS NOT NULL AND t.country_code != 'XX'
                      GROUP BY t.country_code ORDER BY count DESC LIMIT 10`)
        .bind(...queryParams)),
      // Unfiltered: brands.threat_count is COUNT(*) of ALL linked threats,
      // every status (lib/brand-count-reconciler.ts, 6-hourly + incremental
      // bumps) — the same quantity this GROUP BY computes for an empty
      // slice, but NOT live: some brand-link writers skip the incremental
      // bump, so a count can lag by up to the 6h reconcile.
      // idx_brands_threat_count serves the ORDER BY … LIMIT.
      rows<BrandRow>('top_brands', () => (unfiltered
        ? db.prepare(`SELECT b.id AS brand_id, b.name AS brand_name,
                             b.canonical_domain, b.logo_url, b.threat_count AS count
                      FROM brands b
                      WHERE b.threat_count > 0
                      ORDER BY b.threat_count DESC LIMIT 8`)
        : db.prepare(`SELECT t.target_brand_id AS brand_id, b.name AS brand_name,
                             b.canonical_domain, b.logo_url, COUNT(*) AS count
                      ${fromWith('JOIN brands b ON b.id = t.target_brand_id')}
                      GROUP BY t.target_brand_id, b.name, b.canonical_domain, b.logo_url
                      ORDER BY count DESC LIMIT 8`).bind(...queryParams))),
      // Unfiltered: hosting_providers.total_threat_count is COUNT(*) of
      // threats on the provider, every status (lib/provider-counts.ts,
      // enrichment Stage 5 every 4h) — same quantity as the GROUP BY for an
      // empty slice but up to ~4h behind it (no incremental writer), and
      // what /api/dashboard's worst-providers already reads.
      // ~20K-row provider scan instead of a ~1.84M-row threats GROUP BY.
      rows<ProviderRow>('top_providers', () => (unfiltered
        ? db.prepare(`SELECT hp.id AS provider_id, hp.name AS name, hp.asn AS asn,
                             hp.total_threat_count AS count
                      FROM hosting_providers hp
                      WHERE hp.total_threat_count > 0
                      ORDER BY hp.total_threat_count DESC LIMIT 8`)
        : db.prepare(`SELECT t.hosting_provider_id AS provider_id, hp.name AS name, hp.asn AS asn,
                             COUNT(*) AS count
                      ${fromWith('JOIN hosting_providers hp ON hp.id = t.hosting_provider_id')}
                      GROUP BY t.hosting_provider_id, hp.name, hp.asn
                      ORDER BY count DESC LIMIT 8`).bind(...queryParams))),
      rows<{ actor_id: string; actor_name: string; count: number }>('top_actors', () => db.prepare(`SELECT tai.threat_actor_id AS actor_id, ta.name AS actor_name,
                             COUNT(DISTINCT t.id) AS count
                      FROM threats t
                      JOIN threat_actor_infrastructure tai ON tai.asn = t.asn
                      JOIN threat_actors ta ON ta.id = tai.threat_actor_id
                      ${where}
                      GROUP BY tai.threat_actor_id, ta.name
                      ORDER BY count DESC LIMIT 6`)
        .bind(...params)),
      rows<CampaignRow>('top_campaigns', () => db.prepare(`SELECT t.campaign_id AS campaign_id, c.name AS name, c.status AS status,
                             COUNT(*) AS threat_count, COUNT(DISTINCT t.target_brand_id) AS brand_count
                      ${fromWith('JOIN campaigns c ON c.id = t.campaign_id')}
                      GROUP BY t.campaign_id, c.name, c.status
                      ORDER BY threat_count DESC LIMIT 6`)
        .bind(...queryParams)),

      // ── Multi-brand patterns (brand_count >= 2 in the slice) ──
      rows<{
        id: string; name: string; status: string;
        threat_count: number; brand_count: number;
      }>('multi_brand', () => db.prepare(`SELECT t.campaign_id AS id, c.name AS name, c.status AS status,
                             COUNT(*) AS threat_count, COUNT(DISTINCT t.target_brand_id) AS brand_count
                      ${fromWith('JOIN campaigns c ON c.id = t.campaign_id')}
                      GROUP BY t.campaign_id, c.name, c.status
                      HAVING COUNT(DISTINCT t.target_brand_id) >= 2
                      ORDER BY brand_count DESC, threat_count DESC LIMIT 5`)
        .bind(...queryParams)),
      rows<{
        id: string; name: string; threat_count: number; brand_count: number;
      }>('multi_brand', () => db.prepare(`SELECT tai.threat_actor_id AS id, ta.name AS name,
                             COUNT(DISTINCT t.id) AS threat_count,
                             COUNT(DISTINCT t.target_brand_id) AS brand_count
                      FROM threats t
                      JOIN threat_actor_infrastructure tai ON tai.asn = t.asn
                      JOIN threat_actors ta ON ta.id = tai.threat_actor_id
                      ${where}
                      GROUP BY tai.threat_actor_id, ta.name
                      HAVING COUNT(DISTINCT t.target_brand_id) >= 2
                      ORDER BY brand_count DESC, threat_count DESC LIMIT 5`)
        .bind(...params)),
      rows<{
        id: string; name: string; asn: string | null;
        threat_count: number; brand_count: number;
      }>('multi_brand', () => db.prepare(`SELECT t.hosting_provider_id AS id, hp.name AS name, hp.asn AS asn,
                             COUNT(*) AS threat_count,
                             COUNT(DISTINCT t.target_brand_id) AS brand_count
                      ${fromWith('JOIN hosting_providers hp ON hp.id = t.hosting_provider_id')}
                      GROUP BY t.hosting_provider_id, hp.name, hp.asn
                      HAVING COUNT(DISTINCT t.target_brand_id) >= 2
                      ORDER BY brand_count DESC, threat_count DESC LIMIT 5`)
        .bind(...queryParams)),

      // ── Surging week-over-week: types (ignores slice's `since` for the
      //   comparison window — surge is always last 7d vs prior 7d). ──
      rows<SurgeRow>('surging', () => db.prepare(`
        SELECT
          t.threat_type AS label,
          SUM(CASE WHEN t.created_at >= datetime('now','-7 days')  THEN 1 ELSE 0 END) AS current_7d,
          SUM(CASE WHEN t.created_at <  datetime('now','-7 days')
                AND t.created_at >= datetime('now','-14 days') THEN 1 ELSE 0 END) AS previous_7d
        FROM threats t
        WHERE t.created_at >= datetime('now','-14 days')
        GROUP BY t.threat_type
        HAVING current_7d > 0
        ORDER BY (current_7d - previous_7d) DESC
        LIMIT 5
      `)),
      rows<SurgeRow & { id: string }>('surging', () => db.prepare(`
        SELECT
          t.campaign_id AS id, c.name AS label,
          SUM(CASE WHEN t.created_at >= datetime('now','-7 days')  THEN 1 ELSE 0 END) AS current_7d,
          SUM(CASE WHEN t.created_at <  datetime('now','-7 days')
                AND t.created_at >= datetime('now','-14 days') THEN 1 ELSE 0 END) AS previous_7d
        FROM threats t
        JOIN campaigns c ON c.id = t.campaign_id
        WHERE t.created_at >= datetime('now','-14 days')
        GROUP BY t.campaign_id, c.name
        HAVING current_7d > 0
        ORDER BY (current_7d - previous_7d) DESC
        LIMIT 5
      `)),
    ]);

    // Compose surging signals from type + campaign rows
    const surgeFromTypes = surgeTypes.map(r => ({
      kind: 'type' as const,
      label: r.label,
      current_7d: r.current_7d,
      previous_7d: r.previous_7d,
      delta_pct: r.previous_7d > 0
        ? Math.round(((r.current_7d - r.previous_7d) / r.previous_7d) * 100)
        : (r.current_7d > 0 ? 100 : 0),
    }));
    const surgeFromCampaigns = surgeCampaigns.map(r => ({
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

    // Section names in the order their reads failed (`<section>_error` keys).
    // Only the names are returned; the per-section error messages in
    // `errors` are DISCARDED. There is no cheap sink for them today: the AE
    // dataset (lib/analytics.ts) is the D1-attribution dataset whose
    // diagnostics queries GROUP BY blob1 and SUM the doubles, so event
    // points would surface as phantom endpoints, and console.log is banned
    // in production paths. Reproduce a failure through the read itself.
    const degraded = Object.keys(errors).map((k) => k.replace(/_error$/, ''));

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
      by_severity:      bySev,
      by_type:          byType,
      by_status:        byStatus,
      multi_brand_campaigns: mbCampaigns,
      multi_brand_actors:    mbActors,
      multi_brand_providers: mbProviders,
      surging_signals,
      top_countries:    geo,
      top_brands:       brands,
      top_providers:    providers,
      top_actors:       actors,
      top_campaigns:    campaigns,
      ...(degraded.length > 0 ? { degraded_sections: degraded } : {}),
    };
  }, {
    singleFlight,
    // Never replace a complete entry (fresh or stale — unfiltered entries
    // stay in KV up to 6h) with a degraded refill: return the older complete
    // numbers and leave the entry as it is. A degraded body is written only
    // when there is no complete entry to fall back to (cold key).
    keepExistingWhen: (value) => (value.degraded_sections?.length ?? 0) > 0,
    // A degraded result is cached briefly so the failed reads are retried
    // soon. cachedValue backdates its stamp so it reads as expired after
    // THREAT_AGGREGATE_DEGRADED_TTL_S, and writes it with expirationTtl
    // 2× that (120s): single-flight's stale serving (which reuses any entry
    // still in KV) can therefore show a degraded body for at most ~120s,
    // never the 6h a normal unfiltered entry lives. (With keepExistingWhen
    // this only applies when no complete entry exists.)
    ttlFor: (value) => (value.degraded_sections?.length
      ? THREAT_AGGREGATE_DEGRADED_TTL_S
      : ttl),
  });
}
