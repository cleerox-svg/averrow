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
// reflect the analyst's current slice. Wrapped in cachedValue (5min).

import type { Env } from '../types';
import type { OrgScope } from '../middleware/auth';
import { cachedValue } from './cached-value';

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
  };
}

export async function threatAggregate(
  env: Env,
  filters: ThreatAggregateFilters,
  scope?: OrgScope | null,
): Promise<ThreatAggregate> {
  const { where, params, empty } = buildWhere(filters, scope);
  if (empty) return emptyAgg();

  const actorJoin = filters.actor_id
    ? `JOIN threat_actor_infrastructure tai ON tai.asn = t.asn AND tai.threat_actor_id = ?`
    : '';
  const fromClause = `FROM threats t ${actorJoin} ${where}`;
  const queryParams = filters.actor_id
    ? [filters.actor_id, ...params]
    : params;

  const scopeHash = scope ? scope.brand_ids.slice(0, 3).join(',') : 'global';
  const cacheKey = [
    'threat-agg', scopeHash,
    filters.severity ?? '', filters.type ?? '', filters.status ?? '',
    filters.source ?? '', filters.brand_id ?? '', filters.actor_id ?? '',
    filters.country ?? '', filters.since ?? '', filters.search ?? '',
  ].join(':');

  return cachedValue<ThreatAggregate>(env, cacheKey, 300, async () => {
    // Headline counts in one query
    const headline = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN t.confidence_score >= 70 THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN t.campaign_id IS NOT NULL THEN 1 ELSE 0 END) AS correlated_by_campaign,
        SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN t.status IN ('down','remediated') THEN 1 ELSE 0 END) AS addressed,
        SUM(CASE WHEN t.created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS new_24h
      ${fromClause}
    `).bind(...queryParams).first<{
      total: number; confirmed: number; correlated_by_campaign: number;
      active: number; addressed: number; new_24h: number;
    }>();

    // Attribution count
    let attributed = 0;
    if (filters.actor_id) {
      attributed = headline?.total ?? 0;
    } else {
      const attrRow = await env.DB.prepare(`
        SELECT COUNT(DISTINCT t.id) AS attributed
        FROM threats t
        JOIN threat_actor_infrastructure tai_attr ON tai_attr.asn = t.asn
        ${where}
      `).bind(...params).first<{ attributed: number }>().catch(() => null);
      attributed = attrRow?.attributed ?? 0;
    }

    const total = headline?.total ?? 0;
    const correlated = Math.max(headline?.correlated_by_campaign ?? 0, attributed);
    const active = headline?.active ?? 0;
    const addressed = headline?.addressed ?? 0;
    const remediation_rate = total > 0 ? addressed / total : 0;

    const [bySev, byType, byStatus, geo, brands, providers, actors, campaigns,
           mbCampaigns, mbActors, mbProviders, surgeTypes, surgeCampaigns] = await Promise.all([
      env.DB.prepare(`SELECT t.severity AS severity, COUNT(*) AS count ${fromClause}
                      GROUP BY t.severity ORDER BY count DESC`)
        .bind(...queryParams).all<{ severity: string; count: number }>(),
      env.DB.prepare(`SELECT t.threat_type AS type, COUNT(*) AS count ${fromClause}
                      GROUP BY t.threat_type ORDER BY count DESC LIMIT 8`)
        .bind(...queryParams).all<{ type: string; count: number }>(),
      env.DB.prepare(`SELECT t.status AS status, COUNT(*) AS count ${fromClause}
                      GROUP BY t.status ORDER BY count DESC`)
        .bind(...queryParams).all<{ status: string; count: number }>(),
      env.DB.prepare(`SELECT t.country_code AS country, COUNT(*) AS count
                      ${fromClause} ${where ? 'AND' : 'WHERE'} t.country_code IS NOT NULL AND t.country_code != 'XX'
                      GROUP BY t.country_code ORDER BY count DESC LIMIT 10`)
        .bind(...queryParams).all<{ country: string; count: number }>(),
      env.DB.prepare(`SELECT t.target_brand_id AS brand_id, b.name AS brand_name,
                             b.canonical_domain, b.logo_url, COUNT(*) AS count
                      ${fromClause}
                      JOIN brands b ON b.id = t.target_brand_id
                      GROUP BY t.target_brand_id, b.name, b.canonical_domain, b.logo_url
                      ORDER BY count DESC LIMIT 8`)
        .bind(...queryParams).all<{
          brand_id: string; brand_name: string; canonical_domain: string;
          logo_url: string | null; count: number;
        }>(),
      env.DB.prepare(`SELECT t.hosting_provider_id AS provider_id, hp.name AS name, hp.asn AS asn,
                             COUNT(*) AS count
                      ${fromClause}
                      JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
                      GROUP BY t.hosting_provider_id, hp.name, hp.asn
                      ORDER BY count DESC LIMIT 8`)
        .bind(...queryParams).all<{
          provider_id: string; name: string; asn: string | null; count: number;
        }>(),
      env.DB.prepare(`SELECT tai.threat_actor_id AS actor_id, ta.name AS actor_name,
                             COUNT(DISTINCT t.id) AS count
                      FROM threats t
                      JOIN threat_actor_infrastructure tai ON tai.asn = t.asn
                      JOIN threat_actors ta ON ta.id = tai.threat_actor_id
                      ${where}
                      GROUP BY tai.threat_actor_id, ta.name
                      ORDER BY count DESC LIMIT 6`)
        .bind(...params).all<{
          actor_id: string; actor_name: string; count: number;
        }>().catch(() => ({ results: [] as Array<{ actor_id: string; actor_name: string; count: number }> })),
      env.DB.prepare(`SELECT t.campaign_id AS campaign_id, c.name AS name, c.status AS status,
                             COUNT(*) AS threat_count, COUNT(DISTINCT t.target_brand_id) AS brand_count
                      ${fromClause}
                      JOIN campaigns c ON c.id = t.campaign_id
                      GROUP BY t.campaign_id, c.name, c.status
                      ORDER BY threat_count DESC LIMIT 6`)
        .bind(...queryParams).all<{
          campaign_id: string; name: string; status: string;
          threat_count: number; brand_count: number;
        }>().catch(() => ({ results: [] as Array<{
          campaign_id: string; name: string; status: string;
          threat_count: number; brand_count: number;
        }> })),

      // ── Multi-brand patterns (brand_count >= 2 in the slice) ──
      env.DB.prepare(`SELECT t.campaign_id AS id, c.name AS name, c.status AS status,
                             COUNT(*) AS threat_count, COUNT(DISTINCT t.target_brand_id) AS brand_count
                      ${fromClause}
                      JOIN campaigns c ON c.id = t.campaign_id
                      GROUP BY t.campaign_id, c.name, c.status
                      HAVING COUNT(DISTINCT t.target_brand_id) >= 2
                      ORDER BY brand_count DESC, threat_count DESC LIMIT 5`)
        .bind(...queryParams).all<{
          id: string; name: string; status: string;
          threat_count: number; brand_count: number;
        }>().catch(() => ({ results: [] as Array<{
          id: string; name: string; status: string;
          threat_count: number; brand_count: number;
        }> })),
      env.DB.prepare(`SELECT tai.threat_actor_id AS id, ta.name AS name,
                             COUNT(DISTINCT t.id) AS threat_count,
                             COUNT(DISTINCT t.target_brand_id) AS brand_count
                      FROM threats t
                      JOIN threat_actor_infrastructure tai ON tai.asn = t.asn
                      JOIN threat_actors ta ON ta.id = tai.threat_actor_id
                      ${where}
                      GROUP BY tai.threat_actor_id, ta.name
                      HAVING COUNT(DISTINCT t.target_brand_id) >= 2
                      ORDER BY brand_count DESC, threat_count DESC LIMIT 5`)
        .bind(...params).all<{
          id: string; name: string; threat_count: number; brand_count: number;
        }>().catch(() => ({ results: [] as Array<{
          id: string; name: string; threat_count: number; brand_count: number;
        }> })),
      env.DB.prepare(`SELECT t.hosting_provider_id AS id, hp.name AS name, hp.asn AS asn,
                             COUNT(*) AS threat_count,
                             COUNT(DISTINCT t.target_brand_id) AS brand_count
                      ${fromClause}
                      JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
                      GROUP BY t.hosting_provider_id, hp.name, hp.asn
                      HAVING COUNT(DISTINCT t.target_brand_id) >= 2
                      ORDER BY brand_count DESC, threat_count DESC LIMIT 5`)
        .bind(...queryParams).all<{
          id: string; name: string; asn: string | null;
          threat_count: number; brand_count: number;
        }>(),

      // ── Surging week-over-week: types (ignores slice's `since` for the
      //   comparison window — surge is always last 7d vs prior 7d). ──
      env.DB.prepare(`
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
      `).all<{ label: string; current_7d: number; previous_7d: number }>(),
      env.DB.prepare(`
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
      `).all<{ id: string; label: string; current_7d: number; previous_7d: number }>()
        .catch(() => ({ results: [] as Array<{
          id: string; label: string; current_7d: number; previous_7d: number;
        }> })),
    ]);

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
      multi_brand_campaigns: mbCampaigns.results ?? [],
      multi_brand_actors:    mbActors.results ?? [],
      multi_brand_providers: mbProviders.results,
      surging_signals,
      top_countries:    geo.results,
      top_brands:       brands.results,
      top_providers:    providers.results,
      top_actors:       actors.results ?? [],
      top_campaigns:    campaigns.results ?? [],
    };
  });
}
