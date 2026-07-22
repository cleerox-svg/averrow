// Averrow — Admin handlers: metrics
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


// ─── D1 Budget (Metrics page section 2) ─────────────────────────
//
// GET /api/admin/metrics/d1-budget
//
// Powers the D1 Budget section on the new /admin/metrics page.
// Reuses the helpers that already serve /api/internal/platform-
// diagnostics — no new GraphQL / AE queries, just a focused
// payload tailored to the section's UI.
//
// Returns:
//   - budget_state         — daily-budget % + threshold state
//                            (ok / warn / skip / unknown)
//   - metrics_24h          — rows_read_24h, rows_written_24h, query
//                            counts, monthly projection vs CF's
//                            25B-rows/month plan ceiling
//   - top_queries          — top 10 queries by rows_read in the
//                            last 24h (query_sample, rows_read,
//                            query_count, avg_rows_per_query)
//   - attribution          — top 10 endpoints by rows_read with
//                            request counts
//
// Cached at the edge for 60s. The CF-side aggregations move
// every minute or so; tighter than that wastes GraphQL calls.
export async function handleD1Budget(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  const cacheKey = "metrics_d1_budget:v1";
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    return json(JSON.parse(cached), 200, origin);
  }

  // Reuse the diagnostics helpers (already exported from
  // handlers/diagnostics.ts) so the section stays in sync with
  // platform-diagnostics output. No duplication.
  const { fetchD1Metrics, fetchD1EndpointAttribution } = await import("../diagnostics");
  const { getBudgetDiagnostics, fetchD1TopQueries, fetchBillingCycleMetrics } = await import("../../lib/d1-budget");

  const [budget, metrics, attribution, topQueries, billingCycle] = await Promise.all([
    getBudgetDiagnostics(env),
    fetchD1Metrics(env),
    fetchD1EndpointAttribution(env),
    fetchD1TopQueries(env),
    fetchBillingCycleMetrics(env),
  ]);

  const data = {
    budget_state: budget,
    metrics_24h: metrics,
    billing_cycle: billingCycle,
    top_queries: topQueries.queries.slice(0, 10),
    top_queries_error: topQueries.error ?? null,
    attribution: {
      by_endpoint: attribution.by_endpoint.slice(0, 10),
      setup_required: attribution.setup_required,
      setup_instructions: attribution.setup_instructions ?? null,
      error: attribution.error ?? null,
    },
    generated_at: new Date().toISOString(),
  };

  const body = { success: true, data };
  await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 60 });
  return json(body, 200, origin);
}

// ─── AI Spend Trend (Metrics page section 3) ────────────────────
//
// GET /api/admin/metrics/ai-spend
//
// Powers the AI Spend section on /admin/metrics. Aggregates
// budget_ledger over three rolling windows (24h / 7d / 30d) plus
// a 30-day daily series for the bar chart and the per-agent
// breakdown for the selected window.
//
// Cached at 5 min in KV — budget_ledger rolls forward minute by
// minute but the operator cares about trend, not real-time. The
// existing `useApiUsage` hook (Agents top-bar) keeps polling its
// own endpoint at 60s for the live "tokens today" header tile.
//
// Returns:
//   windows:      { '24h' | '7d' | '30d' → totals }
//   by_agent_30d: top 20 agents by cost in the last 30d (legacy field,
//                 kept for the AiSpend bar-chart consumer)
//   by_agent:     { '24h' | '7d' | '30d' → per-agent rows } — top 20
//                 agents by 30d cost, each row carrying the window's
//                 calls/tokens/cost + `out_in_ratio` (output/input).
//                 This is the superset that absorbed the retired
//                 ai-cost-optimization endpoint's per-agent view.
//   daily_30d:    30 daily buckets (all agents), oldest → newest
//   cartographer_daily_30d: 30 daily buckets for the cartographer agent
//                 only — the cost-optimization trend line. NOT derivable
//                 from daily_30d (which is not per-agent).
//
// Scan budget: 4 sequential-but-parallel scans of budget_ledger, all
// bounded by created_at (indexed): one conditional-aggregation scan for
// the three windowed totals, one conditional-aggregation GROUP BY
// agent_id scan for all three per-agent windows at once, one all-agent
// daily series, one cartographer-only daily series. (The pre-merge shape
// used 5 scans for a strict subset of this; the retired cost-opt endpoint
// added 4 more for overlapping data — this collapses both to 4.)
export async function handleMetricsAiSpend(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  // v2 — merged the ai-cost-optimization per-agent/out:in/cartographer
  // slices into this endpoint; bumped so the widened shape shows up
  // immediately post-deploy instead of serving a stale v1 body.
  const cacheKey = "metrics_ai_spend:v2";
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  // Conditional-aggregation window slices. `-1 day` and `-7 days` are
  // computed as CASE branches of a single `-30 days`-bounded scan so the
  // three windowed totals cost ONE scan instead of three. Likewise the
  // per-agent breakdown yields all three windows from one GROUP BY scan.
  const WINDOW_TOTALS_SQL = `
      SELECT
        COUNT(CASE WHEN created_at >= datetime('now', '-1 day')  THEN 1 END) AS calls_24h,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-1 day')  THEN input_tokens  END), 0) AS input_24h,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-1 day')  THEN output_tokens END), 0) AS output_24h,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-1 day')  THEN cost_usd      END), 0) AS cost_24h,
        COUNT(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 END) AS calls_7d,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN input_tokens  END), 0) AS input_7d,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN output_tokens END), 0) AS output_7d,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN cost_usd      END), 0) AS cost_7d,
        COUNT(*) AS calls_30d,
        COALESCE(SUM(input_tokens),  0) AS input_30d,
        COALESCE(SUM(output_tokens), 0) AS output_30d,
        COALESCE(SUM(cost_usd),      0) AS cost_30d
      FROM budget_ledger
     WHERE created_at >= datetime('now', '-30 days')`;

  const PER_AGENT_SQL = `
      SELECT agent_id,
        COUNT(CASE WHEN created_at >= datetime('now', '-1 day')  THEN 1 END) AS calls_24h,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-1 day')  THEN input_tokens  END), 0) AS input_24h,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-1 day')  THEN output_tokens END), 0) AS output_24h,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-1 day')  THEN cost_usd      END), 0) AS cost_24h,
        COUNT(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 END) AS calls_7d,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN input_tokens  END), 0) AS input_7d,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN output_tokens END), 0) AS output_7d,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN cost_usd      END), 0) AS cost_7d,
        COUNT(*) AS calls_30d,
        COALESCE(SUM(input_tokens),  0) AS input_30d,
        COALESCE(SUM(output_tokens), 0) AS output_30d,
        COALESCE(SUM(cost_usd),      0) AS cost_30d
      FROM budget_ledger
     WHERE created_at >= datetime('now', '-30 days')
     GROUP BY agent_id
     ORDER BY cost_30d DESC
     LIMIT 20`;

  const [totalsRow, perAgentRows, daily30d, cartDaily30d] = await Promise.all([
    env.DB.prepare(WINDOW_TOTALS_SQL).first<AiSpendWindowedTotalsRow>(),
    env.DB.prepare(PER_AGENT_SQL).all<AiSpendWindowedAgentRow>(),
    env.DB.prepare(`
      SELECT date(created_at) AS day,
             COUNT(*) AS calls,
             COALESCE(SUM(input_tokens), 0)  AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cost_usd), 0)      AS cost_usd
        FROM budget_ledger
       WHERE created_at >= datetime('now', '-30 days')
       GROUP BY day
       ORDER BY day ASC
    `).all<AiSpendDailyRow>(),
    env.DB.prepare(`
      SELECT date(created_at) AS day,
             COUNT(*) AS calls,
             COALESCE(SUM(input_tokens), 0)  AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cost_usd), 0)      AS cost_usd
        FROM budget_ledger
       WHERE created_at >= datetime('now', '-30 days')
         AND agent_id = 'cartographer'
       GROUP BY day
       ORDER BY day ASC
    `).all<AiSpendDailyRow>(),
  ]);

  const t = totalsRow ?? {
    calls_24h: 0, input_24h: 0, output_24h: 0, cost_24h: 0,
    calls_7d: 0,  input_7d: 0,  output_7d: 0,  cost_7d: 0,
    calls_30d: 0, input_30d: 0, output_30d: 0, cost_30d: 0,
  };

  // out:in token ratio — the cost-optimization efficiency indicator.
  // 0 when there's no input volume (avoids divide-by-zero); rounded to
  // 4 places to keep the payload small.
  const ratio = (output: number, input: number): number =>
    input > 0 ? Math.round((output / input) * 10000) / 10000 : 0;

  const perWindowAgents = (
    which: "24h" | "7d" | "30d",
  ): AiSpendByAgentWithRatio[] =>
    perAgentRows.results
      .map((r) => {
        const input  = which === "24h" ? r.input_24h  : which === "7d" ? r.input_7d  : r.input_30d;
        const output = which === "24h" ? r.output_24h : which === "7d" ? r.output_7d : r.output_30d;
        return {
          agent_id: r.agent_id,
          calls:    which === "24h" ? r.calls_24h : which === "7d" ? r.calls_7d : r.calls_30d,
          input_tokens:  input,
          output_tokens: output,
          cost_usd: which === "24h" ? r.cost_24h : which === "7d" ? r.cost_7d : r.cost_30d,
          out_in_ratio: ratio(output, input),
        };
      })
      .sort((a, b) => b.cost_usd - a.cost_usd);

  // Legacy field: same top-20-by-30d-cost rows the pre-merge consumer
  // read, minus the ratio. Derived from the 30d slice of the single
  // per-agent scan (already ordered by cost_30d DESC).
  const byAgent30d: AiSpendByAgent[] = perAgentRows.results.map((r) => ({
    agent_id: r.agent_id,
    calls: r.calls_30d,
    input_tokens: r.input_30d,
    output_tokens: r.output_30d,
    cost_usd: r.cost_30d,
  }));

  const data = {
    windows: {
      "24h": { calls: t.calls_24h, input_tokens: t.input_24h, output_tokens: t.output_24h, cost_usd: t.cost_24h },
      "7d":  { calls: t.calls_7d,  input_tokens: t.input_7d,  output_tokens: t.output_7d,  cost_usd: t.cost_7d },
      "30d": { calls: t.calls_30d, input_tokens: t.input_30d, output_tokens: t.output_30d, cost_usd: t.cost_30d },
    },
    by_agent_30d: byAgent30d,
    by_agent: {
      "24h": perWindowAgents("24h"),
      "7d":  perWindowAgents("7d"),
      "30d": perWindowAgents("30d"),
    },
    daily_30d: daily30d.results,
    cartographer_daily_30d: cartDaily30d.results,
    generated_at: new Date().toISOString(),
  };

  const body = { success: true, data };
  await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 300 });
  return json(body, 200, origin);
}

interface AiSpendWindowedTotalsRow {
  calls_24h: number; input_24h: number; output_24h: number; cost_24h: number;
  calls_7d: number;  input_7d: number;  output_7d: number;  cost_7d: number;
  calls_30d: number; input_30d: number; output_30d: number; cost_30d: number;
}

interface AiSpendWindowedAgentRow extends AiSpendWindowedTotalsRow {
  agent_id: string;
}

interface AiSpendDailyRow {
  day: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface AiSpendByAgent {
  agent_id: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface AiSpendByAgentWithRatio extends AiSpendByAgent {
  out_in_ratio: number;
}

// ─── AI Cost Optimization (Metrics page section 6) ──────────────
//
// GET /api/admin/metrics/ai-cost-optimization
//
// Measurement endpoint for the AI cost-reduction plan tracked in
// /root/.claude/plans/can-you-review-the-purring-pearl.md. The
// existing AI Spend tab answers "what does the platform cost?";
// this one answers "are the cost-reduction levers working?".
//
// Three things make this view distinct from AI Spend:
//
// 1) Per-call efficiency, not totals. Output-token trim and
//    schema-tightening drop cost-per-call and the output:input
//    token ratio. Operators see the line move down as levers ship.
//
// 2) Focus agents. Cartographer (71% of spend), Analyst (17%),
//    Sentinel (9%) account for 97% of cost. Each gets a dedicated
//    card with the metrics that matter for ITS specific lever
//    (e.g. cartographer's out:in ratio is the key indicator that
//    Lever #1's schema-tightening landed).
//
// 3) Lever roster. Static list of the levers + their current
//    status. Operators can see at a glance "what's deployed?"
//    without reading the plan file.
//
// Cached at 5 min — same cadence as AI Spend since the source
// table (budget_ledger) is the same.
export async function handleMetricsAiCostOptimization(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  // v6 — Lever #6 deployed 2026-05-23, busted cache so the status flip
  // shows up immediately post-deploy. All 7 levers now deployed.
  const cacheKey = "metrics_ai_cost_optimization:v6";
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  // The plan targets these three agents specifically. Order matters
  // for the UI — cartographer is the headline lever.
  const FOCUS_AGENTS = ["cartographer", "analyst", "sentinel"] as const;

  // Per-agent windowed metrics. Each row carries enough to compute
  // cost-per-call + out:in ratio on the frontend without a second
  // round-trip.
  const perAgentQuery = (windowDays: number) => env.DB.prepare(`
    SELECT agent_id,
           COUNT(*)                          AS calls,
           COALESCE(SUM(input_tokens),  0)   AS input_tokens,
           COALESCE(SUM(output_tokens), 0)   AS output_tokens,
           COALESCE(SUM(cost_usd),      0)   AS cost_usd
      FROM budget_ledger
     WHERE created_at >= datetime('now', ?)
       AND agent_id IN (?, ?, ?)
     GROUP BY agent_id
  `).bind(`-${windowDays} days`, FOCUS_AGENTS[0], FOCUS_AGENTS[1], FOCUS_AGENTS[2]);

  // Cartographer-specific daily series for the trend chart. The key
  // indicator for Lever #1 (output-schema tightening) is the
  // output:input ratio dropping over time. Lever #1b (in-prompt
  // batching) shows up as call-count dropping while record volume
  // stays constant. Lever #6 (Message Batches API) would land as a
  // cost-per-call drop (~50%) on the cartographer line.
  const cartDailyQuery = env.DB.prepare(`
    SELECT date(created_at)              AS day,
           COUNT(*)                      AS calls,
           COALESCE(SUM(input_tokens),  0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cost_usd),      0) AS cost_usd
      FROM budget_ledger
     WHERE created_at >= datetime('now', '-30 days')
       AND agent_id = 'cartographer'
     GROUP BY day
     ORDER BY day ASC
  `);

  const [w24h, w7d, w30d, cartDaily] = await Promise.all([
    perAgentQuery(1).all<PerAgentRow>(),
    perAgentQuery(7).all<PerAgentRow>(),
    perAgentQuery(30).all<PerAgentRow>(),
    cartDailyQuery.all<{
      day: string;
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>(),
  ]);

  // Reshape windowed rows into a per-agent map keyed by agent_id, so
  // the frontend can pluck cartographer/analyst/sentinel in any order
  // without dealing with absent rows (an agent with zero calls in
  // window N comes back as missing — we fill with zeros).
  const empty: PerAgentMetrics = {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  };
  const pivot = (rows: PerAgentRow[]): Record<string, PerAgentMetrics> => {
    const out: Record<string, PerAgentMetrics> = {};
    for (const a of FOCUS_AGENTS) out[a] = { ...empty };
    for (const row of rows) {
      out[row.agent_id] = {
        calls: row.calls,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cost_usd: row.cost_usd,
      };
    }
    return out;
  };

  // The static lever roster. Mirrors the plan file's "Recommended
  // priority order" section. The `status` field is hand-edited as
  // each lever lands — there's no auto-detection because the plan
  // doesn't yet have any commits enabling it.
  //
  // When a lever ships, flip its status to 'deployed' AND set
  // deployed_at to the deploy date (UTC) — operators can then
  // measure the before/after on the chart by eye.
  const levers: LeverStatus[] = [
    {
      id: "lever_1",
      title: "Cartographer scoreProvider output-schema tightening",
      target_agent: "cartographer",
      status: "deployed",
      estimated_savings_usd_per_year: 850,
      deployed_at: "2026-05-23",
      indicator: "out:in ratio drops below 0.5 on cartographer",
    },
    {
      id: "lever_1b",
      title: "Cartographer in-prompt batching (N providers/call)",
      target_agent: "cartographer",
      status: "deployed",
      estimated_savings_usd_per_year: 200,
      deployed_at: "2026-05-23",
      indicator: "calls/day on cartographer drop without record volume changing",
    },
    {
      id: "lever_2",
      title: "Analyst keyword pre-match expansion",
      target_agent: "analyst",
      status: "deployed",
      estimated_savings_usd_per_year: 250,
      deployed_at: "2026-05-23",
      indicator: "calls/day on analyst drop",
    },
    {
      id: "lever_3",
      title: "Sentinel sibling-domain deduplication + tighter response JSON",
      target_agent: "sentinel",
      status: "deployed",
      estimated_savings_usd_per_year: 125,
      deployed_at: "2026-05-23",
      indicator: "calls/day on sentinel drop; out:in ratio drops",
    },
    {
      id: "lever_4",
      title: "Add cache_control plumbing to lib/anthropic.ts",
      target_agent: "(infra)",
      status: "deployed",
      estimated_savings_usd_per_year: 0,
      deployed_at: "2026-05-23",
      indicator: "infra-only — no immediate cost change; enables future levers",
    },
    {
      id: "lever_6",
      title: "Cartographer Message Batches API (50% async discount)",
      target_agent: "cartographer",
      status: "deployed",
      estimated_savings_usd_per_year: 675,
      deployed_at: "2026-05-23",
      indicator: "cost/call on cartographer drops ~50% post-cutover (effective once first batch ingests, ~24h after deploy)",
    },
  ];

  const data = {
    focus_agents: FOCUS_AGENTS,
    windows: {
      "24h": pivot(w24h.results),
      "7d": pivot(w7d.results),
      "30d": pivot(w30d.results),
    },
    cartographer_daily_30d: cartDaily.results,
    levers,
    generated_at: new Date().toISOString(),
  };

  const body = { success: true, data };
  await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 300 });
  return json(body, 200, origin);
}

interface PerAgentRow {
  agent_id: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface PerAgentMetrics {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface LeverStatus {
  id: string;
  title: string;
  target_agent: string;
  status: "planned" | "in_progress" | "deployed";
  estimated_savings_usd_per_year: number;
  deployed_at: string | null;
  indicator: string;
}

// ─── Geo Coverage Trend (Metrics page section 4) ────────────────
//
// GET /api/admin/metrics/geo-coverage
//
// Powers the Geo Coverage section on /admin/metrics. Three
// windowed coverage numbers (24h / 7d / 30d) + a 30-day daily
// series for the trend chart + the cartographer-exhausted
// pile summary so operators can see WHY coverage is low when
// it is.
//
// Coverage = mapped (threats with lat/lng) / total. Computed
// from threat_cube_geo + threat_cube_status — same source as
// the diagnostics endpoint, just sliced for the UI.
//
// Cached at 5 min. Cube data refreshes every 5 min via
// Navigator anyway.
export async function handleMetricsGeoCoverage(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  const cacheKey = "metrics_geo_coverage:v1";
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  const windowDefs: Array<{ key: '24h' | '7d' | '30d'; offset: string }> = [
    { key: '24h', offset: "datetime('now', '-1 day')" },
    { key: '7d',  offset: "datetime('now', '-7 days')" },
    { key: '30d', offset: "datetime('now', '-30 days')" },
  ];

  const [windows, daily, exhausted, exhaustedByFeed] = await Promise.all([
    Promise.all(windowDefs.map(async (w) => {
      const [mapped, total] = await Promise.all([
        env.DB.prepare(
          `SELECT COALESCE(SUM(threat_count), 0) AS n FROM threat_cube_geo
            WHERE hour_bucket >= strftime('%Y-%m-%d %H:00:00', ${w.offset})`
        ).first<{ n: number }>(),
        env.DB.prepare(
          `SELECT COALESCE(SUM(threat_count), 0) AS n FROM threat_cube_status
            WHERE hour_bucket >= strftime('%Y-%m-%d %H:00:00', ${w.offset})`
        ).first<{ n: number }>(),
      ]);
      const m = mapped?.n ?? 0;
      const t = total?.n ?? 0;
      return {
        window: w.key,
        mapped: m,
        total: t,
        unmapped: Math.max(0, t - m),
        coverage_pct: t > 0 ? Math.round((m / t) * 1000) / 10 : null,
      };
    })),

    // Daily coverage series for the trend chart. Joined off the
    // status cube so we only emit days that had any threats —
    // rendering empty days with 0% would be misleading.
    env.DB.prepare(`
      WITH g AS (
        SELECT date(hour_bucket) AS day, SUM(threat_count) AS mapped
          FROM threat_cube_geo
         WHERE hour_bucket >= datetime('now', '-30 days')
         GROUP BY day
      ),
      s AS (
        SELECT date(hour_bucket) AS day, SUM(threat_count) AS total
          FROM threat_cube_status
         WHERE hour_bucket >= datetime('now', '-30 days')
         GROUP BY day
      )
      SELECT s.day,
             COALESCE(g.mapped, 0) AS mapped,
             s.total,
             CASE WHEN s.total > 0
                  THEN ROUND(COALESCE(g.mapped, 0) * 100.0 / s.total, 1)
                  ELSE NULL
             END AS coverage_pct
        FROM s LEFT JOIN g ON g.day = s.day
       ORDER BY s.day ASC
    `).all<{ day: string; mapped: number; total: number; coverage_pct: number | null }>(),

    env.DB.prepare(`
      SELECT COUNT(*) AS n
        FROM threats
       WHERE status = 'active'
         AND enriched_at IS NULL
         AND enrichment_attempts >= 5
    `).first<{ n: number }>(),

    env.DB.prepare(`
      SELECT source_feed, threat_type, COUNT(*) AS n
        FROM threats
       WHERE status = 'active'
         AND enriched_at IS NULL
         AND enrichment_attempts >= 5
       GROUP BY source_feed, threat_type
       ORDER BY n DESC
       LIMIT 10
    `).all<{ source_feed: string; threat_type: string; n: number }>(),
  ]);

  const data = {
    windows,
    daily_30d: daily.results,
    exhausted: {
      total: exhausted?.n ?? 0,
      by_feed: exhaustedByFeed.results,
    },
    generated_at: new Date().toISOString(),
  };

  const body = { success: true, data };
  await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 300 });
  return json(body, 200, origin);
}

// ─── Feed Failures (Metrics page section 5) ─────────────────────
//
// GET /api/admin/metrics/feed-failures
//
// Powers the Feed Failures section on /admin/metrics. Aggregates
// feed_pull_history over 24h, joins feed_status (consecutive
// failures) + feed_configs (enabled / paused_reason / threshold)
// so the operator sees auto-pause risk alongside raw failure
// rate. Cached at 60s.
export async function handleMetricsFeedFailures(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  // v2 — added the `severity` field to each per_feed row; bumped so a
  // stale v1 body (lacking severity) can't be served after deploy and
  // leave the Feeds-tab feedRiskTier reading `undefined`.
  const cacheKey = "metrics_feed_failures:v2";
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  const [perFeedRows, statusRows, configRows, recentErrors] = await Promise.all([
    env.DB.prepare(`
      SELECT feed_name,
             COUNT(*) AS pulls,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
             SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
             COALESCE(SUM(CASE WHEN status = 'success' THEN records_ingested END), 0) AS records,
             MAX(CASE WHEN status = 'success' THEN started_at END) AS last_success_at,
             MAX(CASE WHEN status = 'failed'  THEN started_at END) AS last_failure_at
        FROM feed_pull_history
       WHERE started_at >= datetime('now', '-1 day')
       GROUP BY feed_name
    `).all<{
      feed_name: string;
      pulls: number;
      success: number;
      failed: number;
      partial: number;
      records: number;
      last_success_at: string | null;
      last_failure_at: string | null;
    }>(),

    env.DB.prepare(`
      SELECT feed_name, consecutive_failures, health_status, last_error
        FROM feed_status
    `).all<{
      feed_name: string;
      consecutive_failures: number;
      health_status: string | null;
      last_error: string | null;
    }>(),

    env.DB.prepare(`
      SELECT feed_name, display_name, enabled, paused_reason,
             COALESCE(consecutive_failure_threshold, 5) AS threshold
        FROM feed_configs
    `).all<{
      feed_name: string;
      display_name: string | null;
      enabled: number;
      paused_reason: string | null;
      threshold: number;
    }>(),

    env.DB.prepare(`
      SELECT feed_name, started_at, error_message
        FROM feed_pull_history
       WHERE status = 'failed'
         AND started_at >= datetime('now', '-1 day')
         AND error_message IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 10
    `).all<{
      feed_name: string;
      started_at: string;
      error_message: string;
    }>(),
  ]);

  const statusByName = new Map(statusRows.results.map((r) => [r.feed_name, r]));

  // Walk feed_configs as the source of truth so paused / 0-pull
  // feeds still show up.
  const seen = new Set<string>();
  const perFeed = configRows.results.map((cfg) => {
    seen.add(cfg.feed_name);
    const pulls = perFeedRows.results.find((p) => p.feed_name === cfg.feed_name);
    const status = statusByName.get(cfg.feed_name);
    const total   = pulls?.pulls   ?? 0;
    const success = pulls?.success ?? 0;
    const failed  = pulls?.failed  ?? 0;
    const failureRatePct = total > 0 ? Math.round((failed / total) * 100) : 0;
    const consec = status?.consecutive_failures ?? 0;
    const pctToAutoPause = cfg.threshold > 0
      ? Math.round((consec / cfg.threshold) * 100)
      : 0;
    return {
      feed_name: cfg.feed_name,
      display_name: cfg.display_name ?? cfg.feed_name,
      enabled: cfg.enabled === 1,
      paused_reason: cfg.paused_reason,
      pulls: total,
      success,
      failed,
      partial: pulls?.partial ?? 0,
      failure_rate_pct: failureRatePct,
      records_ingested: pulls?.records ?? 0,
      last_success_at: pulls?.last_success_at ?? null,
      last_failure_at: pulls?.last_failure_at ?? null,
      consecutive_failures: consec,
      threshold: cfg.threshold,
      pct_to_auto_pause: pctToAutoPause,
      severity: computeFeedSeverity({
        enabled: cfg.enabled === 1,
        paused_reason: cfg.paused_reason,
        pct_to_auto_pause: pctToAutoPause,
        failure_rate_pct: failureRatePct,
        pulls: total,
      }),
      verdict: computeFeedVerdict({
        enabled: cfg.enabled === 1,
        pulls: total,
        failureRatePct,
        pctToAutoPause,
      }),
    };
  });

  // Surface pull-history rows with no feed_configs match (orphan).
  for (const p of perFeedRows.results) {
    if (seen.has(p.feed_name)) continue;
    const failureRatePct = p.pulls > 0 ? Math.round((p.failed / p.pulls) * 100) : 0;
    perFeed.push({
      feed_name: p.feed_name,
      display_name: p.feed_name,
      enabled: false,
      paused_reason: 'orphan: no feed_configs row',
      pulls: p.pulls,
      success: p.success,
      failed: p.failed,
      partial: p.partial,
      failure_rate_pct: failureRatePct,
      records_ingested: p.records,
      last_success_at: p.last_success_at,
      last_failure_at: p.last_failure_at,
      consecutive_failures: 0,
      threshold: 0,
      pct_to_auto_pause: 0,
      severity: computeFeedSeverity({
        enabled: false,
        paused_reason: 'orphan: no feed_configs row',
        pct_to_auto_pause: 0,
        failure_rate_pct: failureRatePct,
        pulls: p.pulls,
      }),
      verdict: { tone: 'inactive' as const, label: 'ORPHAN' },
    });
  }

  // Sort by verdict severity so the operator's first-glance
  // problem is at the top of the table.
  const VERDICT_RANK: Record<string, number> = {
    'CRITICAL': 0,
    'AT RISK':  1,
    'WATCH':    2,
    'PAUSED':   3,
    'ORPHAN':   4,
    'HEALTHY':  5,
    'IDLE':     6,
  };
  perFeed.sort((a, b) => {
    const ra = VERDICT_RANK[a.verdict.label] ?? 99;
    const rb = VERDICT_RANK[b.verdict.label] ?? 99;
    if (ra !== rb) return ra - rb;
    if (a.failure_rate_pct !== b.failure_rate_pct) return b.failure_rate_pct - a.failure_rate_pct;
    return a.feed_name.localeCompare(b.feed_name);
  });

  const totals = perFeed.reduce(
    (acc, f) => {
      acc.total_pulls    += f.pulls;
      acc.total_success  += f.success;
      acc.total_failed   += f.failed;
      acc.total_records  += f.records_ingested;
      if (f.pulls > 0) acc.feeds_active += 1;
      return acc;
    },
    { total_pulls: 0, total_success: 0, total_failed: 0, total_records: 0, feeds_active: 0 },
  );

  const data = {
    totals_24h: totals,
    per_feed: perFeed,
    recent_errors: recentErrors.results,
    generated_at: new Date().toISOString(),
  };

  const body = { success: true, data };
  await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 60 });
  return json(body, 200, origin);
}

function computeFeedVerdict(input: {
  enabled: boolean;
  pulls: number;
  failureRatePct: number;
  pctToAutoPause: number;
}): { tone: 'success' | 'warning' | 'failed' | 'pending' | 'inactive'; label: string } {
  if (!input.enabled)              return { tone: 'inactive', label: 'PAUSED'   };
  if (input.pctToAutoPause >= 80)  return { tone: 'failed',   label: 'AT RISK'  };
  if (input.failureRatePct >= 30)  return { tone: 'failed',   label: 'CRITICAL' };
  if (input.failureRatePct >= 10)  return { tone: 'warning',  label: 'WATCH'    };
  if (input.pctToAutoPause >= 60)  return { tone: 'warning',  label: 'WATCH'    };
  if (input.pulls === 0)           return { tone: 'inactive', label: 'IDLE'     };
  return                                  { tone: 'success',  label: 'HEALTHY'  };
}
