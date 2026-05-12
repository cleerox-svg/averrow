// Averrow — Operations API Endpoints (NEXUS infrastructure clusters)

import { json } from "../lib/cors";
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import type { Env } from "../types";

// GET /api/v1/operations — List infrastructure_clusters with sort/filter
export async function handleListOperations(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status"); // accelerating|pivot|active|dormant
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      conditions.push("ic.status = ?");
      params.push(status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    // KV cache: operations list with 14-day subquery — cache for 5 minutes.
    const cacheKey = `operations_list:${status ?? "all"}:${limit}:${offset}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "operations_list", newTally());
      return json(JSON.parse(cached), 200, origin);
    }
    const tally = newTally();

    const rows = await env.DB.prepare(`
      SELECT ic.id, ic.cluster_name, ic.asns, ic.countries, ic.threat_count,
             ic.status, ic.confidence_score, ic.agent_notes,
             ic.first_detected, ic.last_seen, ic.last_updated,
             ic.actor_id, ta.name AS actor_name,
             (
               SELECT json_group_array(daily_count)
               FROM (
                 SELECT COUNT(*) as daily_count
                 FROM threats t2
                 WHERE t2.cluster_id = ic.id
                   AND t2.created_at >= datetime('now', '-14 days')
                 GROUP BY date(t2.created_at)
                 ORDER BY date(t2.created_at) ASC
               )
             ) as threat_history_json
      FROM infrastructure_clusters ic
      LEFT JOIN threat_actors ta ON ta.id = ic.actor_id
      ${where}
      ORDER BY
        CASE ic.status
          WHEN 'accelerating' THEN 0
          WHEN 'pivot' THEN 1
          WHEN 'active' THEN 2
          ELSE 3
        END,
        ic.threat_count DESC
      LIMIT ? OFFSET ?
    `).bind(...params).all();
    addToTally(tally, rows.meta);

    const total = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM infrastructure_clusters ic ${where}`
    ).bind(...params.slice(0, -2)).first<{ n: number }>();
    tally.queries += 1;

    const data = (rows.results as Array<Record<string, unknown>>).map(row => ({
      ...row,
      threat_history: row.threat_history_json
        ? JSON.parse(row.threat_history_json as string)
        : undefined,
      threat_history_json: undefined,
    }));

    const responseData = { success: true, data, total: total?.n ?? 0 };
    await env.CACHE.put(cacheKey, JSON.stringify(responseData), { expirationTtl: 300 });
    recordD1Reads(env, "operations_list", tally);
    return json(responseData, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/v1/operations/stats — Aggregated stats for the Operations page header
export async function handleOperationsStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // KV cache: 4 parallel queries — cache for 5 minutes.
    const cacheKey = 'operations_stats';
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "operations_stats", newTally());
      return json(JSON.parse(cached), 200, origin);
    }
    const tally = newTally();

    const [clusterStats, campaignStats, brandStats, typeStats] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN status = 'accelerating' THEN 1 ELSE 0 END) AS accelerating,
               SUM(CASE WHEN status = 'dormant' THEN 1 ELSE 0 END) AS dormant
        FROM infrastructure_clusters
      `).first(),
      env.DB.prepare(`SELECT COUNT(*) AS total FROM campaigns WHERE status = 'active'`).first<{ total: number }>(),
      env.DB.prepare(`
        SELECT COUNT(DISTINCT target_brand_id) AS brands_targeted FROM threat_cube_brand
      `).first<{ brands_targeted: number }>(),
      env.DB.prepare(`
        SELECT COUNT(DISTINCT threat_type) AS threat_types FROM threat_cube_status
        WHERE status = 'active' AND threat_type != 'unknown'
      `).first<{ threat_types: number }>(),
    ]);
    // 4 .first() queries — meta unavailable, all cube-served.
    // brands_targeted reads brand cube (already filters status='active');
    // threat_types reads status cube with explicit status='active' filter.
    tally.queries += 4;

    const responseData = {
      success: true,
      data: {
        active_operations: clusterStats?.active ?? 0,
        accelerating: clusterStats?.accelerating ?? 0,
        total_clusters: clusterStats?.total ?? 0,
        campaigns_tracked: campaignStats?.total ?? 0,
        brands_targeted: brandStats?.brands_targeted ?? 0,
        threat_types: typeStats?.threat_types ?? 0,
      },
    };
    await env.CACHE.put(cacheKey, JSON.stringify(responseData), { expirationTtl: 300 });
    recordD1Reads(env, "operations_stats", tally);
    return json(responseData, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/v1/operations/:id/timeline — 30-day threat timeline for a cluster
export async function handleOperationTimeline(request: Request, env: Env, clusterId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Get ASNs for this cluster
    const cluster = await env.DB.prepare(
      "SELECT asns FROM infrastructure_clusters WHERE id = ?"
    ).bind(clusterId).first<{ asns: string }>();

    if (!cluster?.asns) {
      return json({ success: true, data: { labels: [], values: [] } }, 200, origin);
    }

    let asns: string[];
    try {
      asns = JSON.parse(cluster.asns) as string[];
    } catch {
      return json({ success: true, data: { labels: [], values: [] } }, 200, origin);
    }

    if (asns.length === 0) {
      return json({ success: true, data: { labels: [], values: [] } }, 200, origin);
    }

    const placeholders = asns.map(() => "?").join(",");

    const rows = await env.DB.prepare(`
      SELECT date(first_seen) AS period, COUNT(*) AS count
      FROM threats t
      JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
      WHERE hp.asn IN (${placeholders})
        AND t.first_seen >= datetime('now', '-30 days')
      GROUP BY date(first_seen)
      ORDER BY period ASC
    `).bind(...asns).all();

    const results = rows.results as Array<{ period: string; count: number }>;
    return json({
      success: true,
      data: { labels: results.map(r => r.period), values: results.map(r => r.count) },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/v1/operations/:id/threats — Recent threats for a cluster
export async function handleOperationThreats(request: Request, env: Env, clusterId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "10", 10));

    const cluster = await env.DB.prepare(
      "SELECT asns FROM infrastructure_clusters WHERE id = ?"
    ).bind(clusterId).first<{ asns: string }>();

    if (!cluster?.asns) {
      return json({ success: true, data: [] }, 200, origin);
    }

    let asns: string[];
    try {
      asns = JSON.parse(cluster.asns) as string[];
    } catch {
      return json({ success: true, data: [] }, 200, origin);
    }

    if (asns.length === 0) {
      return json({ success: true, data: [] }, 200, origin);
    }

    const placeholders = asns.map(() => "?").join(",");

    const rows = await env.DB.prepare(`
      SELECT t.id, t.threat_type, t.severity, t.status, t.malicious_domain,
             t.ip_address, t.country_code, t.first_seen, t.last_seen,
             b.name AS brand_name
      FROM threats t
      LEFT JOIN brands b ON b.id = t.target_brand_id
      JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
      WHERE hp.asn IN (${placeholders})
      ORDER BY t.first_seen DESC
      LIMIT ?
    `).bind(...asns, limit).all();

    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
