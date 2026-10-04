// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Provider Intelligence API Endpoints

import { json } from "../lib/cors";
import type { Env } from "../types";

// GET /api/providers/stats (top providers by threat count)
export async function handleProviderStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const period = url.searchParams.get("period") ?? "today";

    const stats = await env.DB.prepare(`
      SELECT provider_name, threat_count, critical_count, high_count,
             phishing_count, malware_count, top_countries,
             trend_direction, trend_pct, computed_at
      FROM provider_threat_stats
      WHERE period = ?
      ORDER BY threat_count DESC
      LIMIT 20
    `).bind(period).all();

    let periodWhere = "created_at >= date('now', 'start of day')";
    if (period === "7d") periodWhere = "created_at >= date('now', '-7 days')";
    else if (period === "30d") periodWhere = "created_at >= date('now', '-30 days')";
    else if (period === "all") periodWhere = "1=1";

    const summary = await env.DB.prepare(`
      SELECT COUNT(DISTINCT hosting_provider_id) as total_providers,
             COUNT(*) as total_threats,
             SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical,
             SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) as high
      FROM threats WHERE hosting_provider_id IS NOT NULL AND ${periodWhere}
    `).first();

    return json({ success: true, data: { providers: stats.results, summary, period } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/providers
//
// Phase 2 of D1 spend reduction: this handler used to GROUP BY
// `hosting_provider_id` over the threats table and read ~12.6M rows
// per call (75 calls/24h = 945M rows/24h). Migrated to read from the
// `hosting_providers` table directly, which carries pre-computed
// counters: active_threat_count / total_threat_count (Cartographer's
// enrichment path) and trend_7d / trend_30d (lib/provider-trends.ts,
// NEXUS). NOTE: `trend_7d_pct` / `trend_30d_pct` in this response are
// legacy aliases that carry those raw 7d / 30d COUNTS, not percentages
// (names kept for response-contract stability).
//
// What changed in the response shape:
//   - `threat_count` now reads from total_threat_count
//   - `active_threats` from active_threat_count
//   - `first_seen` / `last_seen` derived from threat_cube_provider's
//     hour_bucket (hour-precision; UI uses relativeTime so it's
//     equivalent to the previous minute-precision threats.created_at)
//   - `high_sev` removed (was unused — confirmed by sweep of
//     averrow-ops; only brand_detail consumes high_sev, never provider
//     list)
//   - All other fields unchanged.
//
// Per CLAUDE.md §8: "use them, don't re-derive".
export async function handleListProviders(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const search = url.searchParams.get("q");

    const conditions: string[] = ["hp.total_threat_count > 0"];
    const params: unknown[] = [];
    if (search) {
      conditions.push("(hp.name LIKE ? OR hp.asn LIKE ? OR hp.id LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    params.push(limit, offset);

    const where = `WHERE ${conditions.join(" AND ")}`;

    const rows = await env.DB.prepare(`
      SELECT hp.id AS id, hp.id AS provider_id,
             COALESCE(hp.name, hp.id) AS name,
             hp.asn, hp.country AS country_code,
             hp.reputation_score, hp.avg_response_time AS avg_response_time_hours,
             hp.trend_7d AS trend_7d_pct, hp.trend_30d AS trend_30d_pct,
             hp.total_threat_count AS threat_count,
             hp.active_threat_count AS active_threats
      FROM hosting_providers hp
      ${where}
      ORDER BY hp.total_threat_count DESC LIMIT ? OFFSET ?
    `).bind(...params).all<Record<string, unknown>>();

    const provIds = (rows.results as Array<{ id: string }>).map(r => r.id);
    const sparkMap = new Map<string, number[]>();
    const seenMap = new Map<string, { first_seen: string; last_seen: string }>();
    if (provIds.length > 0) {
      try {
        const ph = provIds.map(() => '?').join(',');
        // One cube pass surfaces both daily-sparkline and first/last
        // hour_bucket. The cube has (hosting_provider_id, hour_bucket)
        // indexed so the IN-clause + range scan is cheap regardless
        // of the platform's threat row count.
        const sparkRows = await env.DB.prepare(`
          SELECT hosting_provider_id, date(hour_bucket) as day, SUM(threat_count) as daily_count
          FROM threat_cube_provider
          WHERE hour_bucket >= datetime('now', '-14 days')
            AND hosting_provider_id IN (${ph})
          GROUP BY hosting_provider_id, date(hour_bucket)
          ORDER BY hosting_provider_id, day ASC
        `).bind(...provIds).all<{ hosting_provider_id: string; day: string; daily_count: number }>();
        for (const row of sparkRows.results) {
          if (!sparkMap.has(row.hosting_provider_id)) sparkMap.set(row.hosting_provider_id, []);
          sparkMap.get(row.hosting_provider_id)!.push(row.daily_count);
        }

        const seenRows = await env.DB.prepare(`
          SELECT hosting_provider_id,
                 MIN(hour_bucket) AS first_seen,
                 MAX(hour_bucket) AS last_seen
          FROM threat_cube_provider
          WHERE hosting_provider_id IN (${ph})
          GROUP BY hosting_provider_id
        `).bind(...provIds).all<{ hosting_provider_id: string; first_seen: string; last_seen: string }>();
        for (const row of seenRows.results) {
          seenMap.set(row.hosting_provider_id, { first_seen: row.first_seen, last_seen: row.last_seen });
        }
      } catch { /* cube may not be populated yet on a fresh deploy */ }
    }
    const data = (rows.results as Array<Record<string, unknown>>).map(r => {
      const seen = seenMap.get(r.id as string);
      return {
        ...r,
        first_seen: seen?.first_seen ?? null,
        last_seen: seen?.last_seen ?? null,
        threat_history: sparkMap.get(r.id as string) ?? [],
      };
    });
    return json({ success: true, data }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/providers/:id (detail)
export async function handleGetProvider(request: Request, env: Env, providerId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const decoded = decodeURIComponent(providerId);

    // Try to get provider info from hosting_providers table
    const providerInfo = await env.DB.prepare(
      "SELECT id, name, asn, country, reputation_score, avg_response_time FROM hosting_providers WHERE id = ?"
    ).bind(decoded).first<{ id: string; name: string; asn: string | null; country: string | null; reputation_score: number | null; avg_response_time: number | null }>();

    const displayName = providerInfo?.name ?? decoded;

    // takedown_providers is the abuse-contact directory. Match by
    // case-insensitive provider name; falls back to NULL if no entry.
    // Used by Sparrow for takedown routing; exposing it here lets
    // operators see the abuse channel and SLA on the detail page.
    const abuseContact = await env.DB.prepare(
      `SELECT provider_name, provider_type, abuse_email, abuse_url, abuse_api_url,
              abuse_api_type, avg_response_hours, success_rate, notes
       FROM takedown_providers
       WHERE LOWER(provider_name) = LOWER(?) LIMIT 1`
    ).bind(displayName).first();

    const [stats, brandBreakdown, typeBreakdown] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(*) AS total_threats,
               SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_threats,
               COUNT(DISTINCT target_brand_id) AS brands_targeted,
               COUNT(DISTINCT campaign_id) AS campaigns,
               MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
        FROM threats WHERE hosting_provider_id = ?
      `).bind(decoded).first(),
      env.DB.prepare(`
        SELECT target_brand_id AS brand_id, b.name AS brand_name, COUNT(*) AS count
        FROM threats t LEFT JOIN brands b ON b.id = t.target_brand_id
        WHERE t.hosting_provider_id = ? AND t.target_brand_id IS NOT NULL
        GROUP BY target_brand_id ORDER BY count DESC LIMIT 10
      `).bind(decoded).all(),
      // Cube swap (cost-sweep 2026-05-16): threat_cube_provider has
      // (hosting_provider_id, threat_type, threat_count). Saves a
      // per-provider scan of threats on every provider-detail page.
      env.DB.prepare(`
        SELECT threat_type, SUM(threat_count) AS count
          FROM threat_cube_provider
         WHERE hosting_provider_id = ? AND threat_type != ''
         GROUP BY threat_type ORDER BY count DESC
      `).bind(decoded).all(),
    ]);

    return json({
      success: true,
      data: {
        id: decoded,
        name: displayName,
        asn: providerInfo?.asn ?? null,
        country: providerInfo?.country ?? null,
        reputation_score: providerInfo?.reputation_score ?? null,
        avg_response_time: providerInfo?.avg_response_time ?? null,
        abuse_contact: abuseContact ?? null,
        ...stats,
        brand_breakdown: brandBreakdown.results,
        type_breakdown: typeBreakdown.results,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/providers/:id/threats
export async function handleProviderDrilldown(request: Request, env: Env, provider: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    const rows = await env.DB.prepare(`
      SELECT t.id, t.threat_type, t.severity, t.status, t.malicious_domain, t.malicious_url,
             t.ip_address, t.country_code, t.target_brand_id, b.name AS brand_name,
             t.first_seen, t.last_seen, t.created_at
      FROM threats t LEFT JOIN brands b ON b.id = t.target_brand_id
      WHERE t.hosting_provider_id = ?
      ORDER BY t.created_at DESC LIMIT ? OFFSET ?
    `).bind(decodeURIComponent(provider), limit, offset).all();

    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/providers/:id/brands
export async function handleProviderBrands(request: Request, env: Env, providerId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await env.DB.prepare(`
      SELECT b.id, b.name, b.sector, COUNT(t.id) AS threat_count
      FROM threats t JOIN brands b ON b.id = t.target_brand_id
      WHERE t.hosting_provider_id = ?
      GROUP BY b.id ORDER BY threat_count DESC LIMIT 20
    `).bind(decodeURIComponent(providerId)).all();

    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/providers/:id/timeline
export async function handleProviderTimeline(request: Request, env: Env, providerId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const period = new URL(request.url).searchParams.get("period") ?? "7d";
    let bucket = "strftime('%Y-%m-%dT%H:00', created_at)";
    let since = "datetime('now', '-7 days')";
    if (period === "24h") { since = "datetime('now', '-1 day')"; }
    else if (period === "30d") { since = "datetime('now', '-30 days')"; bucket = "date(created_at)"; }
    else if (period === "90d") { since = "datetime('now', '-90 days')"; bucket = "date(created_at)"; }

    const rows = await env.DB.prepare(`
      SELECT ${bucket} AS period, COUNT(*) AS count
      FROM threats WHERE hosting_provider_id = ? AND created_at >= ${since}
      GROUP BY ${bucket} ORDER BY period ASC
    `).bind(decodeURIComponent(providerId)).all();

    const results = rows.results as Array<{ period: string; count: number }>;
    const labels = results.map(r => r.period);
    const values = results.map(r => r.count);

    return json({ success: true, data: { labels, values } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/providers/intelligence — Infrastructure Intelligence summary stats
export async function handleProviderIntelligence(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // KV cache: provider intelligence stats — cache for 5 minutes.
    const cacheKey = 'providers_intelligence';
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached), 200, origin);

    const [providerStats, clusterStats] = await Promise.all([
      env.DB.prepare(`
        SELECT
          COUNT(*) AS total_providers,
          SUM(CASE WHEN active_threat_count > 0 THEN 1 ELSE 0 END) AS active_operations,
          SUM(CASE WHEN trend_7d > 0 AND trend_30d > 0 AND trend_7d > trend_30d / 4.0 THEN 1 ELSE 0 END) AS accelerating,
          SUM(CASE WHEN trend_7d = 0 AND trend_30d > 50 THEN 1 ELSE 0 END) AS pivots_detected
        FROM hosting_providers
      `).first(),
      env.DB.prepare(`
        SELECT COUNT(*) AS total_clusters,
               SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_clusters
        FROM infrastructure_clusters
      `).first(),
    ]);

    const responseData = {
      success: true,
      data: {
        total_providers: providerStats?.total_providers ?? 0,
        active_operations: providerStats?.active_operations ?? 0,
        accelerating: providerStats?.accelerating ?? 0,
        pivots_detected: providerStats?.pivots_detected ?? 0,
        total_clusters: clusterStats?.total_clusters ?? 0,
        active_clusters: clusterStats?.active_clusters ?? 0,
      },
    };
    await env.CACHE.put(cacheKey, JSON.stringify(responseData), { expirationTtl: 300 });
    return json(responseData, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/providers/v2 — Enhanced provider list with status filtering and cluster linkage
const PROVIDERS_V2_SORTS: ReadonlySet<string> = new Set(["active_threats", "trend_7d", "trend_30d", "cooling"]);

export async function handleListProvidersV2(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const search = url.searchParams.get("q");
    const country = url.searchParams.get("country");
    const status = url.searchParams.get("status"); // active|accelerating|pivot|quiet
    // Unknown sort values collapse to the default so they share its
    // ORDER BY and its cache key instead of minting one key per typo.
    const sortParam = url.searchParams.get("sort") ?? "active_threats";
    const sort = PROVIDERS_V2_SORTS.has(sortParam) ? sortParam : "active_threats";
    const clusterId = url.searchParams.get("cluster_id");

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (search) {
      conditions.push("(hp.name LIKE ? OR hp.asn LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    if (country) {
      conditions.push("hp.country = ?");
      params.push(country);
    }
    if (status === "accelerating") {
      conditions.push("hp.trend_7d > 0 AND hp.trend_30d > 0 AND hp.trend_7d > hp.trend_30d / 4.0");
    } else if (status === "pivot") {
      conditions.push("hp.trend_7d = 0 AND hp.trend_30d > 50");
    } else if (status === "active") {
      conditions.push("hp.active_threat_count > 0");
    } else if (status === "quiet") {
      conditions.push("hp.active_threat_count = 0");
    }

    // sort=cooling — "Cooling" providers for Explore → Providers (PR-D,
    // replaces the retired /api/providers/movers "falling" list).
    //
    // hosting_providers.trend_7d / trend_30d are the rolling 7-day and
    // 30-day NEW-threat counts written by lib/provider-trends.ts from
    // threat_cube_provider (NEXUS, every 4h) — non-negative counts, not
    // deltas, so a `trend_7d < 0` filter would be empty by construction
    // (the trap that left the old movers "Cooling Down" list blank).
    // provider-trends.ts is the columns' single writer: it also zeroes
    // providers that fell out of the 30d cube window, so a provider that
    // went fully quiet doesn't linger here on stale counts. (lib/
    // snapshots.ts used to overwrite trend_7d with a day-over-week delta
    // at hour 0; removed in PR-D.)
    //
    // Cooling = the last 7 days ran BELOW the provider's 30-day weekly
    // average (trend_30d * 7/30) — the mirror of status=accelerating
    // above. `cooling_delta_7d` = trend_7d - trend_30d*7/30 (always
    // negative here); most negative first = the biggest volume drop.
    const COOLING_DELTA_SQL = "(hp.trend_7d - hp.trend_30d * 7.0 / 30.0)";
    if (sort === "cooling") {
      conditions.push(`hp.trend_30d > 0 AND ${COOLING_DELTA_SQL} < 0`);
    }

    // If filtering by cluster, get ASNs from cluster first
    let clusterAsnFilter = "";
    if (clusterId) {
      const cluster = await env.DB.prepare(
        "SELECT asns FROM infrastructure_clusters WHERE id = ?"
      ).bind(clusterId).first<{ asns: string }>();
      if (cluster?.asns) {
        try {
          const asns = JSON.parse(cluster.asns) as string[];
          if (asns.length > 0) {
            const placeholders = asns.map(() => "?").join(",");
            clusterAsnFilter = `hp.asn IN (${placeholders})`;
            conditions.push(clusterAsnFilter);
            params.push(...asns);
          }
        } catch { /* ignore parse error */ }
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let orderBy = "hp.active_threat_count DESC";
    if (sort === "trend_7d") orderBy = "hp.trend_7d DESC";
    else if (sort === "trend_30d") orderBy = "hp.trend_30d DESC";
    else if (sort === "cooling") orderBy = `${COOLING_DELTA_SQL} ASC, hp.trend_30d DESC`;

    params.push(limit, offset);

    // KV cache: provider list with 14-day sparkline subquery — cache for 5 minutes.
    // Default page loads (no search, no cluster filter, page 1) use a short cache key
    // for better hit rate. Filtered/paginated views use a full-dimension key.
    const isDefaultView = !search && !clusterId && offset === 0;
    const cacheKey = isDefaultView
      ? `providers_v2:v2:${country ?? ""}:${status ?? ""}:${sort}:${limit}`
      : `providers_v2:v2:${search ?? ""}:${country ?? ""}:${status ?? ""}:${sort}:${clusterId ?? ""}:${limit}:${offset}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached), 200, origin);

    // Use pre-computed columns on hosting_providers — no threats JOIN needed.
    const rows = await env.DB.prepare(`
      SELECT hp.id, hp.name, hp.asn, hp.country,
             hp.active_threat_count, hp.total_threat_count,
             hp.trend_7d, hp.trend_30d,
             ROUND(${COOLING_DELTA_SQL}, 1) AS cooling_delta_7d,
             hp.reputation_score, hp.avg_response_time,
             hp.is_bulletproof
      FROM hosting_providers hp
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).bind(...params).all();

    // Count total for pagination
    const countResult = await env.DB.prepare(`
      SELECT COUNT(*) AS total FROM hosting_providers hp ${where}
    `).bind(...params.slice(0, params.length - 2)).all();
    const total = (countResult.results[0] as Record<string, unknown>)?.total ?? 0;

    // Sparklines via provider cube — single bulk query instead of N correlated subqueries.
    const providerIds = (rows.results as Array<{ id: string }>).map(r => r.id);
    const sparkMap = new Map<string, number[]>();
    if (providerIds.length > 0) {
      try {
        const placeholders = providerIds.map(() => '?').join(',');
        const sparkRows = await env.DB.prepare(`
          SELECT hosting_provider_id, date(hour_bucket) as day, SUM(threat_count) as daily_count
          FROM threat_cube_provider
          WHERE hour_bucket >= datetime('now', '-14 days')
            AND hosting_provider_id IN (${placeholders})
          GROUP BY hosting_provider_id, date(hour_bucket)
          ORDER BY hosting_provider_id, day ASC
        `).bind(...providerIds).all<{ hosting_provider_id: string; day: string; daily_count: number }>();
        for (const row of sparkRows.results) {
          if (!sparkMap.has(row.hosting_provider_id)) sparkMap.set(row.hosting_provider_id, []);
          sparkMap.get(row.hosting_provider_id)!.push(row.daily_count);
        }
      } catch {
        // Cube table may not be populated yet — degrade gracefully
      }
    }
    const data = (rows.results as Array<Record<string, unknown>>).map(r => ({
      ...r,
      threat_history: sparkMap.get(r.id as string) ?? [],
    }));

    const responseData = { success: true, data, meta: { total, limit, offset } };
    await env.CACHE.put(cacheKey, JSON.stringify(responseData), { expirationTtl: 300 });
    return json(responseData, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/providers/clusters — List infrastructure clusters
export async function handleListClusters(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(50, parseInt(url.searchParams.get("limit") ?? "30", 10));

    const rows = await env.DB.prepare(`
      SELECT id, cluster_name, asns, countries, threat_count, status,
             confidence_score, agent_notes, first_detected, last_seen, last_updated
      FROM infrastructure_clusters
      ORDER BY threat_count DESC
      LIMIT ?
    `).bind(limit).all();

    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/providers/:id/clusters — Clusters linked to a provider's ASN
export async function handleProviderClusters(request: Request, env: Env, providerId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const decoded = decodeURIComponent(providerId);
    const provider = await env.DB.prepare(
      "SELECT asn FROM hosting_providers WHERE id = ?"
    ).bind(decoded).first<{ asn: string | null }>();

    if (!provider?.asn) {
      return json({ success: true, data: [] }, 200, origin);
    }

    const rows = await env.DB.prepare(`
      SELECT id, cluster_name, asns, countries, threat_count, status,
             confidence_score, agent_notes, first_detected, last_seen
      FROM infrastructure_clusters
      WHERE asns LIKE ?
      ORDER BY threat_count DESC
    `).bind(`%${provider.asn}%`).all();

    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/providers/:id/locations
export async function handleProviderLocations(request: Request, env: Env, providerId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await env.DB.prepare(`
      SELECT country_code, COUNT(*) AS count,
             AVG(CAST(lat AS REAL)) AS lat, AVG(CAST(lng AS REAL)) AS lng
      FROM threats WHERE hosting_provider_id = ? AND country_code IS NOT NULL AND country_code NOT IN ('XX','PRIV')
      GROUP BY country_code ORDER BY count DESC
    `).bind(decodeURIComponent(providerId)).all();

    const mappable = rows.results.filter((r: Record<string, unknown>) => r.lat != null && r.lng != null);
    return json({ success: true, data: mappable, totalCountries: rows.results.length }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
