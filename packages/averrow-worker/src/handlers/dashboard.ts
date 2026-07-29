// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Dashboard API Endpoints
// Wave 2A: migrated to D1 Sessions API (read replicas)

import { json } from "../lib/cors";
import { getDbContext, getReadSession, attachBookmark } from '../lib/db';
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import { cachedCount } from "../lib/cached-count";
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

    // For the unscoped (global) path, route the three full-table
    // threats COUNT(*) queries through `cachedCount` (KV-backed,
    // free of D1 reads on a hit). The diagnostic top-queries
    // report flagged these at ~127M rows / 24h combined — biggest
    // remaining D1 spend after the FC backlogs migration in
    // PR #1213. Scoped (per-tenant) requests fall through to the
    // raw queries to avoid blowing up the cache key space.
    //
    // 300s TTL: total/active/24h-count drift slowly enough that a
    // 5-min lag is invisible on a tile/dashboard surface, and the
    // outer dashboard_overview KV cache (5 min) already absorbs
    // most repeat traffic — these inner caches catch the outer-
    // cache-miss case where the same global counts get recomputed
    // by parallel cold readers. Bumped from 60s after diagnostics
    // showed each miss reading ~250K rows; at 60s the maximum
    // call rate was ~60/hour and we were still seeing 14/hour
    // burning ~88M rows / 24h. 300s caps that at 12/hour.
    // Safe to bump independently of sentinel.ts's 900s read on
    // the same key — cachedCount lets each caller pick its own
    // freshness window against the shared cached value.
    // We only reach this point when scope is null/undefined (the
    // "empty brand_ids" case short-circuited with an empty payload
    // above). When `scope` is set with N>0 brand_ids, the queries
    // are tenant-scoped and fall through to raw D1 reads — caching
    // those would blow up the KV key space.
    const useGlobalCache = !scope;

    // D1 spend-reduction: bumped TTLs from 1800s → 3600s on total/active
    // and 600s → 1800s on last_24h. These keys are shared with admin.ts
    // (which already uses 3600s for `count.threats.total`); because
    // cachedCount uses per-caller TTL for freshness checks, dashboard's
    // shorter window was rejecting admin-cached entries 1800-3600s old
    // and recomputing them — even though admin had just populated them.
    // Aligning TTLs lets dashboard accept admin's value and roughly
    // halves dashboard's compute-path entries for these keys.
    //
    // Drift cost is invisible on a homepage tile: total/active drift
    // ~1000/hour at current scale, so 60-min lag still reads as fresh.
    // last_24h is a rolling window that changes by the same rate, so
    // 30-min lag is also fine. PR-CD (priority 5 of the diagnostics
    // walk-through) — targeted bump to push `cached_count.hit_rate`
    // above 70% (was 62% in the 2026-05-23 diagnostic).
    //
    // Production audit on 2026-05-16 showed `SELECT COUNT(*) FROM
    // threats` running 263×/24h × 338K rows = 89M rows/day on the
    // 300s TTL. The 1800s bump dropped that to ~48 calls/day = 16M
    // rows. This further bump to 3600s drops it to ~24 calls/day =
    // 8M rows. Saves another ~8M rows/day ≈ 1% of plan.
    const threatCountP = useGlobalCache
      ? cachedCount(env, 'count.threats.total', 3600, async () => {
          const r = await session.prepare(`SELECT COUNT(*) AS n FROM threats`).first<{ n: number }>();
          return r?.n ?? 0;
        }).then((n) => ({ n }))
      : session.prepare(`SELECT COUNT(*) AS n FROM threats ${threatScope.clause}`)
          .bind(...threatScope.params)
          .first<{ n: number }>();

    // TTL 21600 (6h): shared `count.threats.active` key. Diagnostics
    // attributed ~41.6M rows/24h to this normalized count — the fleet was
    // recomputing it ~hourly because callers disagreed on TTL (cartographer
    // already at 6h). Aligning every frequent caller to 6h collapses the
    // recompute cadence to ~4/day. `active` (~801K, slow-moving) tolerates
    // 6h staleness on a staff headline stat; `total` above stays at 1h.
    const threatActiveP = useGlobalCache
      ? cachedCount(env, 'count.threats.active', 21600, async () => {
          const r = await session.prepare(`SELECT COUNT(*) AS n FROM threats WHERE status = 'active'`).first<{ n: number }>();
          return r?.n ?? 0;
        }).then((n) => ({ n }))
      : session.prepare(`SELECT COUNT(*) AS n FROM threats WHERE status = 'active' ${threatScopeAnd.clause}`)
          .bind(...threatScopeAnd.params)
          .first<{ n: number }>()
          .catch(() => ({ n: 0 }));

    const threat24hP = useGlobalCache
      ? cachedCount(env, 'count.threats.last_24h', 1800, async () => {
          const r = await session.prepare(`SELECT COUNT(*) AS n FROM threats WHERE created_at >= datetime('now', '-1 day')`).first<{ n: number }>();
          return r?.n ?? 0;
        }).then((n) => ({ n }))
      : session.prepare(`SELECT COUNT(*) AS n FROM threats WHERE created_at >= datetime('now', '-1 day') ${threatScopeAnd.clause}`)
          .bind(...threatScopeAnd.params)
          .first<{ n: number }>()
          .catch(() => ({ n: 0 }));

    const [threatCount, threatActive, threat24h, brands, providers, campaigns, feeds] = await Promise.all([
      threatCountP,
      threatActiveP,
      threat24hP,
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
        SELECT SUM(CASE WHEN status = 'active' AND last_seen >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS active,
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
      // CLAUDE.md §8 hot-path (T1): was a full-table GROUP BY
      // hosting_provider_id over the raw threats table. Mirrors
      // providers.ts handleImprovingProviders — the 7d-vs-prior-7d
      // inflow delta comes from threat_cube_provider (active-only,
      // created_at hour buckets; the 14-day window is well inside
      // cube retention). hosting_providers is joined for name/asn only.
      const cubeRows = await session.prepare(`
        SELECT hosting_provider_id,
               SUM(CASE WHEN hour_bucket >= datetime('now', '-7 days') THEN threat_count ELSE 0 END) AS recent,
               SUM(CASE WHEN hour_bucket >= datetime('now', '-14 days') AND hour_bucket < datetime('now', '-7 days') THEN threat_count ELSE 0 END) AS previous
        FROM threat_cube_provider
        WHERE hour_bucket >= datetime('now', '-14 days')
        GROUP BY hosting_provider_id
        HAVING previous > 0 AND recent < previous
        ORDER BY (CAST(recent AS REAL) / previous) ASC
        LIMIT ?
      `).bind(limit).all<{ hosting_provider_id: string; recent: number; previous: number }>();

      const provIds = cubeRows.results.map(r => r.hosting_provider_id);
      const nameMap = new Map<string, { name: string | null; asn: string | null }>();
      if (provIds.length > 0) {
        const ph = provIds.map(() => "?").join(",");
        const meta = await session.prepare(
          `SELECT id, name, asn FROM hosting_providers WHERE id IN (${ph})`,
        ).bind(...provIds).all<{ id: string; name: string | null; asn: string | null }>();
        for (const m of meta.results) nameMap.set(m.id, { name: m.name, asn: m.asn });
      }

      const data = cubeRows.results.map(r => {
        const m = nameMap.get(r.hosting_provider_id);
        const trend = r.previous > 0 ? Math.round(((r.recent / r.previous) - 1) * 1000) / 10 : 0;
        return {
          provider_id: r.hosting_provider_id,
          name: m?.name ?? r.hosting_provider_id,
          asn: m?.asn ?? null,
          threat_count: r.recent,
          recent: r.recent,
          previous: r.previous,
          trend_7d_pct: trend,
        };
      });

      return attachBookmark(json({ success: true, data }, 200, origin), session);
    }

    // Default: worst actors (highest all-time threat count).
    // CLAUDE.md §8 hot-path (T1): was a full-table GROUP BY
    // hosting_provider_id over the raw threats table. `threat_count`
    // now reads the pre-computed hosting_providers.total_threat_count
    // (all-time, all-status — the exact intent of the old COUNT(*)).
    // trend_7d_pct is recomputed from threat_cube_provider for the
    // top-N rows only (a bounded cube read, not a full-table scan) so
    // it stays a genuine percentage — hosting_providers.trend_7d holds
    // a raw 7d COUNT, not a pct, so it can't be aliased directly.
    const worst = await session.prepare(`
      SELECT hp.id AS provider_id,
             COALESCE(hp.name, hp.id) AS name,
             hp.asn,
             hp.total_threat_count AS threat_count
      FROM hosting_providers hp
      WHERE hp.total_threat_count > 0
      ORDER BY hp.total_threat_count DESC
      LIMIT ?
    `).bind(limit).all<{ provider_id: string; name: string; asn: string | null; threat_count: number }>();

    const worstIds = worst.results.map(r => r.provider_id);
    const trendMap = new Map<string, { recent: number; previous: number }>();
    if (worstIds.length > 0) {
      const ph = worstIds.map(() => "?").join(",");
      const trendRows = await session.prepare(`
        SELECT hosting_provider_id,
               SUM(CASE WHEN hour_bucket >= datetime('now', '-7 days') THEN threat_count ELSE 0 END) AS recent,
               SUM(CASE WHEN hour_bucket >= datetime('now', '-14 days') AND hour_bucket < datetime('now', '-7 days') THEN threat_count ELSE 0 END) AS previous
        FROM threat_cube_provider
        WHERE hour_bucket >= datetime('now', '-14 days')
          AND hosting_provider_id IN (${ph})
        GROUP BY hosting_provider_id
      `).bind(...worstIds).all<{ hosting_provider_id: string; recent: number; previous: number }>();
      for (const r of trendRows.results) {
        trendMap.set(r.hosting_provider_id, { recent: r.recent, previous: r.previous });
      }
    }

    const worstData = worst.results.map(r => {
      const t = trendMap.get(r.provider_id);
      const trend = t && t.previous > 0
        ? Math.round(((t.recent / t.previous) - 1) * 1000) / 10
        : null;
      return {
        provider_id: r.provider_id,
        name: r.name,
        asn: r.asn,
        threat_count: r.threat_count,
        trend_7d_pct: trend,
      };
    });

    return attachBookmark(json({ success: true, data: worstData }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}
