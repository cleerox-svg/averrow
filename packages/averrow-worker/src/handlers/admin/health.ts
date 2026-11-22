// Averrow — Admin handlers: health
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
import { cachedCount, THREATS_TOTAL_TTL_S } from "../../lib/cached-count";
import { cachedValue } from "../../lib/cached-value";
import { getReadSession, getDbContext } from "../../lib/db";
import { systemHealthInfrastructure } from "../../lib/db-sizes";
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
import { historyParts, unionAggregateFirst } from "../../lib/telemetry-read";

/**
 * TTL for the system-health 14-day daily threat trend (cachedValue). A
 * 14-day daily series doesn't need sub-hour freshness; the old 300s TTL
 * re-ran the full 14-day GROUP BY over raw threats ~9M rows/day.
 */
export const THREAT_TREND_14D_TTL_S = 3600;

/**
 * TTL of the CLOSED-days part of the 14-day trend (25h; the key embeds the
 * UTC date, so it rolls over daily anyway and the TTL only bounds KV GC).
 */
export const THREAT_TREND_CLOSED_TTL_S = 90_000;

type TrendRow = { day: string | null; count: number };

/** `YYYY-MM-DD HH:MM:SS` UTC — the format `datetime('now', …)` produces. */
function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The bounds the 14-day trend is split on, for `nowMs`. `edge` is the
 * original rolling window start (`datetime('now','-14 days')`); the days
 * strictly between edge's day and today are complete UTC days.
 */
export function threatTrendBounds(nowMs: number): { edge: string; firstFullDay: string; today: string } {
  const edge = sqliteUtc(nowMs - 14 * 86_400_000);
  const edgeDayMs = Date.parse(`${edge.slice(0, 10)}T00:00:00Z`);
  return {
    edge,
    firstFullDay: sqliteUtc(edgeDayMs + 86_400_000).slice(0, 10),
    today: sqliteUtc(nowMs).slice(0, 10),
  };
}

const TREND_CLOSED_SQL = `
  SELECT date(created_at) AS day, COUNT(*) AS count
    FROM threats
   WHERE created_at >= ? AND created_at < ?
   GROUP BY date(created_at)`;
const TREND_EDGE_DAY_SQL = TREND_CLOSED_SQL;
const TREND_TODAY_SQL = `
  SELECT date(created_at) AS day, COUNT(*) AS count
    FROM threats
   WHERE created_at >= ?
   GROUP BY date(created_at)`;

/**
 * 14-day daily threat-creation series, same rows as
 *   SELECT date(created_at) AS day, COUNT(*) AS count FROM threats
 *    WHERE created_at >= datetime('now','-14 days')
 *    GROUP BY date(created_at) ORDER BY day ASC
 * (2026-11-22: that query read ~200K rows on every refill, ~64×/24h), but
 * split into three disjoint created_at ranges, each an index range scan:
 *   - the partial edge day [edge, firstFullDay)        — ≤ 1 day of rows
 *   - the 13 complete days  [firstFullDay, today)      — cached per UTC date
 *   - today and anything later [today, ∞)              — ≤ 1 day of rows
 * Threats are never deleted and created_at is the insert time, so a
 * complete day's count cannot change; caching it for the day is exact. The
 * day bounds are date-only strings ('YYYY-MM-DD'), which sort before every
 * time of that day in both stored formats ('YYYY-MM-DD HH:MM:SS' and ISO
 * 'YYYY-MM-DDTHH:MM:SSZ'), so each row lands in exactly one range; `edge`
 * is the same string the old `datetime('now','-14 days')` produced. Per
 * refill: ~2 days of rows instead of 14, plus the 13-day read once a day.
 */
export async function threatTrend14d(
  env: Env,
  db: Pick<D1Database, "prepare">,
  nowMs: number = Date.now(),
): Promise<TrendRow[]> {
  const { edge, firstFullDay, today } = threatTrendBounds(nowMs);
  const closed = await cachedValue<TrendRow[]>(
    env, `threats.trend_14d.closed:${firstFullDay}:${today}`, THREAT_TREND_CLOSED_TTL_S,
    async () => (await db.prepare(TREND_CLOSED_SQL).bind(firstFullDay, today).all<TrendRow>()).results,
  );
  const edgeDay = (await db.prepare(TREND_EDGE_DAY_SQL).bind(edge, firstFullDay).all<TrendRow>()).results;
  const recent = (await db.prepare(TREND_TODAY_SQL).bind(today).all<TrendRow>()).results;

  const byDay = new Map<string | null, number>();
  for (const r of [...edgeDay, ...closed, ...recent]) {
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.count);
  }
  // SQLite's ORDER BY day ASC: NULL first, then lexical.
  return [...byDay]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => (a.day === b.day ? 0 : a.day === null ? -1 : b.day === null ? 1 : a.day < b.day ? -1 : 1));
}

// Every agentId the canonical Anthropic wrapper is supposed to attribute
// to. Used by handleBudgetLedgerHealth to surface "this call site has
// not landed a ledger row in the last N hours" gaps. Add new entries
// here when adding a new AI call site so the diagnostic stays honest.
const EXPECTED_LEDGER_AGENT_IDS = [
  // Cron-driven agents
  "sentinel",
  "analyst",
  "cartographer",
  "strategist",
  "observer",
  "narrator",
  "pathfinder",
  "watchdog",
  "seed_strategist",
  // Lib helpers + admin call sites
  "admin-classify",
  "brand-analysis",
  "brand-deep-scan",
  "brand-enricher",
  "brand-report",
  "evidence_assembler",
  "geo_campaign_assessment",
  "honeypot-generator",
  "public-trust-check",
  "scan-report",
  "social_ai_assessor",
] as const;

/**
 * GET /api/admin/budget/ledger-health
 *
 * Phase 4 Step 2D diagnostic. Walks every agent_id the wrapper is
 * supposed to attribute to and reports the most recent budget_ledger
 * row for each, plus the per-agent 24h spend. If a call site stops
 * landing rows here, the row is missing and the migration silently
 * regressed.
 *
 * The handler also returns BudgetManager.getStatus() so operators
 * can spot-check that monthly_spend, throttle_level, and projected
 * burn match expectations after a migrated agent run.
 */
export async function handleBudgetLedgerHealth(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const budget = new BudgetManager(env.DB);
    // Phase 4.2: read per-agent monthlyTokenCap declarations from
    // each AgentModule and surface them alongside actual 30-day spend.
    const { agentModules } = await import("../../agents");
    const capByAgentId = new Map<string, { cap: number; alertAt: number }>();
    for (const [id, mod] of Object.entries(agentModules)) {
      capByAgentId.set(id, {
        cap: mod.budget.monthlyTokenCap,
        alertAt: mod.budget.alertAt ?? 0.8,
      });
    }
    const [status, byAgent24h, byAgent30d, totals24h] = await Promise.all([
      budget.getStatus(),
      env.DB.prepare(`
        SELECT agent_id,
               COUNT(*)             as calls,
               SUM(input_tokens)    as input_tokens,
               SUM(output_tokens)   as output_tokens,
               SUM(cost_usd)        as cost_usd,
               MAX(created_at)      as last_call_at
        FROM budget_ledger
        WHERE created_at >= datetime('now', '-1 day')
        GROUP BY agent_id
      `).all<{
        agent_id: string;
        calls: number;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
        last_call_at: string;
      }>(),
      // Phase 5.1: read the current-month token totals from the
      // agent_budget_rollups materialised view instead of SUM-ing a
      // 30-day window on budget_ledger. Single index scan vs. a
      // ~32M-rows-read full sum (the #5 D1 reader before this PR).
      env.DB.prepare(`
        SELECT agent_id,
               total_input_tokens + total_output_tokens AS tokens_month,
               total_cost_usd                          AS cost_month,
               call_count                              AS calls_month
        FROM agent_budget_rollups
        WHERE year_month = strftime('%Y-%m', 'now')
      `).all<{ agent_id: string; tokens_month: number; cost_month: number; calls_month: number }>(),
      env.DB.prepare(`
        SELECT COUNT(*) as calls,
               COALESCE(SUM(cost_usd), 0) as cost_usd
        FROM budget_ledger
        WHERE created_at >= datetime('now', '-1 day')
      `).first<{ calls: number; cost_usd: number }>(),
    ]);

    const byAgentMap = new Map(byAgent24h.results.map(r => [r.agent_id, r]));
    const rollupMap = new Map(byAgent30d.results.map(r => [r.agent_id, r]));

    const expected_agents = EXPECTED_LEDGER_AGENT_IDS.map(agentId => {
      const row = byAgentMap.get(agentId);
      const rollup = rollupMap.get(agentId);
      const tokensMonth = rollup?.tokens_month ?? 0;
      const declared = capByAgentId.get(agentId);
      const cap = declared?.cap ?? null;
      const pctOfCap = cap && cap > 0 ? Math.round((tokensMonth / cap) * 100) : null;
      const overAlert = pctOfCap !== null && declared && pctOfCap >= Math.round(declared.alertAt * 100);
      return {
        agent_id: agentId,
        present_24h: row !== undefined,
        calls_24h: row?.calls ?? 0,
        cost_usd_24h: row?.cost_usd ?? 0,
        last_call_at: row?.last_call_at ?? null,
        // Phase 5.1 — current-month rollup vs declared cap.
        // 'tokens_month' is the calendar month total (matches the
        // gate's enforcement window); 'tokens_30d' kept as alias
        // for any external dashboards still reading the old key.
        tokens_month: tokensMonth,
        tokens_30d: tokensMonth,
        cost_usd_month: rollup?.cost_month ?? 0,
        calls_month: rollup?.calls_month ?? 0,
        monthly_token_cap: cap,
        pct_of_cap: pctOfCap,
        over_alert_threshold: overAlert ?? false,
      };
    });

    const unexpected_agents = byAgent24h.results
      .filter(r => !(EXPECTED_LEDGER_AGENT_IDS as readonly string[]).includes(r.agent_id))
      .map(r => ({
        agent_id: r.agent_id,
        calls_24h: r.calls,
        cost_usd_24h: r.cost_usd,
        last_call_at: r.last_call_at,
      }));

    return json({
      success: true,
      data: {
        ledger: {
          calls_24h: totals24h?.calls ?? 0,
          cost_usd_24h: totals24h?.cost_usd ?? 0,
        },
        budget: status,
        expected_agents,
        unexpected_agents,
      },
    }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500, origin);
  }
}

export async function handleAdminHealth(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  let dbStatus: "ok" | "error" = "ok";
  let dbResponseMs = 0;
  let sqliteVersion = "unknown";
  let journalMode = "wal";
  let tables: { name: string; rows: number }[] = [];

  try {
    const dbStart = Date.now();
    await env.DB.prepare("SELECT 1").first();
    dbResponseMs = Date.now() - dbStart;
    dbStatus = "ok";
  } catch {
    dbStatus = "error";
  }

  if (dbStatus === "ok") {
    try {
      const versionResult = await env.DB.prepare("SELECT sqlite_version() AS v").first<{ v: string }>();
      sqliteVersion = versionResult?.v ?? "unknown";
    } catch { /* D1 does not expose sqlite_version() */ }

    try {
      const journalResult = await env.DB.prepare("PRAGMA journal_mode").first<Record<string, string>>();
      journalMode = journalResult?.["journal_mode"] ?? "wal";
    } catch { /* D1 WAL is managed by Cloudflare */ }

    const tableNames = ["users", "sessions", "invitations", "threats", "brands", "campaigns", "feed_configs", "agent_runs", "briefings"];
    tables = await Promise.all(
      tableNames.map(async (name) => {
        try {
          const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${name}`).first<{ n: number }>();
          return { name, rows: r?.n ?? 0 };
        } catch {
          return { name, rows: -1 };
        }
      })
    );
  }

  const kvOk = !!env.CACHE;
  const overall: "healthy" | "degraded" = dbStatus === "ok" ? "healthy" : "degraded";

  return json({
    success: true,
    data: {
      status: overall,
      timestamp: new Date().toISOString(),
      environment: "production",
      database: {
        status: dbStatus,
        response_ms: dbResponseMs,
        sqlite_version: sqliteVersion,
        journal_mode: journalMode,
        encryption_at_rest: "Cloudflare D1 managed",
        encryption_in_transit: "TLS 1.3",
        last_migration: "latest",
        tables,
      },
      kv_cache: { status: kvOk ? "ok" : "error", binding: "CACHE" },
      compliance: {
        data_residency: "Cloudflare Global Network",
        audit_logging: "enabled",
        hitl_enforced: "enabled",
      },
    },
  }, 200, origin);
}

export async function handleSystemHealth(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  // Outer KV wrap. /admin polls this every 60s from two mounted
  // components, per open tab, so the whole payload was recomputing every
  // minute per tab. A short outer cache makes repeat polls within the
  // window free — same pattern as handleAdminStats. 120s TTL guarantees
  // the second component's poll (and every other open tab) is a cache
  // hit while keeping health data fresh enough for a status dashboard.
  const cacheKey = "system_health";
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  // Read replica for all env.DB reads — this handler is read-only (no
  // writes), so it must not sit on the primary. §8.
  const session = getReadSession(env, getDbContext(request));

  const [
    threatsTotal,
    threatsToday,
    threatsWeek,
    agentStats,
    feedStats,
    sessionCount,
    migrationInfo,
    auditCount,
    threatTrend,
  ] = await Promise.all([
    // total/today/week previously came from ONE bare COUNT/SUM(CASE…)
    // over ~694K raw threats on every uncached call. Split into three
    // cachedCount reads so the full-table scan isn't re-run per poll.
    // count.threats.total reuses the canonical key + THREATS_TOTAL_TTL_S shared by
    // handleAdminStats / dashboard / cartographer — a shorter TTL here
    // would reject their warmed entry and force a full-table recompute
    // (the exact regression flagged in handleAdminStats' PR-V comment).
    cachedCount(env, "count.threats.total", THREATS_TOTAL_TTL_S, async () => {
      const r = await session.prepare("SELECT COUNT(*) AS n FROM threats").first<{ n: number }>();
      return r?.n ?? 0;
    }),
    cachedCount(env, "count.threats.today", 300, async () => {
      const r = await session
        .prepare("SELECT COUNT(*) AS n FROM threats WHERE created_at >= datetime('now','-1 day')")
        .first<{ n: number }>();
      return r?.n ?? 0;
    }),
    cachedCount(env, "count.threats.week", 300, async () => {
      const r = await session
        .prepare("SELECT COUNT(*) AS n FROM threats WHERE created_at >= datetime('now','-7 days')")
        .first<{ n: number }>();
      return r?.n ?? 0;
    }),
    // Track B1c: agent_runs spans telemetry ∪ core during the cut-over.
    historyParts(env, "agent_runs", { core: session }).then((parts) => unionAggregateFirst<{ total: number; successes: number; errors: number }>(parts, (p) => ({
      sql: `
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors
      FROM agent_runs
      WHERE started_at >= datetime('now','-1 day')/*split*/
    `,
      binds: [],
    }), { sum: ["total", "successes", "errors"] })),
    session.prepare(`
      SELECT COUNT(*) as pulls,
        COALESCE(SUM(records_ingested),0) as ingested
      FROM feed_pull_history
      WHERE started_at >= datetime('now','-1 day')
    `).first<{ pulls: number; ingested: number }>(),
    session.prepare(`
      SELECT COUNT(*) as count FROM sessions
      WHERE expires_at > datetime('now') AND revoked_at IS NULL
    `).first<{ count: number }>(),
    session.prepare(`
      SELECT COUNT(*) as total, MAX(applied_at) as last_run,
        (SELECT name FROM d1_migrations ORDER BY applied_at DESC LIMIT 1) as last_name
      FROM d1_migrations
    `).first<{ total: number; last_run: string | null; last_name: string | null }>(),
    // Audit DB is a separate binding (no read-replica session helper);
    // keep it on its own connection. Read-only.
    env.AUDIT_DB.prepare(
      `SELECT COUNT(*) as count FROM audit_log`
    ).first<{ count: number }>(),
    // 14-day daily trend. Same rows as the original GROUP BY over raw
    // threats (not threat_cube_status: the cube is hour-bucketed, so it
    // cannot reproduce the rolling `datetime('now','-14 days')` sub-hour
    // window edge, and the response is a frozen contract), wrapped in
    // cachedValue (THREAT_TREND_14D_TTL_S). threatTrend14d splits the
    // window so a refill reads ~2 days of rows, not 14.
    cachedValue<TrendRow[]>(env, "threats.trend_14d", THREAT_TREND_14D_TTL_S, () => threatTrend14d(env, session)),
  ]);

  // Monotonicity guard for the three independently-cached counts. Each
  // cachedCount entry (total 3600s, today/week 300s) is sampled at a
  // different time and expires independently. Since threats only grow, a
  // freshly-recomputed `today` can transiently exceed a still-stale `week`
  // (the newest ~300s of threats counted in today but not yet in the
  // staler week) — the single-pass scan this split replaced guaranteed
  // today <= week <= total. Clamp in that order to restore it; no-op in
  // the consistent case, and it changes neither the reads nor the shape.
  const week = Math.min(threatsWeek, threatsTotal);
  const today = Math.min(threatsToday, week);

  // Frozen response contract: threats.{total,today,week} reconstructed to
  // the exact shape the single-row query produced before the split.
  const data = {
    success: true,
    data: {
      threats: { total: threatsTotal, today, week },
      agents: agentStats,
      feeds: feedStats,
      sessions: sessionCount,
      migrations: migrationInfo,
      audit: auditCount,
      trend: threatTrend,
      // Measured, not literal — lib/db-sizes.ts (own 1h KV block, never throws).
      infrastructure: await systemHealthInfrastructure(env),
    },
  };

  await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 120 });
  return json(data, 200, origin);
}
