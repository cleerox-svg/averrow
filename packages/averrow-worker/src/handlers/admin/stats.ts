// Averrow — Admin handlers: stats
// Split from handlers/admin.ts (S3.4a). Behavior-preserving move.

import { z } from "zod";
import { json, corsHeaders } from "../../lib/cors";
import { audit } from "../../lib/audit";
import type { Env, UserRole, UserStatus } from "../../types";
import { runSyncAgent } from "../../lib/agentRunner";
import { adminClassifyAgent, type AdminClassifyOutput } from "../../agents/admin-classify";
import { callAnthropicJSON } from "../../lib/anthropic";
import { estimateCost } from "../../lib/budgetManager";
import { HOT_PATH_HAIKU } from "../../lib/ai-models";
import { enrichThreatsGeo, PRIVATE_IP_SQL_FILTER } from "../../lib/geoip";
import { fuzzyMatchBrand } from "../../lib/brandDetect";
import { cachedCount } from "../../lib/cached-count";
import { cachedValue } from "../../lib/cached-value";
import { getReadSession, getDbContext } from "../../lib/db";
import { computeFeedSeverity } from "../../lib/feed-severity";
import type { AuthContext } from "../../middleware/auth";
import { classifySaasTechnique } from "../../lib/saas-classifier";
import { BudgetManager, type BudgetStatus } from "../../lib/budgetManager";
import {
  buildGeoCubeForHour,
  buildProviderCubeForHour,
  buildBrandCubeForHour,
  buildStatusCubeForHour,
  buildArcsCubeForHour,
  countGeoCubeForHour,
  countProviderCubeForHour,
  countBrandCubeForHour,
  countStatusCubeForHour,
  countArcsCubeForHour,
} from "../../lib/cube-builder";


export async function handleAdminStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  // KV cache: dashboard stats are expensive (10 COUNT queries) but tolerate 5 min staleness
  const cacheKey = "dashboard_stats";
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  // Route per-query COUNTs through the shared KV-backed cachedCount helper
  // so every cache hit shaves a full-table scan off the threats table
  // without spending a D1 read on the cache lookup itself. 15-min TTL is
  // fine — dashboard tolerates several-minute staleness on these counters.
  // Migrated from system_metrics-backed getOrComputeMetric (D1) to KV in
  // the Phase 1 D1 spend-reduction sweep.
  const adminCachedCount = async (key: string, ttl: number, sql: string): Promise<{ n: number }> => {
    const n = await cachedCount(env, key, ttl, async () => {
      const r = await env.DB.prepare(sql).first<{ n: number }>();
      return r?.n ?? 0;
    });
    return { n };
  };

  const [users, threatsTotal, threatsActive, sessions, sentinelBacklog, analystBacklog, cartoBacklog, strategistBacklog, observerLastRun, aiAttrPending, trancoCount] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN role = 'super_admin' THEN 1 ELSE 0 END) AS super_admins,
              SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
              SUM(CASE WHEN role = 'analyst' THEN 1 ELSE 0 END) AS analysts,
              SUM(CASE WHEN role = 'client' THEN 1 ELSE 0 END) AS clients,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
       FROM users`,
    ).first<{ total: number; super_admins: number; admins: number; analysts: number; clients: number; active: number }>(),
    // PR-V: keys aligned with the canonical `count.threats.*` namespace
    // used by sentinel/dashboard/stats/public-stats. Previously admin used
    // its own `admin.threats_*` keys with 900s TTL — same query, same
    // value, but a duplicate cache population. Sharing keys gives the
    // admin dashboard whichever value is freshest across all callers
    // and eliminates one compute path per TTL window.
    adminCachedCount('count.threats.total', 3600, "SELECT COUNT(*) AS n FROM threats"),
    // TTL aligned to 3600s to match every other caller of this shared
    // key (dashboard.ts, cartographer.ts). A shorter TTL here rejected
    // entries the 3600s callers had warmed, forcing a ~488K-row recompute
    // on each admin load and dragging the global cached_count hit_rate
    // below the 70% target. Same fix already applied to count.threats.total above.
    adminCachedCount('count.threats.active', 3600, "SELECT COUNT(*) AS n FROM threats WHERE status = 'active'"),
    env.DB.prepare(
      "SELECT COUNT(*) AS active_sessions FROM sessions WHERE expires_at > datetime('now') AND revoked_at IS NULL",
    ).first<{ active_sessions: number }>(),
    // Agent backlogs — admin-specific shapes, keep their own keys.
    adminCachedCount('count.threats.sentinel_backlog', 900, "SELECT COUNT(*) AS n FROM threats WHERE status = 'active' AND created_at > datetime('now', '-1 hour')"),
    adminCachedCount('count.threats.analyst_backlog', 900, "SELECT COUNT(*) AS n FROM threats WHERE status = 'active' AND severity IS NULL"),
    adminCachedCount('count.threats.cartographer_backlog', 900, "SELECT COUNT(*) AS n FROM threats WHERE status = 'active' AND ip_address IS NOT NULL AND lat IS NULL"),
    adminCachedCount('count.threats.strategist_backlog', 900, "SELECT COUNT(*) AS n FROM threats WHERE status = 'active' AND campaign_id IS NULL AND threat_type IN ('phishing','typosquatting')"),
    env.DB.prepare(
      "SELECT MAX(created_at) AS last_run FROM agent_outputs WHERE agent_id = 'observer' AND type != 'diagnostic'",
    ).first<{ last_run: string | null }>().catch(() => null),
    adminCachedCount('count.threats.ai_attr_pending', 900, "SELECT COUNT(*) AS n FROM threats WHERE target_brand_id IS NULL AND threat_type IN ('phishing','credential_harvesting','typosquatting','impersonation')").catch(() => null),
    adminCachedCount('count.brands.total', 3600, "SELECT COUNT(*) AS n FROM brands").catch(() => null),
  ]);

  const threats = { total: threatsTotal.n, active_threats: threatsActive.n };

  const data = {
    success: true,
    data: {
      users: {
        total: users?.total ?? 0,
        super_admins: users?.super_admins ?? 0,
        admins: users?.admins ?? 0,
        analysts: users?.analysts ?? 0,
        clients: users?.clients ?? 0,
        active: users?.active ?? 0,
      },
      threats: { total: threats?.total ?? 0, active: threats?.active_threats ?? 0 },
      sessions: { active: sessions?.active_sessions ?? 0 },
      agent_backlogs: {
        sentinel: sentinelBacklog?.n ?? 0,
        analyst: analystBacklog?.n ?? 0,
        cartographer: cartoBacklog?.n ?? 0,
        strategist: strategistBacklog?.n ?? 0,
        observer_last_run: observerLastRun?.last_run ?? null,
      },
      ai_attribution_pending: aiAttrPending?.n ?? 0,
      tranco_brand_count: trancoCount?.n ?? 0,
    },
  };

  await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
  return json(data, 200, origin);
}
