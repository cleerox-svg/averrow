// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Dashboard API Endpoints
// Wave 2A: migrated to D1 Sessions API (read replicas)

import { json } from "../lib/cors";
import { getDbContext, getReadSession, attachBookmark } from '../lib/db';
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import type { Env } from "../types";
import type { OrgScope } from "../middleware/auth";

// GET /api/dashboard/overview
export async function handleDashboardOverview(request: Request, env: Env, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    // KV cache: dashboard overview fires 7 parallel queries — cache for 5 minutes.
    const scopeHash = scope ? scope.brand_ids.slice(0, 3).join(",") : "global";
    const cacheKey = `dashboard_overview:${scopeHash}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "dashboard_overview", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();

    // Build scope-aware threat filter
    const threatScope = scope && scope.brand_ids.length > 0
      ? { clause: `WHERE target_brand_id IN (${scope.brand_ids.map(() => "?").join(", ")})`, params: scope.brand_ids }
      : { clause: "", params: [] as string[] };
    const threatScopeAnd = scope && scope.brand_ids.length > 0
      ? { clause: `AND target_brand_id IN (${scope.brand_ids.map(() => "?").join(", ")})`, params: scope.brand_ids }
      : { clause: "", params: [] as string[] };
    const brandScope = scope && scope.brand_ids.length > 0
      ? { clause: `WHERE id IN (${scope.brand_ids.map(() => "?").join(", ")})`, params: scope.brand_ids }
      : { clause: "", params: [] as string[] };

    // If scoped with no brands, return empty
    if (scope && scope.brand_ids.length === 0) {
      return attachBookmark(json({ success: true, data: { active_threats: 0, threats_24h: 0, brands_tracked: 0, brands_new: 0, providers_tracked: 0, active_campaigns: 0, campaigns_new: 0, feed_health: { active: 0, total: 0, degraded: 0, down: 0 } } }, 200, origin), session);
    }

    const [threatCount, threatActive, threat24h, brands, providers, campaigns, feeds] = await Promise.all([
      session.prepare(`SELECT COUNT(*) AS n FROM threats ${threatScope.clause}`).bind(...threatScope.params).first<{ n: number }>(),
      session.prepare(`SELECT COUNT(*) AS n FROM threats WHERE status = 'active' ${threatScopeAnd.clause}`).bind(...threatScopeAnd.params).first<{ n: number }>().catch(() => ({ n: 0 })),
      session.prepare(`SELECT COUNT(*) AS n FROM threats WHERE created_at >= datetime('now', '-1 day') ${threatScopeAnd.clause}`).bind(...threatScopeAnd.params).first<{ n: number }>().catch(() => ({ n: 0 })),
      session.prepare(`
        SELECT COUNT(*) AS tracked,
               SUM(CASE WHEN first_seen >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS new_7d
        FROM brands ${brandScope.clause}
      `).bind(...brandScope.params).first<{ tracked: number; new_7d: number }>().catch(() => ({ tracked: 0, new_7d: 0 })),
      session.prepare(`
        SELECT COUNT(DISTINCT hosting_provider_id) AS tracked
        FROM threats WHERE hosting_provider_id IS NOT NULL ${threatScopeAnd.clause}
      `).bind(...threatScopeAnd.params).first<{ tracked: number }>().catch(() => ({ tracked: 0 })),
      session.prepare(`
        SELECT COUNT(*) AS active,
               SUM(CASE WHEN first_seen >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS new_7d
        FROM campaigns
      `).first<{ active: number; new_7d: number }>().catch(() => ({ active: 0, new_7d: 0 })),
      session.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS active
        FROM feed_configs
      `).first<{ total: number; active: number }>().catch(() => ({ total: 0, active: 0 })),
    ]);

    // Use active count if available, otherwise total count (threats may not have status='active')
    const activeThreats = (threatActive?.n ?? 0) > 0 ? (threatActive?.n ?? 0) : (threatCount?.n ?? 0);

    const data = {
      success: true,
      data: {
        active_threats: activeThreats,
        threats_24h: threat24h?.n ?? 0,
        brands_tracked: brands?.tracked ?? 0,
        brands_new: brands?.new_7d ?? 0,
        providers_tracked: providers?.tracked ?? 0,
        active_campaigns: campaigns?.active ?? 0,
        campaigns_new: campaigns?.new_7d ?? 0,
        feed_health: {
          active: feeds?.active ?? 0,
          total: feeds?.total ?? 0,
          degraded: 0,
          down: 0,
        },
      },
    };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
    // 7 parallel .first() queries — meta isn't exposed by .first(),
    // but at least record the request count + query count so the
    // attribution table flags this endpoint when traffic spikes.
    tally.queries += 7;
    recordD1Reads(env, "dashboard_overview", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// GET /api/dashboard/top-brands
export async function handleDashboardTopBrands(request: Request, env: Env, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const limit = Math.min(20, parseInt(url.searchParams.get("limit") ?? "10", 10));

    const scopeHash = scope ? scope.brand_ids.slice(0, 3).join(",") : "global";

    // KV cache — 5 min TTL
    const cacheKey = `dashboard_top_brands:${limit}:${scopeHash}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "dashboard_top_brands", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    if (scope && scope.brand_ids.length === 0) {
      return attachBookmark(json({ success: true, data: [] }, 200, origin), session);
    }

    // CLAUDE.md §8: query the pre-computed `brands.threat_count` column
    // and the threat_cube_brand for the trend, instead of LEFT JOIN-ing
    // the full threats table. Prior implementation read ~22.7M rows /
    // 24h (~3% of D1 budget) for this single endpoint. New plan:
    //   1. Inner subquery selects top-N brand IDs ordered by the
    //      pre-computed threat_count column — uses idx_brands_threat_count,
    //      a bounded index scan (~limit rows).
    //   2. Outer LEFT JOIN against threat_cube_brand is bounded to
    //      those N brand IDs and uses idx_cube_brand_id_hour.
    // Net read budget: a few thousand cube rows vs. millions from the
    // raw threats table.
    const innerScope = scope && scope.brand_ids.length > 0
      ? { clause: `WHERE id IN (${scope.brand_ids.map(() => "?").join(", ")})`, params: scope.brand_ids }
      : { clause: "", params: [] as string[] };

    const tally = newTally();
    const rows = await session.prepare(`
      SELECT b.id AS brand_id, b.name, b.sector,
             b.threat_count AS threat_count,
             ROUND(
               (CAST(COALESCE(SUM(CASE WHEN c.hour_bucket >= datetime('now', '-7 days') THEN c.threat_count ELSE 0 END), 0) AS REAL) /
                NULLIF(SUM(CASE WHEN c.hour_bucket >= datetime('now', '-14 days') AND c.hour_bucket < datetime('now', '-7 days') THEN c.threat_count ELSE 0 END), 0) - 1) * 100
             , 1) AS trend_pct
      FROM brands b
      LEFT JOIN threat_cube_brand c ON c.target_brand_id = b.id
      WHERE b.id IN (
        SELECT id FROM brands ${innerScope.clause}
        ORDER BY threat_count DESC
        LIMIT ?
      )
      GROUP BY b.id, b.name, b.sector, b.threat_count
      ORDER BY b.threat_count DESC
    `).bind(...innerScope.params, limit).all();
    addToTally(tally, rows.meta);

    const data = { success: true, data: rows.results };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
    recordD1Reads(env, "dashboard_top_brands", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// GET /api/dashboard/providers
export async function handleDashboardProviders(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const limit = Math.min(20, parseInt(url.searchParams.get("limit") ?? "10", 10));
    const sort = url.searchParams.get("sort") ?? "worst";

    if (sort === "improving") {
      // Return providers with decreasing threat counts (recent < previous period)
      const rows = await session.prepare(`
        SELECT t.hosting_provider_id AS provider_id,
               COALESCE(hp.name, t.hosting_provider_id) AS name,
               hp.asn,
               SUM(CASE WHEN t.created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS threat_count,
               SUM(CASE WHEN t.created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS recent,
               SUM(CASE WHEN t.created_at >= datetime('now', '-14 days') AND t.created_at < datetime('now', '-7 days') THEN 1 ELSE 0 END) AS previous,
               ROUND(
                 (CAST(SUM(CASE WHEN t.created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS REAL) /
                  NULLIF(SUM(CASE WHEN t.created_at >= datetime('now', '-14 days') AND t.created_at < datetime('now', '-7 days') THEN 1 ELSE 0 END), 0) - 1) * 100
               , 1) AS trend_7d_pct
        FROM threats t
        LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
        WHERE t.hosting_provider_id IS NOT NULL AND t.created_at >= datetime('now', '-14 days')
        GROUP BY t.hosting_provider_id
        HAVING previous > 0 AND recent < previous
        ORDER BY (CAST(recent AS REAL) / previous) ASC
        LIMIT ?
      `).bind(limit).all();

      return attachBookmark(json({ success: true, data: rows.results }, 200, origin), session);
    }

    // Default: worst actors (highest threat count)
    const rows = await session.prepare(`
      SELECT t.hosting_provider_id AS provider_id,
             COALESCE(hp.name, t.hosting_provider_id) AS name,
             hp.asn,
             COUNT(*) AS threat_count,
             ROUND(
               (CAST(SUM(CASE WHEN t.created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS REAL) /
                NULLIF(SUM(CASE WHEN t.created_at >= datetime('now', '-14 days') AND t.created_at < datetime('now', '-7 days') THEN 1 ELSE 0 END), 0) - 1) * 100
             , 1) AS trend_7d_pct
      FROM threats t
      LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
      WHERE t.hosting_provider_id IS NOT NULL
      GROUP BY t.hosting_provider_id
      ORDER BY threat_count DESC
      LIMIT ?
    `).bind(limit).all();

    return attachBookmark(json({ success: true, data: rows.results }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}
