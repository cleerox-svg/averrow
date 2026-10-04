// Averrow — Operations API Endpoints (NEXUS infrastructure clusters)

import { json } from "../lib/cors";
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import { cachedCount } from "../lib/cached-count";
import { cachedValue } from "../lib/cached-value";
import { hashToken } from "../lib/hash";
import type { Env } from "../types";

/**
 * KV TTL for the operations list response. Must exceed the longest
 * Navigator warm period for its warmed keys (Phase B, 15 min) — pinned by
 * test/operations-list-cache.test.ts.
 */
export const OPERATIONS_LIST_TTL_S = 1800;
/** Per-page 14-day cluster sparkline cache (cachedValue). */
export const OPERATIONS_HISTORY_TTL_S = 21_600;
/** Cluster total count (cachedCount). */
export const OPERATIONS_TOTAL_TTL_S = 3600;

/** `status` filter values the list accepts (the CASE ordering below). */
const OPERATION_STATUSES = new Set(["accelerating", "pivot", "active", "dormant"]);

/**
 * 14-day daily threat counts per cluster, oldest day first — the same
 * series the list query used to build with a correlated
 * `json_group_array` subquery per row. Days with zero threats are
 * omitted (the old GROUP BY never emitted them either) and a cluster
 * with no threats in the window gets `[]` (json_group_array over an
 * empty set). Cached per distinct page of cluster ids for 6h: the
 * sparkline is coarse and the per-cluster scan was the expensive part of
 * every list miss.
 */
async function loadClusterHistory14d(
  env: Env,
  clusterIds: string[],
): Promise<Record<string, number[]>> {
  if (clusterIds.length === 0) return {};
  const ids = Array.from(new Set(clusterIds)).sort();
  const digest = (await hashToken(ids.join(","))).slice(0, 16);
  return cachedValue<Record<string, number[]>>(
    env, `operations.history_14d:${digest}`, OPERATIONS_HISTORY_TTL_S,
    async () => {
      const ph = ids.map(() => "?").join(",");
      const res = await env.DB.prepare(`
        SELECT cluster_id, date(created_at) AS day, COUNT(*) AS n
        FROM threats
        WHERE cluster_id IN (${ph})
          AND created_at >= datetime('now', '-14 days')
        GROUP BY cluster_id, date(created_at)
        ORDER BY cluster_id, day ASC
      `).bind(...ids).all<{ cluster_id: string; day: string; n: number }>();
      const out: Record<string, number[]> = {};
      for (const r of res.results ?? []) {
        (out[r.cluster_id] ??= []).push(r.n);
      }
      return out;
    },
  );
}

// GET /api/v1/operations — List infrastructure_clusters with sort/filter
export async function handleListOperations(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") || null;
    // Unknown status values can only ever match zero clusters' documented
    // states; answer with the same empty result the filter would produce,
    // without D1 or a new KV key per arbitrary value.
    if (status !== null && !OPERATION_STATUSES.has(status)) {
      return json({ success: true, data: [], total: 0 }, 200, origin);
    }
    // Clamp both ends (NaN → default): `limit=-1` used to bind `LIMIT -1`
    // (unbounded), which would also push >100 ids into the history IN(...).
    const rawLimit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 50;
    const rawOffset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      conditions.push("ic.status = ?");
      params.push(status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    // KV cache: the operations list. TTL MUST exceed Navigator's warm
    // period for both warmed keys (Phase A every 10 min:
    // `status=active&limit=4&offset=0`; Phase B every 15 min:
    // `limit=12&offset=0` — cron/navigator.ts NAVIGATOR_WARM_TARGETS).
    // At the old 300s TTL every warm landed on an expired key, so each
    // warm was a full recompute (~154 misses/day × 2 queries).
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
             ic.actor_id, ta.name AS actor_name
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

    const clusterRows = rows.results as Array<Record<string, unknown>>;
    const clusterIds = clusterRows.map((r) => String(r.id));

    const [history, total] = await Promise.all([
      loadClusterHistory14d(env, clusterIds),
      // Cluster total — slow-moving (NEXUS writes every 4h), 1h TTL.
      cachedCount(env, `count.operations.clusters.${status ?? "all"}`, OPERATIONS_TOTAL_TTL_S, async () => {
        const r = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM infrastructure_clusters ic ${where}`
        ).bind(...params.slice(0, -2)).first<{ n: number }>();
        return r?.n ?? 0;
      }),
    ]);
    tally.queries += 1;

    const data = clusterRows.map(row => ({
      ...row,
      threat_history: history[String(row.id)] ?? [],
    }));

    const responseData = { success: true, data, total };
    await env.CACHE.put(cacheKey, JSON.stringify(responseData), { expirationTtl: OPERATIONS_LIST_TTL_S });
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
      // status='active' alone over-reports — 48% of "active" campaigns
      // have last_seen older than 7d (audit 2026-05-16). Require a recent
      // threat update to count as live.
      env.DB.prepare(
        `SELECT COUNT(*) AS total FROM campaigns
          WHERE status = 'active' AND last_seen >= datetime('now', '-7 days')`,
      ).first<{ total: number }>(),
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
    // 900s TTL outlives Navigator's 15-min Phase B warm cadence so
    // real loads hit warm cache (was 300s → expired ~67% between warms).
    await env.CACHE.put(cacheKey, JSON.stringify(responseData), { expirationTtl: 900 });
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
