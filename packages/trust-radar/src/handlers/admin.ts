// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Admin Handlers

import { z } from "zod";
import { json, corsHeaders } from "../lib/cors";
import { audit } from "../lib/audit";
import type { Env, UserRole, UserStatus } from "../types";
import { runSyncAgent } from "../lib/agentRunner";
import { adminClassifyAgent, type AdminClassifyOutput } from "../agents/admin-classify";
import { callAnthropicJSON } from "../lib/anthropic";
import { estimateCost } from "../lib/budgetManager";
import { HOT_PATH_HAIKU } from "../lib/ai-models";
import { enrichThreatsGeo, PRIVATE_IP_SQL_FILTER } from "../lib/geoip";
import { fuzzyMatchBrand } from "../lib/brandDetect";
import { cachedCount } from "../lib/cached-count";
import { cachedValue } from "../lib/cached-value";
import { getReadSession, getDbContext } from "../lib/db";
import { classifySaasTechnique } from "../lib/saas-classifier";
import { BudgetManager } from "../lib/budgetManager";
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
} from "../lib/cube-builder";

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
  "architect",
  // Lib helpers + admin call sites
  "admin-classify",
  "ai-attribution",
  "brand-analysis",
  "brand-deep-scan",
  "brand-enricher",
  "brand-report",
  "evidence_assembler",
  "geo_campaign_assessment",
  "honeypot-generator",
  "lookalike-scanner",
  "public-trust-check",
  "scan-report",
  "social_ai_assessor",
  "url-scan",
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
    const { agentModules } = await import("../agents");
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
    // count.threats.total reuses the canonical key + 3600s TTL shared by
    // handleAdminStats / dashboard / cartographer — a shorter TTL here
    // would reject their warmed entry and force a full-table recompute
    // (the exact regression flagged in handleAdminStats' PR-V comment).
    cachedCount(env, "count.threats.total", 3600, async () => {
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
    session.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors
      FROM agent_runs
      WHERE started_at >= datetime('now','-1 day')
    `).first<{ total: number; successes: number; errors: number }>(),
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
    // 14-day daily trend. Kept as the EXACT original GROUP BY over raw
    // threats but wrapped in cachedValue (300s) instead of sourced from
    // threat_cube_status. The cube is hour-bucketed, so it cannot
    // reproduce the rolling `datetime('now','-14 days')` sub-hour window
    // edge: summing per-hour cube rows for the boundary day would either
    // over- or under-count the earliest partial day vs the raw series.
    // The response is a frozen contract requiring byte-identical values,
    // so cachedValue (exact SQL, exact window + timezone semantics, zero
    // per-poll recompute) is the correct swap here — not the cube.
    cachedValue<Array<{ day: string; count: number }>>(env, "threats.trend_14d", 300, async () => {
      const r = await session.prepare(`
        SELECT date(created_at) as day, COUNT(*) as count
        FROM threats
        WHERE created_at >= datetime('now','-14 days')
        GROUP BY date(created_at)
        ORDER BY day ASC
      `).all<{ day: string; count: number }>();
      return r.results;
    }),
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
      infrastructure: {
        mainDb: { name: 'trust-radar-v2', sizeMb: 79.5, tables: 57, region: 'ENAM' },
        auditDb: { name: 'trust-radar-v2-audit', sizeKb: 180, tables: 2, region: 'ENAM' },
        worker: { name: 'trust-radar', platform: 'Cloudflare Workers' },
        kvNamespaces: [
          { name: 'trust-radar-cache' },
          { name: 'SESSIONS' },
          { name: 'CACHE' },
        ],
      },
    },
  };

  await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 120 });
  return json(data, 200, origin);
}

const UpdateUserSchema = z.object({
  role: z.enum(["super_admin", "admin", "analyst", "client"] as const).optional(),
  status: z.enum(["active", "suspended", "deactivated"] as const).optional(),
});

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

// ─── Pipeline Status (reads pre-computed data only — no COUNT queries) ───

// Maps backlog_history names to display labels and owning agents.
// `endpoints` lists the external HTTP services this pipeline calls
// (DNS resolvers, third-party threat-intel APIs, etc.). Surfaced
// in the Pipeline Automation card so operators can see the off-
// platform dependencies for each pipeline.
//
// `description` is a one-line plain-English subtitle rendered under
// the pipeline label on the Agents-Monitor card. It answers "what
// does this pipeline DO?" so an operator who hasn't read the agent
// docs can still triage. Keep these tight (≤80 chars).
type PipelineMeta = {
  label: string;
  description: string;
  agent: string;
  schedule: string;
  endpoints?: Array<{ name: string; url: string }>;
  /** Multi-line plain-English explanation of the pipeline's
   *  dynamics: when does the backlog grow vs drain, what are the
   *  rate-limits or external dependencies, what does an operator
   *  do if it's stuck. Surfaced in the drill-down detail sheet. */
  why_grows?: string;
  /** Optional `feed_pull_history.feed_name` mapping. Used by the
   *  detail sheet to compute 24h failure-rate stats for pipelines
   *  that pull from an external feed. Most agent-driven pipelines
   *  (cartographer, analyst, brand_enrich, domain_geo) have no
   *  feed mapping — they enrich existing rows rather than pulling
   *  new ones. */
  feed_name?: string;
};

const PIPELINE_META: Record<string, PipelineMeta> = {
  cartographer: {
    label: 'Geo Enrichment',
    description: 'IPs awaiting country / lat-lng / ASN resolution.',
    agent: 'cartographer',
    schedule: 'hourly',
    why_grows:
      'Grows when feed inflow exceeds the ~2,500 IPs Cartographer can ' +
      'enrich per hour (5 batches × 500). Phase 0 calls ip-api.com (free ' +
      '15 req/min) and Phase 0.5 falls back to the local MaxMind range ' +
      'table for IPs both APIs miss. Drains naturally as Cartographer ' +
      'catches up; Flight Control scales it up to 3 parallel instances ' +
      'when the queue passes its high-water mark.',
  },
  analyst: {
    label: 'Brand Matching',
    description: 'Threats awaiting brand attribution via Haiku scoring.',
    agent: 'analyst',
    schedule: 'hourly',
    why_grows:
      'Grows when threats land faster than the Analyst can score them. ' +
      'Each call is one Haiku invocation per threat (or per cluster of ' +
      'similar threats). Flight Control scales to 3 parallel Analyst ' +
      'instances when the unlinked-threat backlog passes 50k. Throttled ' +
      'down or paused when AI budget enters hard / emergency state.',
  },
  domain_geo: {
    label: 'DNS Resolution',
    description:
      'Domains awaiting A-record resolution to source IP. Backed by ' +
      'a side-DB queue (trust-radar-dns-queue) populated by the ' +
      'cursor-paginated reconciler and swept daily by the reaper.',
    agent: 'navigator',
    schedule: '5 min',
    endpoints: [
      { name: 'Cloudflare 1.1.1.1', url: 'https://cloudflare-dns.com' },
      { name: 'Google DNS',         url: 'https://dns.google' },
      { name: 'Quad9 DNS',          url: 'https://dns.quad9.net:5053' },
    ],
    why_grows:
      'Grows when Navigator hits resolver rate limits or when feeds ' +
      'emit domains that already 5x-failed resolution (those are skipped ' +
      'after the cap to avoid re-asking dead resolvers). Three resolvers ' +
      'rotate per call so a single resolver outage just slows things ' +
      'rather than halts them. The reconciler enqueues NEW threat ' +
      'candidates each Navigator tick using a KV cursor — old rows ' +
      'whose threats flipped to inactive are cleared by the once-per-' +
      'day reaper (sweeps dns_queue at hour===0 UTC).',
  },
  brand_enrich: {
    label: 'Brand Enrichment',
    description: 'Brands awaiting favicon / HQ geo / exposure-score backfill.',
    agent: 'enricher',
    schedule: 'hourly',
    why_grows:
      'Grows whenever a new brand is registered (Tranco import, manual ' +
      'add, social-discovery) before the Enricher tick lands. Drains ' +
      'within 1–2 hours under normal load. Stuck rows usually mean the ' +
      'brand has a malformed canonical_domain or no public website.',
  },
  surbl: {
    label: 'SURBL',
    description: 'SURBL spam-URL blocklist lookup queue.',
    agent: 'surbl',
    schedule: 'hourly',
    feed_name: 'surbl',
    why_grows:
      'Grows when the SURBL feed pull fails (DNS, HTTP) or when the agent ' +
      'is paused by Flight Control. Re-pulls on the next hourly cron tick.',
  },
  virustotal: {
    label: 'VirusTotal',
    description: 'Domains awaiting VirusTotal verdict (4 req/min on free tier).',
    agent: 'virustotal',
    schedule: 'hourly',
    feed_name: 'virustotal',
    why_grows:
      'Grows when feed inflow exceeds the 4 req/min API quota (free tier) ' +
      'or when VT returns 429s during peak hours. Each domain is checked ' +
      'at most once per 24h — repeat lookups are skipped via the ' +
      '`vt_checked_at` stamp.',
  },
  gsb: {
    label: 'Safe Browsing',
    description: 'Google Safe Browsing lookups for malicious URLs.',
    agent: 'gsb',
    schedule: 'hourly',
    feed_name: 'google_safe_browsing',
    why_grows:
      'Grows when the GSB API returns transient 5xxs or rate-limits. ' +
      'Most threats clear in one tick; persistent backlog usually means ' +
      'the API key has hit its daily quota.',
  },
  dbl: {
    label: 'Spamhaus DBL',
    description: 'Spamhaus Domain Block List reputation lookups.',
    agent: 'dbl',
    schedule: 'hourly',
    feed_name: 'spamhaus_dbl',
    why_grows:
      'Grows when the DBL DNSBL query fails (UDP packet loss is common). ' +
      'Re-runs on the next hourly tick. Spamhaus rate-limits at 100k ' +
      'queries/day for free non-commercial use.',
  },
  abuseipdb: {
    label: 'AbuseIPDB',
    description: 'Malicious IPs awaiting AbuseIPDB reputation (1k req/day cap).',
    agent: 'abuseipdb',
    schedule: 'hourly',
    feed_name: 'abuseipdb',
    why_grows:
      'Grows when threat inflow exceeds the 1,000 req/day quota on the ' +
      'free tier. Resets at 00:00 UTC. Persistent growth means the cap ' +
      'is too tight for current inflow — upgrade the API tier or ' +
      'deprioritize lower-confidence IPs.',
  },
  pdns: {
    label: 'Passive DNS',
    description: 'Historical DNS-records lookup queue.',
    agent: 'pdns',
    schedule: 'hourly',
    why_grows:
      'Grows when Mnemonic / Farsight pDNS APIs throttle. Mostly used ' +
      'for high-severity domains; lower-severity rows wait or get ' +
      'skipped after the retry cap.',
  },
  greynoise: {
    label: 'GreyNoise',
    description: 'Internet-noise classification (filters scanners / honeypot traffic).',
    agent: 'greynoise',
    schedule: 'hourly',
    feed_name: 'greynoise',
    why_grows:
      'Grows when GreyNoise quota is exhausted (free tier: 10k IPs/day). ' +
      'Resets at 00:00 UTC. Persistent backlog suggests inflow > daily ' +
      'quota — most useful as a filter, not a per-threat enrichment.',
  },
  seclookup: {
    label: 'SecLookup',
    description: 'Domain reputation enrichment queue.',
    agent: 'seclookup',
    schedule: 'hourly',
    why_grows:
      'Grows when SecLookup API throttles or when the score-cache window ' +
      'expires for many domains at once. Drains within 2–3 hourly ticks ' +
      'under normal conditions.',
  },
};

/**
 * Verdict pill displayed on each Pipeline Automation card. Replaces
 * the cryptic `↓ 2,424` trend text with a one-word health label.
 *
 * The semantics differ for reference datasets (geoip — more rows is
 * good, "up" → UPDATED) vs backlogs (everything else — fewer rows
 * is good, "down" → DRAINING). Computed server-side so the UI just
 * renders what's there and we keep the encoding rule in one place.
 */
type VerdictTone = 'success' | 'warning' | 'failed' | 'pending' | 'inactive';
type Verdict = { label: string; tone: VerdictTone };

function computeBacklogVerdict(
  count: number,
  trendDirection: 'up' | 'down' | 'flat' | 'unknown',
): Verdict {
  if (count === 0) return { label: 'CLEAR', tone: 'success' };
  switch (trendDirection) {
    case 'down':    return { label: 'DRAINING', tone: 'success' };
    case 'up':      return { label: 'GROWING',  tone: 'failed'  };
    case 'flat':    return { label: 'STEADY',   tone: 'inactive' };
    case 'unknown': return { label: 'STALE',    tone: 'pending' };
  }
}

function computeReferenceDatasetVerdict(
  count: number,
  configured: boolean,
  rowsWritten: number,
  // NX-geoip-card: refresh status + age give the card three more states.
  refreshStatus?: string | null,
  lastRefreshAt?: string | null,
): Verdict {
  if (!configured)  return { label: 'SETUP',   tone: 'pending'  };
  if (count === 0)  return { label: 'EMPTY',   tone: 'failed'   };
  if (refreshStatus === 'running') return { label: 'REFRESHING', tone: 'pending' };
  if (refreshStatus === 'failed' && lastRefreshAt) {
    return { label: 'FAILED', tone: 'failed' };
  }
  // Reference-dataset staleness: MaxMind ships weekly; > 7d is stale,
  // > 14d is stale-critical. Computed in JS to keep the helper pure.
  if (lastRefreshAt) {
    const ageMs = Date.now() - new Date(lastRefreshAt + 'Z').getTime();
    const ageDays = ageMs / 86_400_000;
    if (ageDays > 14) return { label: 'STALE',  tone: 'failed'  };
    if (ageDays > 7)  return { label: 'STALE',  tone: 'pending' };
  }
  if (rowsWritten > 0) return { label: 'UPDATED', tone: 'success' };
  return { label: 'STABLE', tone: 'inactive' };
}

export async function handlePipelineStatus(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  // v4 prefix invalidates v3's pre-sparkline shape so the new
  // per-card sparkline arrays land on first deploy.
  const cacheKey = "pipeline_status_v4";
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  // Read 24h of snapshots per backlog from backlog_history (pre-computed by FC).
  // ROW_NUMBER over the full window gives us current + previous for
  // trend; the same rows feed the per-pipeline sparkline arrays
  // returned alongside, so cards can render a 24h backlog trend
  // without fanning out a usePipelineDetail call per pipeline.
  const [historyRows, agentRuns] = await Promise.all([
    env.DB.prepare(`
      SELECT backlog_name, count, recorded_at,
             ROW_NUMBER() OVER (PARTITION BY backlog_name ORDER BY recorded_at DESC) AS rn
      FROM backlog_history
      WHERE recorded_at > datetime('now', '-1 day')
    `).all<{ backlog_name: string; count: number; recorded_at: string; rn: number }>(),

    // Last run per agent for "last processed" timestamp and throughput
    env.DB.prepare(`
      SELECT agent_id, MAX(completed_at) AS last_run_at,
             records_processed, duration_ms, status
      FROM agent_runs
      WHERE completed_at > datetime('now', '-24 hours')
      GROUP BY agent_id
    `).all<{ agent_id: string; last_run_at: string; records_processed: number; duration_ms: number; status: string }>(),
  ]);

  // Build latest + previous per backlog
  const latestByName = new Map<string, { count: number; recorded_at: string }>();
  const previousByName = new Map<string, { count: number; recorded_at: string }>();
  // Per-pipeline 24h sparkline series (oldest → newest). Same source
  // rows the latest/previous derivation uses, just collated into
  // an array per pipeline. ~12 samples / 24h × ~15 pipelines = ~180
  // rows total to bucket in JS — negligible.
  const sparklineByName = new Map<string, Array<{ count: number; recorded_at: string }>>();
  for (const row of historyRows.results) {
    if (row.rn === 1) latestByName.set(row.backlog_name, { count: row.count, recorded_at: row.recorded_at });
    if (row.rn === 2) previousByName.set(row.backlog_name, { count: row.count, recorded_at: row.recorded_at });
    const arr = sparklineByName.get(row.backlog_name);
    const sample = { count: row.count, recorded_at: row.recorded_at };
    if (arr) arr.push(sample);
    else sparklineByName.set(row.backlog_name, [sample]);
  }
  // ROW_NUMBER ordered DESC; flip to chronological for the chart.
  for (const arr of sparklineByName.values()) arr.reverse();

  // Build agent last-run map
  const agentLastRun = new Map(agentRuns.results.map(r => [r.agent_id, r]));

  // Assemble pipeline entries
  const pipelines = Object.entries(PIPELINE_META).map(([name, meta]) => {
    const latest = latestByName.get(name);
    const previous = previousByName.get(name);
    const agentRun = agentLastRun.get(meta.agent);

    const count = latest?.count ?? 0;
    const prevCount = previous?.count ?? null;
    const trend = prevCount !== null ? count - prevCount : null;

    const trendDirection: 'up' | 'down' | 'flat' | 'unknown' =
      trend === null ? 'unknown' : trend < 0 ? 'down' : trend > 0 ? 'up' : 'flat';
    return {
      id: name,
      label: meta.label,
      description: meta.description,
      agent: meta.agent,
      schedule: meta.schedule,
      endpoints: meta.endpoints ?? null,
      count,
      prev_count: prevCount,
      trend,                               // negative = draining, positive = growing, null = no data
      trend_direction: trendDirection,
      verdict: computeBacklogVerdict(count, trendDirection),
      last_measured_at: latest?.recorded_at ?? null,
      agent_last_run_at: agentRun?.last_run_at ?? null,
      agent_last_status: agentRun?.status ?? null,
      agent_records_processed: agentRun?.records_processed ?? null,
      sparkline: sparklineByName.get(name) ?? [],
    };
  });

  // GeoIP DB pipeline entry — synthetic because GeoIP isn't a
  // backlog (no rows draining toward zero); it's a reference
  // dataset whose health is "is the table populated and recently
  // refreshed?". Pulling the row count + last refresh from the
  // dedicated GEOIP_DB lets the Pipeline Automation card
  // surface this as one tile alongside Geo Enrichment and DNS
  // Resolution. count=row_count, prev_count=row_count - rows_written
  // so the "trend" arrow shows what the most recent refresh added.
  const geoipAgentRun = agentLastRun.get('geoip_refresh');
  try {
    const { getGeoMmdbStatus } = await import("../lib/geoip-mmdb");
    const geoipStatus = await getGeoMmdbStatus(env);
    const rowCount = geoipStatus.row_count ?? 0;
    const rowsWritten = geoipStatus.last_refresh_rows_written ?? 0;
    const prev = rowCount - rowsWritten;
    const trend = rowsWritten > 0 ? rowsWritten : null;
    pipelines.push({
      id: 'geoip',
      label: 'GeoIP Database',
      description: 'MaxMind GeoLite2 IP→geo range table. Refreshed weekly.',
      agent: 'geoip_refresh',
      schedule: 'monthly',
      endpoints: [
        { name: 'MaxMind GeoLite2', url: 'https://download.maxmind.com' },
      ],
      count: rowCount,
      prev_count: prev,
      // For GeoIP, "up" trend means more rows = good (opposite of
      // backlog metrics). The Pipeline card uses trend_direction
      // for arrow styling — keep it neutral when configured but
      // empty so it doesn't look alarming pre-load.
      trend,
      trend_direction: !geoipStatus.configured
        ? 'unknown'
        : rowCount === 0
          ? 'flat'
          : (rowsWritten > 0 ? 'up' : 'flat'),
      verdict: computeReferenceDatasetVerdict(
        rowCount,
        geoipStatus.configured,
        rowsWritten,
        geoipStatus.last_refresh_status,
        geoipStatus.last_refresh_at,
      ),
      last_measured_at: geoipStatus.last_refresh_at,
      agent_last_run_at: geoipAgentRun?.last_run_at ?? null,
      agent_last_status: geoipStatus.last_refresh_status ?? geoipAgentRun?.status ?? null,
      agent_records_processed: rowsWritten,
      // GeoIP isn't a backlog — no per-hour count history. Empty
      // array keeps the response shape stable; the card will skip
      // the sparkline render.
      sparkline: [],
    });
  } catch (err) {
    console.error('[pipeline-status] geoip status error:', err);
    // Non-fatal — surface a "not configured" tile so the operator
    // sees the line item instead of nothing.
    pipelines.push({
      id: 'geoip',
      label: 'GeoIP Database',
      description: 'MaxMind GeoLite2 IP→geo range table. Refreshed weekly.',
      agent: 'geoip_refresh',
      schedule: 'monthly',
      endpoints: [{ name: 'MaxMind GeoLite2', url: 'https://download.maxmind.com' }],
      count: 0,
      prev_count: null,
      trend: null,
      trend_direction: 'unknown',
      verdict: { label: 'SETUP', tone: 'pending' },
      last_measured_at: null,
      agent_last_run_at: null,
      agent_last_status: 'unconfigured',
      agent_records_processed: null,
      sparkline: [],
    });
  }

  const data = { success: true, data: pipelines };
  await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
  return json(data, 200, origin);
}

// ─── Pipeline Detail (drill-down) ────────────────────────────────
//
// GET /api/admin/pipeline-status/:id
//
// Powers the tap-to-drill-down sheet on the Agents-Monitor view.
// Returns the same per-pipeline shape as `handlePipelineStatus`
// PLUS:
//   - sparkline:           24h hourly backlog series
//   - drained_last_hour:   delta vs the hour-ago snapshot
//   - last_run:            most recent agent_runs row for the
//                          owning agent (status, records, duration)
//   - failure_rate_24h:    feed_pull_history aggregate (only for
//                          pipelines mapped to a feed_name)
//   - why_grows:           plain-English explanation of the
//                          pipeline's growth dynamics
//
// Cached separately under `pipeline_detail:<id>:v1` for 60s.
// Detail pages don't need the same 5-min freshness as the list —
// operators tap through during a triage session and want fresh
// numbers, but the underlying queries are cheap enough that 60s
// cache + index-driven scans keeps D1 spend negligible.
export async function handlePipelineDetail(
  request: Request,
  env: Env,
  pipelineId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  const cacheKey = `pipeline_detail:${pipelineId}:v1`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    try {
      return json(JSON.parse(cached), 200, origin);
    } catch (err) {
      console.error(`[pipeline-detail] corrupt cache for ${cacheKey}, recomputing:`, err);
      await env.CACHE.delete(cacheKey);
    }
  }

  // Geoip is special — its "backlog" is row count, not a draining
  // queue. Detail-sheet treatment is the same shape, just with
  // different prose.
  if (pipelineId === 'geoip') {
    try {
      return await handleGeoipDetail(request, env, origin);
    } catch (err) {
      console.error('[pipeline-detail] handleGeoipDetail threw:', err);
      return json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }, 500, origin);
    }
  }

  const meta = PIPELINE_META[pipelineId];
  if (!meta) {
    return json({ success: false, error: `Unknown pipeline: ${pipelineId}` }, 404, origin);
  }

  // Parallel queries — all index-driven, all bounded.
  const [history, agentRun, feedStats] = await Promise.all([
    // 24h sparkline. Each pipeline gets ~12 samples/24h (FC writes
    // backlog snapshots roughly hourly), so this returns at most
    // ~30 rows.
    env.DB.prepare(`
      SELECT count, recorded_at
        FROM backlog_history
       WHERE backlog_name = ?
         AND recorded_at >= datetime('now', '-1 day')
       ORDER BY recorded_at ASC
    `).bind(pipelineId).all<{ count: number; recorded_at: string }>(),

    // Latest agent run for the owning agent. Used for "Last run"
    // row in the sheet. Bounded to 24h so the index range scan
    // stays cheap.
    env.DB.prepare(`
      SELECT started_at, completed_at, duration_ms, status,
             records_processed, error_message
        FROM agent_runs
       WHERE agent_id = ?
         AND started_at >= datetime('now', '-1 day')
       ORDER BY started_at DESC
       LIMIT 1
    `).bind(meta.agent).first<{
      started_at: string;
      completed_at: string | null;
      duration_ms: number | null;
      status: string;
      records_processed: number | null;
      error_message: string | null;
    }>(),

    // Failure rate from feed_pull_history. Only computed for
    // pipelines mapped to a feed_name — agent-driven enrichment
    // pipelines (cartographer, analyst, brand_enrich, domain_geo)
    // have no feed_pull_history rows.
    meta.feed_name
      ? env.DB.prepare(`
          SELECT
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
            COUNT(*) AS total
          FROM feed_pull_history
          WHERE feed_name = ?
            AND started_at >= datetime('now', '-1 day')
        `).bind(meta.feed_name).first<{
          success: number;
          failed: number;
          partial: number;
          total: number;
        }>()
      : Promise.resolve(null),
  ]);

  const sparkline = history.results.map((r) => ({
    count: r.count,
    recorded_at: r.recorded_at,
  }));

  // drained_last_hour = current count − count from ~1h ago. Works
  // off whatever samples the history actually contains, falls back
  // to null when we don't have an hour-ago data point.
  const oneHourAgoMs = Date.now() - 60 * 60 * 1000;
  const hourAgoSample = sparkline.find(
    (s) => Math.abs(Date.parse(s.recorded_at + 'Z') - oneHourAgoMs) < 30 * 60 * 1000,
  );
  const currentCount = sparkline[sparkline.length - 1]?.count ?? null;
  const drainedLastHour =
    currentCount !== null && hourAgoSample
      ? hourAgoSample.count - currentCount
      : null;

  const failureRate = feedStats && feedStats.total > 0
    ? {
        success: feedStats.success ?? 0,
        failed:  feedStats.failed ?? 0,
        partial: feedStats.partial ?? 0,
        total:   feedStats.total,
        pct:     Math.round(((feedStats.failed ?? 0) / feedStats.total) * 100),
      }
    : null;

  const trendDirection = (() => {
    if (sparkline.length < 2) return 'unknown' as const;
    const first = sparkline[0]!.count;
    const last = sparkline[sparkline.length - 1]!.count;
    if (last < first) return 'down' as const;
    if (last > first) return 'up' as const;
    return 'flat' as const;
  })();

  const detail = {
    id: pipelineId,
    label: meta.label,
    description: meta.description,
    agent: meta.agent,
    schedule: meta.schedule,
    endpoints: meta.endpoints ?? null,
    why_grows: meta.why_grows ?? null,
    count: currentCount,
    sparkline,
    drained_last_hour: drainedLastHour,
    trend_direction: trendDirection,
    verdict: currentCount === null
      ? { label: 'STALE', tone: 'pending' as const }
      : computeBacklogVerdict(currentCount, trendDirection),
    last_run: agentRun
      ? {
          started_at:        agentRun.started_at,
          completed_at:      agentRun.completed_at,
          duration_ms:       agentRun.duration_ms,
          status:            agentRun.status,
          records_processed: agentRun.records_processed,
          error_message:     agentRun.error_message,
        }
      : null,
    failure_rate_24h: failureRate,
  };

  const body = { success: true, data: detail };
  await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 60 });
  return json(body, 200, origin);
}

async function handleGeoipDetail(
  _request: Request,
  env: Env,
  origin: string | null,
): Promise<Response> {
  const cacheKey = 'pipeline_detail:geoip:v1';
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  const { getGeoMmdbStatus } = await import("../lib/geoip-mmdb");
  const status = await getGeoMmdbStatus(env);

  // NX-geoip-card: surface the fields the operator actually needs
  // (source release SHA, freshness age, in-flight shadow progress)
  // as a dedicated `reference_dataset` block. The generic
  // "backlog / drained / sparkline" treatment doesn't apply to a
  // reference dataset and was rendering the card as "Not enough
  // samples yet" — wasted real estate.
  const lastRefreshAgeHours = status.last_refresh_at
    ? Math.round((Date.now() - new Date(status.last_refresh_at + 'Z').getTime()) / 3_600_000)
    : null;
  const isRunning = status.last_refresh_status === 'running';

  const detail = {
    id: 'geoip',
    label: 'GeoIP Database',
    description: 'MaxMind GeoLite2 IP→geo range table. Refreshed weekly.',
    agent: 'geoip_refresh',
    schedule: 'monthly',
    endpoints: [{ name: 'MaxMind GeoLite2', url: 'https://download.maxmind.com' }],
    why_grows:
      'Reference dataset, not a backlog. Row count changes only when ' +
      'the geoip_refresh agent imports a new MaxMind release. The ' +
      "agent polls weekly (Sunday 02:07 UTC), checks MaxMind's " +
      '.sha256 fingerprint, and skips the import if the live data is ' +
      'already current. Failures are usually MaxMind 429s (daily quota), ' +
      'R2 zip integrity errors, or the 1MiB Workflow step-output ' +
      'ceiling — see workflows/geoipRefresh.ts.',
    count: status.row_count ?? 0,
    sparkline: [],
    drained_last_hour: null,
    trend_direction: status.last_refresh_rows_written && status.last_refresh_rows_written > 0
      ? 'up' as const
      : 'flat' as const,
    verdict: computeReferenceDatasetVerdict(
      status.row_count ?? 0,
      status.configured,
      status.last_refresh_rows_written ?? 0,
      status.last_refresh_status,
      status.last_refresh_at,
    ),
    last_run: status.last_refresh_at
      ? {
          started_at:        status.last_refresh_at,
          completed_at:      status.last_refresh_at,
          duration_ms:       status.last_refresh_duration_ms,
          status:            status.last_refresh_status ?? 'unknown',
          records_processed: status.last_refresh_rows_written,
          error_message:     status.last_refresh_error,
        }
      : null,
    failure_rate_24h: null,
    recent_attempts: status.recent_attempts.slice(0, 5),
    // The new operator-focused block. UI renders this in place of the
    // generic backlog sparkline.
    reference_dataset: {
      configured:                  status.configured,
      row_count:                   status.row_count ?? 0,
      shadow_row_count:            status.shadow_row_count,
      shadow_table_present:        status.has_shadow_table ?? false,
      source_version:              status.last_refresh_source ?? null,
      last_refresh_at:             status.last_refresh_at,
      last_refresh_age_hours:      lastRefreshAgeHours,
      last_refresh_status:         status.last_refresh_status,
      last_refresh_rows_written:   status.last_refresh_rows_written,
      last_refresh_duration_ms:    status.last_refresh_duration_ms,
      last_refresh_error:          status.last_refresh_error,
      currently_running:           isRunning,
      stale_threshold_days:        7,
    },
  };
  const body = { success: true, data: detail };
  // Shorter TTL when a refresh is mid-flight so the in-flight progress
  // updates while the operator watches. Falls back to the existing 60s
  // cache otherwise.
  await env.CACHE.put(cacheKey, JSON.stringify(body), {
    expirationTtl: isRunning ? 15 : 60,
  });
  return json(body, 200, origin);
}

export async function handleAdminListUsers(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0");
  const roleFilter = url.searchParams.get("role");
  const statusFilter = url.searchParams.get("status");
  const q = url.searchParams.get("q")?.trim() ?? "";

  // Shared WHERE so the total respects the active filters (the old
  // unfiltered COUNT made pagination lie whenever a filter was set).
  let where = " WHERE 1=1";
  const whereParams: unknown[] = [];

  if (roleFilter) {
    where += " AND role = ?";
    whereParams.push(roleFilter);
  }
  if (statusFilter) {
    where += " AND status = ?";
    whereParams.push(statusFilter);
  }
  if (q) {
    where += " AND (email LIKE ? OR name LIKE ?)";
    const like = `%${q.replace(/[%_]/g, "")}%`;
    whereParams.push(like, like);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, email, name, role, status, created_at, last_login, last_active, invited_by
     FROM users${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...whereParams, limit, offset).all();
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users${where}`)
    .bind(...whereParams).first<{ n: number }>();

  return json({ success: true, data: { users: results, total: total?.n ?? 0 } }, 200, origin);
}

export async function handleAdminUpdateUser(
  request: Request,
  env: Env,
  targetUserId: string,
  adminUserId: string,
  adminRole: UserRole,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  const body = await request.json().catch(() => null);
  const parsed = UpdateUserSchema.safeParse(body);
  if (!parsed.success) return json({ success: false, error: parsed.error.flatten().fieldErrors }, 400, origin);

  const { role, status } = parsed.data;
  if (role === undefined && status === undefined) {
    return json({ success: false, error: "Nothing to update" }, 400, origin);
  }

  // Only super_admin can change roles to/from admin/super_admin
  if (role && (role === "super_admin" || role === "admin") && adminRole !== "super_admin") {
    return json({ success: false, error: "Only super admins can assign admin or super_admin roles" }, 403, origin);
  }

  // Prevent self-demotion for super_admins (safety)
  if (targetUserId === adminUserId && role && role !== adminRole) {
    return json({ success: false, error: "Cannot change your own role" }, 400, origin);
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  if (role !== undefined) {
    sets.push("role = ?");
    params.push(role);
  }
  if (status !== undefined) {
    sets.push("status = ?");
    params.push(status);
  }

  params.push(targetUserId);
  await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();

  const user = await env.DB.prepare(
    "SELECT id, email, name, role, status, created_at, last_login FROM users WHERE id = ?",
  ).bind(targetUserId).first();

  if (!user) return json({ success: false, error: "User not found" }, 404, origin);

  await audit(env, {
    action: "user_updated",
    userId: adminUserId,
    resourceType: "user",
    resourceId: targetUserId,
    details: { changes: parsed.data },
    request,
  });

  return json({ success: true, data: user }, 200, origin);
}

// ─── Backfill: Classify all unclassified threats ────────────────

export async function handleBackfillClassifications(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const total = await cachedCount(env, 'count.threats.null_confidence', 60, async () => {
      const totalRow = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM threats WHERE confidence_score IS NULL"
      ).first<{ n: number }>();
      return totalRow?.n ?? 0;
    });

    if (total === 0) {
      return json({ success: true, data: { message: "No unclassified threats", total: 0, classified: 0 } }, 200, origin);
    }

    let classified = 0;
    let failed = 0;
    let batchNum = 0;
    const BATCH_SIZE = 50;

    while (true) {
      batchNum++;
      const batch = await env.DB.prepare(
        `SELECT id, malicious_url, malicious_domain, ip_address, source_feed, ioc_value, threat_type
         FROM threats WHERE confidence_score IS NULL
         ORDER BY created_at DESC LIMIT ?`
      ).bind(BATCH_SIZE).all<{
        id: string; malicious_url: string | null; malicious_domain: string | null;
        ip_address: string | null; source_feed: string; ioc_value: string | null;
        threat_type: string;
      }>();

      if (batch.results.length === 0) break;

      // Hand the entire batch to the admin_classify sync agent — one
      // agent_runs row per batch, N internal AI calls. The agent owns
      // input/output schema validation + rule-based fallback.
      const { data: agentData } = await runSyncAgent<AdminClassifyOutput>(env, adminClassifyAgent, {
        threats: batch.results.map((t) => ({
          id: t.id,
          malicious_url: t.malicious_url,
          malicious_domain: t.malicious_domain,
          ip_address: t.ip_address,
          source_feed: t.source_feed,
          ioc_value: t.ioc_value,
          threat_type: t.threat_type,
        })),
      });

      const classifications = agentData?.classifications ?? [];
      failed += (agentData?.aiAttempted ?? 0) - (agentData?.aiParsed ?? 0);

      for (const c of classifications) {
        try {
          await env.DB.prepare(
            "UPDATE threats SET confidence_score = ?, severity = COALESCE(severity, ?) WHERE id = ?"
          ).bind(c.confidence, c.severity, c.id).run();
          classified++;
        } catch (err) {
          console.error(`[backfill-classify] update failed for ${c.id}:`, err);
        }
      }

      // 1-second delay between batches to avoid API rate limits
      if (batch.results.length === BATCH_SIZE) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return json({
      success: true,
      data: { total, classified, haikuFailures: failed, batches: batchNum },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Backfill: SaaS attack technique classification ────────────
// POST /api/admin/backfill-saas-techniques
// Classifies up to 5000 unclassified threats per call using the
// PushSecurity saas-attacks taxonomy (rule-based, no AI cost).
export async function handleBackfillSaasTechniques(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const totalPending = await cachedCount(env, 'count.threats.null_saas_technique', 60, async () => {
      const totalRow = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM threats WHERE saas_technique_id IS NULL"
      ).first<{ n: number }>();
      return totalRow?.n ?? 0;
    });

    if (totalPending === 0) {
      return json({
        success: true,
        data: { message: "No threats need SaaS technique classification", total: 0, classified: 0 },
      }, 200, origin);
    }

    const batch = await env.DB.prepare(
      `SELECT id, threat_type, malicious_domain, malicious_url, source_feed
         FROM threats
        WHERE saas_technique_id IS NULL
        ORDER BY created_at DESC
        LIMIT 5000`
    ).all<{
      id:                string;
      threat_type:       string | null;
      malicious_domain:  string | null;
      malicious_url:     string | null;
      source_feed:       string | null;
    }>();

    let classified = 0;
    for (const threat of batch.results) {
      const techniqueId = classifySaasTechnique(threat);
      if (!techniqueId) continue;
      try {
        await env.DB.prepare(
          "UPDATE threats SET saas_technique_id = ? WHERE id = ?"
        ).bind(techniqueId, threat.id).run();
        classified++;
      } catch (err) {
        console.error(`[backfill-saas-techniques] update failed for ${threat.id}:`, err);
      }
    }

    return json({
      success: true,
      data: {
        totalPending,
        processed:  batch.results.length,
        classified,
        remaining:  Math.max(0, totalPending - classified),
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Backfill: Geo-enrich all threats with IP but no lat/lng ────

export async function handleBackfillGeo(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    // Count total pending before starting. cachedCount @ 60s so
    // an operator mashing "Refresh" on the backfill page doesn't
    // burn 230K rows × clicks.
    const totalPending = await cachedCount(env, 'count.threats.null_country_with_ip', 60, async () => {
      const totalRow = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM threats WHERE ip_address IS NOT NULL AND country_code IS NULL ${PRIVATE_IP_SQL_FILTER}`
      ).first<{ n: number }>();
      return totalRow?.n ?? 0;
    });

    if (totalPending === 0) {
      return json({ success: true, data: { message: "No threats need geo enrichment", total: 0, enriched: 0, remaining: 0 } }, 200, origin);
    }

    // Call the SAME enrichThreatsGeo function the Navigator uses.
    // Each call processes up to 10 threats (5 actual IP lookups due to ipinfo cap).
    // Loop multiple rounds to make meaningful progress per click.
    let totalEnriched = 0;
    let totalSkippedPrivate = 0;
    let totalSkippedNoResult = 0;
    const allErrors: string[] = [];
    const sampleIps: string[] = [];
    const MAX_ROUNDS = 20;  // 20 rounds × 5 IPs = up to 100 IPs per click

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const result = await enrichThreatsGeo(env.DB, env.CACHE, env.IPINFO_TOKEN);

      totalEnriched += result.enriched;
      totalSkippedPrivate += result.skippedPrivate;
      totalSkippedNoResult += result.skippedNoResult;
      allErrors.push(...result.errors);

      // Collect sample IPs from first round for debugging
      if (round === 1 && result.total === 0) {
        break;
      }

      if (result.total === 0) break; // No more threats to process

      // Rate-limit pause between rounds
      if (round < MAX_ROUNDS) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Sync provider counts after backfill (change-guarded shared helper —
    // only writes providers whose counts actually moved).
    try {
      const { syncHostingProviderCounts } = await import("../lib/provider-counts");
      await syncHostingProviderCounts(env);
    } catch { /* non-critical */ }
    try {
      const { syncBrandActiveThreatCounts } = await import("../lib/brand-active-counts");
      await syncBrandActiveThreatCounts(env);
    } catch { /* non-critical */ }

    const remaining = Math.max(0, totalPending - totalEnriched - totalSkippedPrivate - totalSkippedNoResult);
    return json({
      success: true,
      data: {
        total: totalPending,
        enriched: totalEnriched,
        remaining,
        skippedPrivate: totalSkippedPrivate,
        skippedNoResult: totalSkippedNoResult,
        errors: allErrors.length > 0 ? allErrors.slice(0, 20) : undefined,
      },
    }, 200, origin);
  } catch (err) {
    console.error(`[backfill-geo] Fatal error:`, err);
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Backfill: Resolve malicious domains → IP → geo + hosting provider ────
//
// POST /api/admin/backfill-domain-geo
//
// 91K+ threats have a malicious_domain but no ip_address. This endpoint
// resolves up to 250 unique unresolved domains per call via Cloudflare DoH
// (1.1.1.1), geo-enriches the resulting IPs via the existing ipinfo pipeline,
// then bulk-updates every threat sharing each domain.
//
// Core batch logic lives in lib/dns-backfill.ts (shared with Navigator cron).
// The frontend loops this endpoint until remaining === 0.
export async function handleBackfillDomainGeo(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    // Count remaining unresolved domains.
    //
    // PR-4: reads from dns_queue (DNS_QUEUE_DB) — the source of
    // truth for cooldown + attempts state after cleanup. PK on
    // malicious_domain means no DISTINCT needed; partial index on
    // attempts < 8 means no domain-format filters needed (reconciler
    // already gates those on insert). Falls back to threats-side
    // count when DNS_QUEUE_DB is unbound (dev), preserving the
    // admin button's contract even on environments that haven't
    // rolled out the queue split.
    const totalPending = await cachedCount(env, 'count.dns_queue.backlog', 60, async () => {
      if (env.DNS_QUEUE_DB) {
        try {
          const row = await env.DNS_QUEUE_DB.prepare(
            `SELECT COUNT(*) AS n FROM dns_queue WHERE enrichment_attempts < 8`
          ).first<{ n: number }>();
          return row?.n ?? 0;
        } catch {
          // Fall through to threats-side query
        }
      }
      const row = await env.DB.prepare(`
        SELECT COUNT(DISTINCT malicious_domain) AS n
        FROM threats
        WHERE ip_address IS NULL
          AND status = 'active'
          AND dns_exhausted_at IS NULL
          AND COALESCE(enrichment_attempts, 0) < 8
          AND malicious_domain IS NOT NULL
          AND malicious_domain != ''
          AND malicious_domain NOT LIKE '*%'
          AND malicious_domain LIKE '%.%'
      `).first<{ n: number }>();
      return row?.n ?? 0;
    });

    if (totalPending === 0) {
      return json({
        success: true,
        data: {
          message: "No domains pending resolution",
          processed: 0,
          resolved: 0,
          enriched: 0,
          remaining: 0,
        },
      }, 200, origin);
    }

    // Admin endpoint uses 250 batch (matches original behaviour).
    // No hard timeout — the admin endpoint runs under the 15-min CPU ceiling.
    const { runDomainGeoBackfillBatch } = await import('../lib/dns-backfill');
    const result = await runDomainGeoBackfillBatch(env, { batchSize: 250, timeoutMs: 60_000 });

    return json({
      success: true,
      data: {
        processed: result.processed,
        resolved: result.resolved,
        enriched: result.enriched,
        remaining: Math.max(0, totalPending - result.processed),
      },
    }, 200, origin);
  } catch (err) {
    console.error(`[backfill-domain-geo] Fatal error:`, err);
    return json({
      success: false,
      error: err instanceof Error ? err.message : "An internal error occurred",
    }, 500, origin);
  }
}

// POST /api/admin/backfill-brand-enrichment
// Populates logo_url, website_url, hq_lat, hq_lng, hq_country
// for brands that haven't been enriched yet.
// Processes 50 brands per call (logo HEAD + DNS + ipapi = 3 subrequests each max).
export async function handleBackfillBrandEnrichment(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const { enrichBrand } = await import("../lib/brand-enricher");

    // Count remaining (skip rows that have already failed 5 times)
    const totalRow = await env.DB.prepare(`
      SELECT COUNT(*) as n FROM brands
      WHERE enriched_at IS NULL
        AND COALESCE(enrich_attempts, 0) < 5
        AND canonical_domain IS NOT NULL
        AND canonical_domain != ''
    `).first<{ n: number }>();
    const totalPending = totalRow?.n ?? 0;

    if (totalPending === 0) {
      return json({
        success: true,
        data: {
          message: "All brands enriched",
          processed: 0,
          enriched: 0,
          remaining: 0,
        },
      }, 200, origin);
    }

    // Fetch batch
    const batch = await env.DB.prepare(`
      SELECT id, canonical_domain FROM brands
      WHERE enriched_at IS NULL
        AND COALESCE(enrich_attempts, 0) < 5
        AND canonical_domain IS NOT NULL
        AND canonical_domain != ''
      LIMIT 50
    `).all<{ id: string; canonical_domain: string }>();

    let enriched = 0;

    for (const brand of batch.results) {
      try {
        const result = await enrichBrand(brand.canonical_domain, env.CACHE, env);

        // If every field came back null, treat this as a failed attempt:
        // bump the attempt counter but DO NOT set enriched_at, so the
        // next cron tick will retry until the row succeeds or hits 5.
        const hasAnyData =
          result.logo_url !== null ||
          result.hq_lat !== null ||
          result.hq_lng !== null ||
          result.hq_country !== null ||
          result.hq_ip !== null;

        if (!hasAnyData) {
          await env.DB.prepare(
            `UPDATE brands SET enrich_attempts = COALESCE(enrich_attempts, 0) + 1 WHERE id = ?`,
          ).bind(brand.id).run();
          continue;
        }

        await env.DB.prepare(`
          UPDATE brands SET
            logo_url    = COALESCE(logo_url, ?),
            website_url = COALESCE(website_url, ?),
            hq_lat      = COALESCE(hq_lat, ?),
            hq_lng      = COALESCE(hq_lng, ?),
            hq_country  = COALESCE(hq_country, ?),
            hq_ip       = COALESCE(hq_ip, ?),
            enriched_at = datetime('now')
          WHERE id = ?
        `).bind(
          result.logo_url,
          result.website_url,
          result.hq_lat,
          result.hq_lng,
          result.hq_country,
          result.hq_ip,
          brand.id,
        ).run();

        enriched++;
      } catch (err) {
        console.error(`[backfill-brand-enrichment] failed for ${brand.id}:`, err);
        // Bump attempt counter so we retry next tick instead of marking
        // a permanently-broken row as enriched.
        await env.DB.prepare(
          `UPDATE brands SET enrich_attempts = COALESCE(enrich_attempts, 0) + 1 WHERE id = ?`,
        ).bind(brand.id).run();
      }
    }

    return json({
      success: true,
      data: {
        processed: batch.results.length,
        enriched,
        remaining: Math.max(0, totalPending - batch.results.length),
      },
    }, 200, origin);
  } catch (err) {
    console.error(`[backfill-brand-enrichment] Fatal error:`, err);
    return json({
      success: false,
      error: err instanceof Error ? err.message : "An internal error occurred",
    }, 500, origin);
  }
}

// POST /api/admin/backfill-brand-sector
// Classifies brand sectors via Haiku + fetches RDAP registrant data.
// 20 brands per call (Haiku + RDAP + title fetch ≈ 3 subrequests each).
export async function handleBackfillBrandSector(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const { fetchRdap, heuristicClassifySector } = await import("../lib/brand-enricher");
    const { runSyncAgent } = await import("../lib/agentRunner");
    const { brandEnricherAgent } = await import("../agents/brand-enricher");
    type SectorResult = { sector: string; aiSucceeded: boolean };

    if (!env.ANTHROPIC_API_KEY) {
      return json({
        success: false,
        error:   "ANTHROPIC_API_KEY not configured",
      }, 500, origin);
    }

    // Skip tier='tracked' — those are mostly Tranco-imported brands
    // with no customer interest. They get classified on-demand if
    // promoted to monitored later. Only classify the brands that
    // actually surface in operator workflows.
    const tierFilter = `AND b.tier IN ('monitored','customer')`;

    // Count remaining (skip rows that have already failed 5 times)
    const totalRow = await env.DB.prepare(`
      SELECT COUNT(*) as n FROM brands b
      WHERE (b.sector IS NULL OR b.sector_classified_at IS NULL)
        AND COALESCE(b.sector_attempts, 0) < 5
        AND b.canonical_domain IS NOT NULL
        AND b.canonical_domain != ''
        ${tierFilter}
    `).first<{ n: number }>();
    const totalPending = totalRow?.n ?? 0;

    if (totalPending === 0) {
      return json({
        success: true,
        data: {
          message:    "All brands classified",
          processed:  0,
          classified: 0,
          remaining:  0,
        },
      }, 200, origin);
    }

    // Batch lifted from 20 → 100 per call. Loop is parallelized below
    // (Promise.all chunks of 8) so the CPU/network load is spread,
    // not concentrated.
    const batch = await env.DB.prepare(`
      SELECT b.id, b.name, b.canonical_domain FROM brands b
      WHERE (b.sector IS NULL OR b.sector_classified_at IS NULL)
        AND COALESCE(b.sector_attempts, 0) < 5
        AND b.canonical_domain IS NOT NULL
        AND b.canonical_domain != ''
        ${tierFilter}
      LIMIT 100
    `).all<{ id: string; name: string; canonical_domain: string }>();

    let classified = 0;
    let heuristicHits = 0;
    let aiCalls = 0;

    // Process the batch in parallel chunks of 8 — each chunk awaits
    // before the next starts so we don't blow CPU/subrequest budgets.
    const CONCURRENCY = 8;

    async function classifyOne(brand: { id: string; name: string; canonical_domain: string }): Promise<void> {
      try {
        // Heuristic-first: single regex pass covers government, education,
        // finance, healthcare, travel, telecom, gaming, energy, media via
        // TLD + brand-name keyword matches. Returns null on ambiguous
        // brands so we fall through to AI for the long tail.
        const heuristicSector = heuristicClassifySector(brand.canonical_domain, brand.name);

        // RDAP runs in parallel with sector resolution either way.
        const rdapPromise = fetchRdap(brand.canonical_domain);

        let sectorVal: string | null = null;
        if (heuristicSector) {
          heuristicHits++;
          sectorVal = heuristicSector;
        } else {
          aiCalls++;
          const ai = await runSyncAgent<SectorResult>(env, brandEnricherAgent, {
            domain: brand.canonical_domain,
            brandName: brand.name,
          });
          sectorVal = ai.data?.sector ?? null;
        }

        const rdapData = await rdapPromise.catch(() => null);

        const hasAnyData =
          sectorVal !== null ||
          rdapData?.registrar != null ||
          rdapData?.registered_at != null ||
          rdapData?.expires_at != null ||
          rdapData?.registrant_country != null;

        if (!hasAnyData) {
          await env.DB.prepare(
            `UPDATE brands SET sector_attempts = COALESCE(sector_attempts, 0) + 1 WHERE id = ?`,
          ).bind(brand.id).run();
          return;
        }

        await env.DB.prepare(`
          UPDATE brands SET
            sector               = COALESCE(sector, ?),
            registrar            = COALESCE(registrar, ?),
            registered_at        = COALESCE(registered_at, ?),
            expires_at           = COALESCE(expires_at, ?),
            registrant_country   = COALESCE(registrant_country, ?),
            sector_classified_at = datetime('now')
          WHERE id = ?
        `).bind(
          sectorVal,
          rdapData?.registrar          ?? null,
          rdapData?.registered_at      ?? null,
          rdapData?.expires_at         ?? null,
          rdapData?.registrant_country ?? null,
          brand.id,
        ).run();

        classified++;
      } catch (err) {
        console.error(`[backfill-brand-sector] failed for ${brand.id}:`, err);
        await env.DB.prepare(
          `UPDATE brands SET sector_attempts = COALESCE(sector_attempts, 0) + 1 WHERE id = ?`,
        ).bind(brand.id).run();
      }
    }

    for (let i = 0; i < batch.results.length; i += CONCURRENCY) {
      const chunk = batch.results.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(classifyOne));
    }

    return json({
      success: true,
      data: {
        processed:  batch.results.length,
        classified,
        heuristic_hits: heuristicHits,
        ai_calls: aiCalls,
        remaining:  Math.max(0, totalPending - batch.results.length),
      },
    }, 200, origin);
  } catch (err) {
    console.error(`[backfill-brand-sector] Fatal error:`, err);
    return json({
      success: false,
      error:   err instanceof Error ? err.message : "An internal error occurred",
    }, 500, origin);
  }
}

// Core brand-match backfill logic — returns { matched, checked, pending }
export async function runBrandMatchBackfill(env: Env): Promise<{ matched: number; checked: number; pending: number }> {
  const brandRows = await env.DB.prepare(
    "SELECT id, name, canonical_domain FROM brands",
  ).all<{ id: string; name: string; canonical_domain: string }>();

  const brands = brandRows.results;
  if (brands.length === 0) return { matched: 0, checked: 0, pending: 0 };

  // PR-BL: TTL bumped 60s → 600s. The diagnostics endpoint flagged
  // this as the #3 D1 read offender (~17.8M rows / 87 calls / 24h)
  // because runBrandMatchBackfill is called hourly from the orchestrator
  // plus 1-2× from manual triggers. At 60s every call was a miss; at
  // 600s only the first call per 10-min window hits the full scan.
  // The downstream LIMIT 500 still bounds the work per call, and the
  // count is only used as a gate (skip if 0 / report `remaining`), so
  // sub-10-min staleness is harmless.
  const totalPending = await cachedCount(env, 'count.threats.unattributed_with_ioc', 600, async () => {
    const pendingRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM threats WHERE target_brand_id IS NULL AND (malicious_domain IS NOT NULL OR malicious_url IS NOT NULL OR ioc_value IS NOT NULL)",
    ).first<{ n: number }>();
    return pendingRow?.n ?? 0;
  });

  if (totalPending === 0) return { matched: 0, checked: 0, pending: 0 };

  const rows = await env.DB.prepare(
    `SELECT id, malicious_domain, malicious_url, ioc_value FROM threats
     WHERE target_brand_id IS NULL AND (malicious_domain IS NOT NULL OR malicious_url IS NOT NULL OR ioc_value IS NOT NULL)
     ORDER BY created_at DESC
     LIMIT 500`,
  ).all<{ id: string; malicious_domain: string | null; malicious_url: string | null; ioc_value: string | null }>();

  let matched = 0;

  for (const row of rows.results) {
    const haystacks = [row.malicious_domain, row.malicious_url, row.ioc_value].filter(
      (v): v is string => v != null && v.length > 0,
    );
    if (haystacks.length === 0) continue;

    const brandId = fuzzyMatchBrand(haystacks, brands);
    if (!brandId) continue;

    try {
      await env.DB.prepare(
        "UPDATE threats SET target_brand_id = ? WHERE id = ? AND target_brand_id IS NULL",
      ).bind(brandId, row.id).run();

      await env.DB.prepare(
        `UPDATE brands SET
           threat_count = threat_count + 1,
           last_threat_seen = datetime('now')
         WHERE id = ?`,
      ).bind(brandId).run();

      matched++;
    } catch (err) {
      console.error(`[backfill-brand-match] update failed for ${row.id}:`, err);
    }
  }

  const pending = Math.max(0, totalPending - rows.results.length);
  return { matched, checked: rows.results.length, pending };
}

// POST /api/admin/backfill-brand-match
export async function handleBackfillBrandMatch(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const body = await request.json().catch(() => null) as { rounds?: number } | null;
    const rounds = Math.min(Math.max(body?.rounds ?? 1, 1), 20);

    let totalMatched = 0;
    let totalChecked = 0;
    let lastPending = 0;

    for (let i = 0; i < rounds; i++) {
      const result = await runBrandMatchBackfill(env);
      totalMatched += result.matched;
      totalChecked += result.checked;
      lastPending = result.pending;
      if (result.pending === 0 || result.checked === 0) break;
    }

    return json({
      success: true,
      data: { matched: totalMatched, checked: totalChecked, pending: lastPending, rounds },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── AI Attribution (Haiku-powered batch brand attribution) ────

const GENERIC_HOSTING_DOMAINS = [
  'gitbook.io', 'github.io', 'pages.dev', 'netlify.app',
  'vercel.app', 'glitch.me', 'weebly.com', 'wordpress.com',
  'blogspot.com', 'herokuapp.com', 'firebaseapp.com', 'web.app',
];

function extractSignal(domain: string | null, url: string | null): string | null {
  if (!domain && !url) return null;
  const d = domain || '';
  // Check if it's on a generic hosting domain
  for (const generic of GENERIC_HOSTING_DOMAINS) {
    if (d.endsWith('.' + generic) || d === generic) {
      const subdomain = d.replace('.' + generic, '');
      if (subdomain.length >= 5 && /[a-z]/.test(subdomain)) return subdomain;
      return null; // Too short or purely numeric
    }
  }
  if (!d || d.length < 4) return null;
  return d;
}

export async function runAiAttribution(env: Env, maxBatch = 50): Promise<{
  attributed: number; skipped: number; calls: number; costUsd: number; cached: number;
}> {
  const result = { attributed: 0, skipped: 0, calls: 0, costUsd: 0, cached: 0 };

  // Fetch unattributed threats with domain signals
  const rows = await env.DB.prepare(
    `SELECT id, malicious_domain, malicious_url, ioc_value FROM threats
     WHERE target_brand_id IS NULL
       AND (malicious_domain IS NOT NULL OR malicious_url IS NOT NULL)
       AND threat_type IN ('phishing', 'credential_harvesting', 'typosquatting', 'impersonation')
     ORDER BY created_at DESC LIMIT ?`
  ).bind(maxBatch * 3).all<{
    id: string; malicious_domain: string | null; malicious_url: string | null; ioc_value: string | null;
  }>();

  if (rows.results.length === 0) return result;

  // Group by signal for deduplication
  const signalMap = new Map<string, { ids: string[]; url: string | null }>();
  for (const row of rows.results) {
    const signal = extractSignal(row.malicious_domain, row.malicious_url);
    if (!signal) { result.skipped++; continue; }

    const existing = signalMap.get(signal);
    if (existing) {
      existing.ids.push(row.id);
    } else {
      signalMap.set(signal, { ids: [row.id], url: row.malicious_url });
    }
  }

  // Check KV cache for already-attributed signals
  const uncachedSignals: Array<{ signal: string; ids: string[]; url: string | null }> = [];
  for (const [signal, data] of signalMap) {
    const cached = await env.CACHE.get('brand_attr_' + signal);
    if (cached) {
      result.cached++;
      // Apply cached result
      try {
        const parsed = JSON.parse(cached) as { brand_id: string | null };
        if (parsed.brand_id) {
          for (const id of data.ids) {
            await env.DB.prepare(
              "UPDATE threats SET target_brand_id = ? WHERE id = ? AND target_brand_id IS NULL"
            ).bind(parsed.brand_id, id).run();
          }
          await env.DB.prepare(
            "UPDATE brands SET threat_count = threat_count + ?, last_threat_seen = datetime('now') WHERE id = ?"
          ).bind(data.ids.length, parsed.brand_id).run();
          result.attributed += data.ids.length;
        }
      } catch { /* cache parse error, skip */ }
      continue;
    }
    uncachedSignals.push({ signal, ids: data.ids, url: data.url });
    if (uncachedSignals.length >= maxBatch) break;
  }

  if (uncachedSignals.length === 0) return result;

  const signals = uncachedSignals.map((s, i) => ({
    id: i, signal: s.signal, full_url: s.url || s.signal,
  }));

  try {
    // Routes through the canonical wrapper → automatic budget_ledger
    // attribution against agentId="ai-attribution". Cost math + token
    // counts both come from the wrapper / BudgetManager so the
    // hand-rolled (inputTokens * 0.0000008) line is gone.
    const { parsed: attributions, response } = await callAnthropicJSON<Array<{
      id: number; brand: string; confidence: 'high' | 'medium'; reason: string;
    }>>(env, {
      agentId: "ai-attribution",
      runId: null,
      model: HOT_PATH_HAIKU,
      system: "You are a brand attribution engine for a cybersecurity platform. Given phishing domain signals, identify the real brand being impersonated. Be conservative — only attribute when genuinely confident. Reply ONLY with valid JSON, no markdown.",
      messages: [{ role: 'user', content: `Attribute these phishing signals to real brands:\n${JSON.stringify(signals)}\nReply with JSON array, only include confident matches:\n[{id, brand, confidence: "high"|"medium", reason}]\nOmit entries where brand is null or confidence is low.` }],
      maxTokens: 2048,
    });

    result.calls++;
    result.costUsd = estimateCost(
      response.model || HOT_PATH_HAIKU,
      response.usage?.input_tokens ?? 0,
      response.usage?.output_tokens ?? 0,
    );

    // Track attribution-specific call count for the cron Step 4 guard.
    // The general per-day Haiku usage now lives in budget_ledger, but
    // this specific counter is consumed by the cron flow and stays in
    // KV for now (cron path lives in a different commit).
    const today = new Date().toISOString().slice(0, 10);
    const attrKey = `ai_attr_calls_${today}`;
    const prevAttrCalls = parseInt(await env.CACHE.get(attrKey) || '0', 10);
    await env.CACHE.put(attrKey, String(prevAttrCalls + 1), { expirationTtl: 86400 * 2 });

    // Load all brands for matching
    const allBrands = await env.DB.prepare(
      "SELECT id, name FROM brands"
    ).all<{ id: string; name: string }>();
    const brandByName = new Map(allBrands.results.map(b => [b.name.toLowerCase(), b.id]));

    for (const attr of attributions) {
      if (!attr.brand || (attr.confidence !== 'high' && attr.confidence !== 'medium')) continue;
      const signalEntry = uncachedSignals[attr.id];
      if (!signalEntry) continue;

      // Look up brand
      let brandId = brandByName.get(attr.brand.toLowerCase());

      // If not found and high confidence, create brand
      if (!brandId && attr.confidence === 'high') {
        const newId = `brand_${attr.brand.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
        try {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO brands (id, name, canonical_domain, source, threat_count, first_seen)
             VALUES (?, ?, ?, 'ai_attributed', 0, datetime('now'))`
          ).bind(newId, attr.brand, signalEntry.signal).run();
          brandId = newId;
          brandByName.set(attr.brand.toLowerCase(), newId);
        } catch { continue; }
      }

      if (!brandId) continue;

      // Cache the result
      await env.CACHE.put('brand_attr_' + signalEntry.signal, JSON.stringify({ brand_id: brandId }), { expirationTtl: 86400 * 30 });

      // Apply to all threats with this signal
      for (const threatId of signalEntry.ids) {
        await env.DB.prepare(
          "UPDATE threats SET target_brand_id = ? WHERE id = ? AND target_brand_id IS NULL"
        ).bind(brandId, threatId).run();
      }
      await env.DB.prepare(
        "UPDATE brands SET threat_count = threat_count + ?, last_threat_seen = datetime('now') WHERE id = ?"
      ).bind(signalEntry.ids.length, brandId).run();
      result.attributed += signalEntry.ids.length;
    }

    // Cache null result for unmatched signals
    for (const entry of uncachedSignals) {
      const wasMatched = attributions.some(a => uncachedSignals[a.id]?.signal === entry.signal);
      if (!wasMatched) {
        await env.CACHE.put('brand_attr_' + entry.signal, JSON.stringify({ brand_id: null }), { expirationTtl: 86400 * 30 });
      }
    }
  } catch (err) {
    console.error('[ai-attribution] Haiku call failed:', err);
  }

  // Log to agent_outputs
  try {
    await env.DB.prepare(
      `INSERT INTO agent_outputs (id, agent_id, type, summary, severity, created_at)
       VALUES (?, 'analyst', 'attribution', ?, 'info', datetime('now'))`
    ).bind(
      crypto.randomUUID(),
      `AI Attribution: ${result.attributed} attributed, ${result.skipped} skipped, ${result.calls} calls, ~$${result.costUsd.toFixed(4)} USD`,
    ).run();
  } catch { /* ok */ }

  return result;
}

// POST /api/admin/backfill-ai-attribution
export async function handleBackfillAiAttribution(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const result = await runAiAttribution(env, 50);
    return json({ success: true, data: result }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/admin/backfill-safe-domains
export async function handleBackfillSafeDomains(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const brands = await env.DB.prepare(
      "SELECT id, canonical_domain FROM brands WHERE canonical_domain IS NOT NULL",
    ).all<{ id: string; canonical_domain: string }>();

    let domainsAdded = 0;
    for (const brand of brands.results) {
      const domain = brand.canonical_domain;
      if (!domain) continue;

      // Add exact domain
      const r1 = await env.DB.prepare(
        `INSERT OR IGNORE INTO brand_safe_domains (id, brand_id, domain, added_by, source)
         VALUES (?, ?, ?, NULL, 'auto_detected')`,
      ).bind(crypto.randomUUID(), brand.id, domain).run();
      if (r1.meta?.changes) domainsAdded++;

      // Add www variant
      const r2 = await env.DB.prepare(
        `INSERT OR IGNORE INTO brand_safe_domains (id, brand_id, domain, added_by, source)
         VALUES (?, ?, ?, NULL, 'auto_detected')`,
      ).bind(crypto.randomUUID(), brand.id, "www." + domain).run();
      if (r2.meta?.changes) domainsAdded++;

      // Add wildcard
      const r3 = await env.DB.prepare(
        `INSERT OR IGNORE INTO brand_safe_domains (id, brand_id, domain, added_by, source)
         VALUES (?, ?, ?, NULL, 'auto_detected')`,
      ).bind(crypto.randomUUID(), brand.id, "*." + domain).run();
      if (r3.meta?.changes) domainsAdded++;
    }

    return json({
      success: true,
      data: { brands_processed: brands.results.length, domains_added: domainsAdded },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/admin/import-tranco ──────────────────────────────

const TRANCO_CSV_URL = "https://tranco-list.eu/top-1m.csv.zip";

/**
 * Coarsen a Tranco rank into the reputation bucket the platform
 * actually consumes. Returning the SAME bucket on both old and new
 * rank values means a per-brand UPDATE can be skipped — D1 write
 * audit (2026-05-20) showed ~76K Tranco rank UPDATEs/day on top-of-list
 * jitter that doesn't move any brand across a bucket boundary.
 *
 * Buckets:
 *   1   — top-1K       (high-trust, household names)
 *   2   — top-10K      (mainstream)
 *   3   — top-100K     (midmarket)
 *   4   — top-1M       (long-tail)
 *   5   — unranked     (null / beyond 1M)
 *
 * The numeric bucket id is internal; comparing values is sufficient.
 */
export function trancoRankBucket(rank: number | null | undefined): number {
  if (rank == null || rank <= 0) return 5;
  if (rank <= 1_000) return 1;
  if (rank <= 10_000) return 2;
  if (rank <= 100_000) return 3;
  if (rank <= 1_000_000) return 4;
  return 5;
}

export async function handleImportTranco(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => null) as {
      limit?: number;
      min_rank?: number;
      max_rank?: number;
      sectors?: Record<string, string>;
    } | null;

    // Hard ceiling 100K per call. Tranco file itself is up to 1M; we cap at
    // 100K to keep the brand catalog focused. Daily orchestrator currently
    // requests 25K (incremental); super_admin can trigger the full 100K
    // out-of-band via /api/admin/import-tranco for the bulk seed.
    const limit = Math.min(body?.limit ?? 100000, 100000);
    const minRank = body?.min_rank ?? 1;
    const maxRank = body?.max_rank ?? limit;

    // Fetch Tranco CSV (rank,domain format)
    const res = await fetch(TRANCO_CSV_URL);
    if (!res.ok) throw new Error(`Tranco fetch failed: HTTP ${res.status}`);

    // Tranco serves a zip — decompress it
    const zipBuffer = await res.arrayBuffer();
    const csvText = await extractCsvFromZip(zipBuffer);
    if (!csvText) throw new Error("Failed to extract CSV from Tranco zip");

    const lines = csvText.split("\n").filter(Boolean);
    const candidates: Array<{ rank: number; domain: string }> = [];

    for (const line of lines) {
      const [rankStr, domain] = line.split(",");
      if (!rankStr || !domain) continue;
      const rank = parseInt(rankStr, 10);
      if (rank < minRank || rank > maxRank) continue;
      const cleanDomain = domain.trim().toLowerCase();
      const baseName = cleanDomain.split(".")[0] ?? "";
      // Skip short names (< 4 chars) and purely numeric domains
      if (baseName.length < 4 || /^\d+$/.test(baseName)) continue;
      candidates.push({ rank, domain: cleanDomain });
      if (candidates.length >= limit) break;
    }

    // Load existing brands (id + canonical_domain + tranco_rank). Lets us
    // (a) skip INSERT for dupes and (b) UPDATE tranco_rank where the import
    // disagrees with the stored value (rank drifts week-over-week).
    const existing = await env.DB.prepare(
      "SELECT id, canonical_domain, tranco_rank FROM brands"
    ).all<{ id: string; canonical_domain: string; tranco_rank: number | null }>();
    const existingMap = new Map(
      existing.results.map(r => [r.canonical_domain.toLowerCase(), r])
    );

    const toImport: Array<{ rank: number; domain: string }> = [];
    const toUpdate: Array<{ rank: number; domain: string }> = [];
    // Bucket-based skip filter (PR-BJ — write-budget Phase 1, change A):
    // we previously wrote whenever the new Tranco rank differed AT ALL
    // from the stored value. Tranco's daily list has heavy intra-rank
    // churn (~76K rank-jitter updates/day in production), but the
    // PLATFORM only consumes rank as a coarse reputation bucket
    // (top-1K = high-trust, top-10K = mainstream, top-100K = midmarket,
    // top-1M = long-tail). Intra-bucket drift is noise. Updating only
    // when the bucket boundary is crossed cuts the write count without
    // changing any downstream consumer behavior — every caller that
    // reads tranco_rank uses it for relative ordering or for the same
    // bucket check.
    for (const c of candidates) {
      const ex = existingMap.get(c.domain);
      if (!ex) toImport.push(c);
      else if (trancoRankBucket(ex.tranco_rank) !== trancoRankBucket(c.rank)) toUpdate.push(c);
    }
    let imported = 0;
    let updated = 0;
    const skipped = candidates.length - toImport.length - toUpdate.length;

    // Batch INSERT — brand row + brand_domains apex row (PR1 table). Both
    // wrapped in ON CONFLICT DO NOTHING semantics so re-runs are idempotent.
    const BATCH_SIZE = 50;
    for (let i = 0; i < toImport.length; i += BATCH_SIZE) {
      const batch = toImport.slice(i, i + BATCH_SIZE);
      const stmts: D1PreparedStatement[] = [];
      for (const c of batch) {
        const brandId = `brand_${c.domain.replace(/[^a-z0-9]+/g, "_")}`;
        const name = extractBrandName(c.domain);
        const sector = body?.sectors?.[c.domain] ?? null;
        stmts.push(env.DB.prepare(
          `INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, first_seen, threat_count, tranco_rank)
           VALUES (?, ?, ?, ?, 'tranco', datetime('now'), 0, ?)`
        ).bind(brandId, name, c.domain, sector, c.rank));
        stmts.push(env.DB.prepare(
          `INSERT OR IGNORE INTO brand_domains (id, brand_id, domain, domain_type, source, verified, first_seen, last_seen)
           VALUES (?, ?, ?, 'apex', 'tranco', 1, datetime('now'), datetime('now'))`
        ).bind(`bd_${brandId}_apex`, brandId, c.domain));
      }
      await env.DB.batch(stmts);
      imported += batch.length;
    }

    // Batch UPDATE — refresh tranco_rank for existing brands that drifted
    // (or never had it populated due to the pre-PR2 INSERT bug).
    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
      const batch = toUpdate.slice(i, i + BATCH_SIZE);
      const stmts = batch.map(c =>
        env.DB.prepare(`UPDATE brands SET tranco_rank = ? WHERE canonical_domain = ?`)
          .bind(c.rank, c.domain)
      );
      await env.DB.batch(stmts);
      updated += batch.length;
    }

    // Clean up false positive brands — short/generic names that aren't real brands
    try {
      const GENERIC_NAMES = ['www','one','bit','dns','app','web','api','cdn','dev','net','goo','pages','forms','mail','blog','shop','host','info','link','news','data','live','play','docs','home','code','test','help','chat','free','plus','labs'];
      // Delete brands with very short names (<=3 chars) that were just imported from Tranco
      await env.DB.prepare(
        `DELETE FROM brands WHERE source = 'tranco' AND LENGTH(name) <= 3 AND threat_count = 0`
      ).run();
      // Delete purely numeric names
      await env.DB.prepare(
        `DELETE FROM brands WHERE source = 'tranco' AND threat_count = 0
         AND name GLOB '[0-9]*' AND name NOT GLOB '*[a-zA-Z]*'`
      ).run();
      // Delete generic names
      for (const generic of GENERIC_NAMES) {
        await env.DB.prepare(
          `DELETE FROM brands WHERE source = 'tranco' AND threat_count = 0 AND LOWER(name) = ?`
        ).bind(generic).run();
      }
    } catch (cleanupErr) {
      console.error('[import-tranco] cleanup error:', cleanupErr);
    }

    // Auto-run brand match backfill (10 rounds) to link existing threats to newly imported brands
    let backfillMatched = 0;
    if (imported > 0) {
      for (let i = 0; i < 10; i++) {
        const bf = await runBrandMatchBackfill(env);
        backfillMatched += bf.matched;
        if (bf.pending === 0 || bf.checked === 0) break;
      }
    }

    return json({
      success: true,
      data: {
        candidates: candidates.length,
        imported,
        updated,
        skipped,
        backfillMatched,
        message: `Imported ${imported} brands from Tranco top ${maxRank} (${updated} rank-updated, ${skipped} already up to date, ${backfillMatched} threats backfill-matched)`,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

/** Extract brand name from domain: "amazon.com" → "Amazon", "bank-of-america.com" → "Bank Of America" */
function extractBrandName(domain: string): string {
  const base = domain.split(".")[0] ?? domain;
  return base
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Minimal zip extraction — finds the first file and decompresses it */
async function extractCsvFromZip(buffer: ArrayBuffer): Promise<string | null> {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    return new TextDecoder().decode(buffer);
  }
  const compressionMethod = bytes[8]! | (bytes[9]! << 8);
  const compressedSize = bytes[18]! | (bytes[19]! << 8) | (bytes[20]! << 16) | (bytes[21]! << 24);
  const fileNameLen = bytes[26]! | (bytes[27]! << 8);
  const extraLen = bytes[28]! | (bytes[29]! << 8);
  const dataOffset = 30 + fileNameLen + extraLen;

  if (compressionMethod === 0) {
    return new TextDecoder().decode(bytes.slice(dataOffset, dataOffset + compressedSize));
  }
  if (compressionMethod === 8) {
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) { result.set(c, offset); offset += c.length; }
    return new TextDecoder().decode(result);
  }
  return null;
}

// ─── GET /api/admin/brand-candidates ──────────────────────────────
// List pending CT-driven brand candidates for operator review. Sorted
// by cert_count DESC so the highest-signal candidates float to top.

export async function handleListBrandCandidates(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? "pending";
    const limit = Math.min(200, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    const rows = await env.DB.prepare(`
      SELECT id, apex_domain, source, status, cert_count, distinct_issuers,
             first_seen, last_seen, reviewed_at, reviewed_by, promoted_brand_id, notes
      FROM brand_candidates
      WHERE status = ?
      ORDER BY cert_count DESC, last_seen DESC
      LIMIT ? OFFSET ?
    `).bind(status, limit, offset).all();

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM brand_candidates WHERE status = ?`
    ).bind(status).first<{ n: number }>();

    return json({
      success: true,
      data: rows.results,
      total: count?.n ?? 0,
    }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "List candidates failed",
    }, 500, origin);
  }
}

// ─── POST /api/admin/brand-candidates/aggregate ───────────────────
// Manual trigger for the CT-driven aggregator (also runs nightly via
// the orchestrator). Useful right after a big CT-feed catch-up.

export async function handleAggregateBrandCandidates(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const { aggregateBrandCandidates } = await import('../lib/brand-candidates');
    const summary = await aggregateBrandCandidates(env);
    return json({
      success: true,
      data: {
        ...summary,
        message: `Aggregator: scanned ${summary.scanned} apexes, proposed ${summary.proposed}, refreshed ${summary.refreshed}, skipped ${summary.skipped_existing_brand} existing brands + ${summary.skipped_already_candidate} existing candidates in ${summary.duration_ms}ms`,
      },
    }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "Aggregate failed",
    }, 500, origin);
  }
}

// ─── POST /api/admin/brand-candidates/:id/promote ──────────────────
// Operator approves a pending candidate — creates a brand row at
// tier='monitored' + a brand_domains apex entry. Requires admin.

export async function handlePromoteBrandCandidate(
  request: Request,
  env: Env,
  candidateId: string,
  reviewerUserId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const { promoteCandidate } = await import('../lib/brand-candidates');
    const result = await promoteCandidate(env, candidateId, reviewerUserId);
    return json({ success: true, data: result }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "Promote failed",
    }, 500, origin);
  }
}

// ─── POST /api/admin/brand-candidates/:id/reject ───────────────────

export async function handleRejectBrandCandidate(
  request: Request,
  env: Env,
  candidateId: string,
  reviewerUserId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => null) as { notes?: string } | null;
    const { rejectCandidate } = await import('../lib/brand-candidates');
    await rejectCandidate(env, candidateId, reviewerUserId, body?.notes ?? null);
    return json({ success: true, data: { candidate_id: candidateId } }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "Reject failed",
    }, 500, origin);
  }
}

// ─── POST /api/admin/brand-firmographics/enrich ──────────────────
// Triggers the free-source firmographic enricher (SEC EDGAR +
// Companies House + Wikidata). Picks up to 200 monitored+customer
// brands per call that don't yet have a firmographic row or whose
// row is older than 90 days.
//
// Also serves as the per-tick handler for the `enricher` cron's
// brand_firmographic job (dispatched via the same enricherJob
// machinery as domain_geo / brand_logo_hq / brand_sector_rdap).

export async function handleBackfillBrandFirmographics(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const { enrichFirmographicsBatch } = await import('../lib/firmographic-enricher');
    const summary = await enrichFirmographicsBatch(env);
    return json({
      success: true,
      data: {
        processed: summary.scanned,
        enriched:  summary.enriched,
        no_match:  summary.no_match,
        errors:    summary.errors,
        duration_ms: summary.duration_ms,
        message: `Firmographic: scanned ${summary.scanned}, enriched ${summary.enriched}, no match ${summary.no_match}, errors ${summary.errors} in ${summary.duration_ms}ms`,
      },
    }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "Firmographic enrichment failed",
    }, 500, origin);
  }
}

// ─── POST /api/admin/brand-scores/recompute-all ─────────────────
// Triggers the daily Brand Health + Brand Exposure batch on demand.
// Useful (a) right after deploy to populate the new scores without
// waiting for the 00:00 UTC cron, (b) after schema/weight changes,
// (c) for spot-fixing if the daily job failed silently.
//
// Scores monitored+customer tier brands only; tracked tier is
// scored on-demand via per-brand recompute.

export async function handleRecomputeBrandScores(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const { computeBrandScoresBatch } = await import('../lib/brand-scoring');
    const summary = await computeBrandScoresBatch(env);
    return json({
      success: true,
      data: {
        ...summary,
        message: `Scored ${summary.scored} of ${summary.scanned} brands in ${summary.duration_ms}ms (${summary.errors} errors)`,
      },
    }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "Recompute failed",
    }, 500, origin);
  }
}

// ─── GET /api/admin/brands — Admin brand management ─────────────

export async function handleAdminListBrands(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(200, parseInt(url.searchParams.get("limit") ?? "100", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const search = url.searchParams.get("q");
    const source = url.searchParams.get("source");
    const sort = url.searchParams.get("sort") ?? "threat_count";

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (search) { conditions.push("(b.name LIKE ? OR b.canonical_domain LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
    if (source) { conditions.push("b.source = ?"); params.push(source); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const sortColumn = sort === "name" ? "b.name ASC" :
      sort === "created" ? "b.first_seen DESC" :
      sort === "threats" ? "threat_count DESC" : "threat_count DESC";

    params.push(limit, offset);

    const rows = await env.DB.prepare(`
      SELECT b.id, b.name, b.canonical_domain, b.sector, b.source, b.first_seen,
             COUNT(t.id) AS threat_count,
             SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) AS active_threats,
             (SELECT COUNT(*) FROM monitored_brands mb WHERE mb.brand_id = b.id) AS is_monitored
      FROM brands b
      LEFT JOIN threats t ON t.target_brand_id = b.id
      ${where}
      GROUP BY b.id
      ORDER BY ${sortColumn}
      LIMIT ? OFFSET ?
    `).bind(...params).all();

    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM brands b ${where}`)
      .bind(...params.slice(0, -2)).first<{ n: number }>();

    // Source breakdown
    const sources = await env.DB.prepare(
      "SELECT COALESCE(source, 'manual') AS source, COUNT(*) AS count FROM brands GROUP BY source"
    ).all<{ source: string; count: number }>();

    return json({
      success: true,
      data: rows.results,
      total: total?.n ?? 0,
      sources: sources.results,
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/admin/brands/bulk-monitor — Bulk add to monitoring ─

export async function handleBulkMonitor(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => null) as { brand_ids?: string[] } | null;
    if (!body?.brand_ids?.length) return json({ success: false, error: "brand_ids required" }, 400, origin);

    const ids = body.brand_ids.slice(0, 100); // cap at 100
    let added = 0;

    const stmts = ids.map(id =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO monitored_brands (brand_id, tenant_id, added_by, status)
         VALUES (?, '__internal__', ?, 'active')`
      ).bind(id, userId)
    );

    // Batch in groups of 50
    for (let i = 0; i < stmts.length; i += 50) {
      const batch = stmts.slice(i, i + 50);
      const results = await env.DB.batch(batch);
      added += results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
    }

    return json({ success: true, data: { requested: ids.length, added } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── DELETE /api/admin/brands/bulk — Bulk delete brands ──────────

export async function handleBulkDeleteBrands(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => null) as { brand_ids?: string[] } | null;
    if (!body?.brand_ids?.length) return json({ success: false, error: "brand_ids required" }, 400, origin);

    const ids = body.brand_ids.slice(0, 100);
    let deleted = 0;

    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const placeholders = batch.map(() => "?").join(",");
      const result = await env.DB.prepare(
        `DELETE FROM brands WHERE id IN (${placeholders})`
      ).bind(...batch).run();
      deleted += result.meta?.changes ?? 0;

      // Also clean up monitored_brands
      await env.DB.prepare(
        `DELETE FROM monitored_brands WHERE brand_id IN (${placeholders})`
      ).bind(...batch).run();
    }

    await audit(env, { action: "brands_bulk_delete", userId, resourceType: "brand", resourceId: ids.join(","), details: { count: deleted }, request });
    return json({ success: true, data: { deleted } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/admin/backfill-social-config — RETIRED 2026-05-07 ───
//
// Originally migrated brand_profiles → brands unified model. The
// migration was completed in production prior to the brand_profiles
// deprecation (R9, 2026-05-07). The endpoint stays mounted but now
// returns 410 Gone so any forgotten cron/curl pointing at it gets
// a directional error instead of silently re-running stale logic.

export async function handleBackfillSocialConfig(request: Request, _env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  return json({
    success: false,
    error: "/api/admin/backfill-social-config is retired (brand_profiles deprecation, 2026-05-07). The migration ran during pre-deprecation cleanup; no further action required.",
    code: "ENDPOINT_RETIRED",
  }, 410, origin);
}

// ─── Cube Backfill (Phase 2 of OLAP rollout) ────────────────────────────────
//
// POST /api/admin/cube-backfill
//
// Query parameters:
//   - cube:        'geo' | 'provider' | 'both'   (required)
//   - days:        number 1..365                 (default 30)
//   - dry_run:     'true' | 'false'              (default 'false')
//   - resume_from: 'YYYY-MM-DD HH:00:00'         (optional; continues past this hour)
//
// Behavior:
//   1. Builds an oldest-first list of hour buckets covering the last `days` days,
//      stopping at the top of the current hour (partial hours excluded).
//   2. If resume_from is provided, skips all buckets <= resume_from so the caller
//      can continue an earlier run without double-processing.
//   3. For each hour: runs either the dry-run COUNT version or the real
//      INSERT OR REPLACE via cube-builder.ts, and streams one NDJSON line of
//      { hour, geo_rows, provider_rows, ms, error, dry_run }.
//   4. A single hour failing does NOT kill the stream — the error is reported
//      on that line and the loop continues.
//   5. If elapsed wall-clock crosses 25s, the loop stops and the summary line
//      carries `resume_from = <last successfully processed hour>` so the caller
//      can POST again with that value.
//   6. Final NDJSON line is the summary:
//        { done: bool, total_hours: N, total_rows: N, resume_from: str|null, ... }
//
// Auth: admin-gated via the same requireAdmin() middleware every other admin
// endpoint uses. Registration lives in routes/admin.ts.
//
// Phase 3 will wire cube refresh into Navigator; Phase 5 will swap Observatory
// reads over to the cube tables. Until then, nothing reads these tables.

/** Snap a Date (treated as UTC) to the top of the hour and format as SQLite 'YYYY-MM-DD HH:00:00'. */
function toHourBucket(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:00:00`;
}

export async function handleCubeBackfill(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);

  // ── Parse + validate query params ──
  const cube = url.searchParams.get("cube");
  if (
    cube !== "geo" &&
    cube !== "provider" &&
    cube !== "brand" &&
    cube !== "status" &&
    cube !== "arcs" &&
    cube !== "both" &&
    cube !== "all"
  ) {
    return json({
      success: false,
      error: "cube query param is required and must be 'geo' | 'provider' | 'brand' | 'status' | 'arcs' | 'both' | 'all'",
    }, 400, origin);
  }
  const buildGeo = cube === "geo" || cube === "both" || cube === "all";
  const buildProvider = cube === "provider" || cube === "both" || cube === "all";
  const buildBrand = cube === "brand" || cube === "all";
  const buildStatus = cube === "status" || cube === "all";
  const buildArcs = cube === "arcs" || cube === "all";

  const daysRaw = parseInt(url.searchParams.get("days") ?? "30", 10);
  const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 30, 1), 365);
  const dryRun = url.searchParams.get("dry_run") === "true";
  const resumeFrom = url.searchParams.get("resume_from");

  // ── Build oldest-first hour bucket list ──
  // Snap "now" to the top of the current hour, then walk back `days * 24` hours.
  // The current (partial) hour is NOT included — refresh of the live hour is
  // Phase 3's job, not backfill's.
  const nowSnapped = new Date();
  nowSnapped.setUTCMinutes(0, 0, 0);
  nowSnapped.setUTCMilliseconds(0);

  const totalHours = days * 24;
  const hours: string[] = [];
  for (let i = totalHours; i >= 1; i--) {
    const d = new Date(nowSnapped.getTime() - i * 3_600_000);
    hours.push(toHourBucket(d));
  }

  // Skip all buckets <= resume_from.
  let startIdx = 0;
  if (resumeFrom) {
    const idx = hours.findIndex(h => h > resumeFrom);
    startIdx = idx === -1 ? hours.length : idx;
  }

  const DEADLINE_MS = 25_000;
  const streamStart = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const enqueue = (obj: unknown): void => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      let processed = 0;
      let totalRows = 0;
      let nextResumeFrom: string | null = null;
      let lastSuccessfulHour: string | null = resumeFrom;

      try {
        for (let i = startIdx; i < hours.length; i++) {
          // Deadline check BEFORE starting a new hour so we never interrupt mid-build.
          if (Date.now() - streamStart > DEADLINE_MS) {
            nextResumeFrom = lastSuccessfulHour;
            break;
          }

          const hour = hours[i]!;
          const hourStart = Date.now();
          let geoRows = 0;
          let providerRows = 0;
          let brandRows = 0;
          let statusRows = 0;
          let arcsRows = 0;
          const errParts: string[] = [];

          try {
            if (dryRun) {
              if (buildGeo) {
                const r = await countGeoCubeForHour(env, hour);
                geoRows = r.groupedRows;
                if (r.error) errParts.push(`geo: ${r.error}`);
              }
              if (buildProvider) {
                const r = await countProviderCubeForHour(env, hour);
                providerRows = r.groupedRows;
                if (r.error) errParts.push(`provider: ${r.error}`);
              }
              if (buildBrand) {
                const r = await countBrandCubeForHour(env, hour);
                brandRows = r.groupedRows;
                if (r.error) errParts.push(`brand: ${r.error}`);
              }
              if (buildStatus) {
                const r = await countStatusCubeForHour(env, hour);
                statusRows = r.groupedRows;
                if (r.error) errParts.push(`status: ${r.error}`);
              }
              if (buildArcs) {
                const r = await countArcsCubeForHour(env, hour);
                arcsRows = r.groupedRows;
                if (r.error) errParts.push(`arcs: ${r.error}`);
              }
            } else {
              if (buildGeo) {
                const r = await buildGeoCubeForHour(env, hour);
                geoRows = r.rowsWritten;
                if (r.error) errParts.push(`geo: ${r.error}`);
              }
              if (buildProvider) {
                const r = await buildProviderCubeForHour(env, hour);
                providerRows = r.rowsWritten;
                if (r.error) errParts.push(`provider: ${r.error}`);
              }
              if (buildBrand) {
                const r = await buildBrandCubeForHour(env, hour);
                brandRows = r.rowsWritten;
                if (r.error) errParts.push(`brand: ${r.error}`);
              }
              if (buildStatus) {
                const r = await buildStatusCubeForHour(env, hour);
                statusRows = r.rowsWritten;
                if (r.error) errParts.push(`status: ${r.error}`);
              }
              if (buildArcs) {
                const r = await buildArcsCubeForHour(env, hour);
                arcsRows = r.rowsWritten;
                if (r.error) errParts.push(`arcs: ${r.error}`);
              }
            }
          } catch (err) {
            errParts.push(err instanceof Error ? err.message : String(err));
          }

          const errMsg = errParts.length > 0 ? errParts.join("; ") : null;
          totalRows += geoRows + providerRows + brandRows + statusRows + arcsRows;
          processed++;
          // Advance cursor regardless of error so we don't infinite-loop on a single
          // poison hour. The error is surfaced per-line so operators can see it.
          lastSuccessfulHour = hour;

          enqueue({
            hour,
            geo_rows: geoRows,
            provider_rows: providerRows,
            brand_rows: brandRows,
            status_rows: statusRows,
            arcs_rows: arcsRows,
            ms: Date.now() - hourStart,
            error: errMsg,
            dry_run: dryRun,
          });
        }

        // Summary line.
        enqueue({
          done: nextResumeFrom === null,
          total_hours: processed,
          total_rows: totalRows,
          resume_from: nextResumeFrom,
          dry_run: dryRun,
          cube,
          window_days: days,
        });
      } catch (err) {
        // Catastrophic stream failure — emit one final error line and close cleanly.
        enqueue({
          done: false,
          error: err instanceof Error ? err.message : String(err),
          total_hours: processed,
          total_rows: totalRows,
          resume_from: lastSuccessfulHour,
          dry_run: dryRun,
          cube,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

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
  const { fetchD1Metrics, fetchD1EndpointAttribution } = await import("./diagnostics");
  const { getBudgetDiagnostics, fetchD1TopQueries, fetchBillingCycleMetrics } = await import("../lib/d1-budget");

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
//   by_agent_30d: top 20 agents by cost in the last 30d
//   daily_30d:    30 daily buckets, oldest → newest
export async function handleMetricsAiSpend(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  const cacheKey = "metrics_ai_spend:v1";
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  // Three windowed totals + per-agent breakdown (30d) + daily
  // series (30d). All run in parallel against the same indexed
  // table; each bounded by created_at.
  const [w24h, w7d, w30d, byAgent30d, daily30d] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) AS calls,
             COALESCE(SUM(input_tokens), 0)  AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cost_usd), 0)      AS cost_usd
        FROM budget_ledger
       WHERE created_at >= datetime('now', '-1 day')
    `).first<{ calls: number; input_tokens: number; output_tokens: number; cost_usd: number }>(),

    env.DB.prepare(`
      SELECT COUNT(*) AS calls,
             COALESCE(SUM(input_tokens), 0)  AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cost_usd), 0)      AS cost_usd
        FROM budget_ledger
       WHERE created_at >= datetime('now', '-7 days')
    `).first<{ calls: number; input_tokens: number; output_tokens: number; cost_usd: number }>(),

    env.DB.prepare(`
      SELECT COUNT(*) AS calls,
             COALESCE(SUM(input_tokens), 0)  AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cost_usd), 0)      AS cost_usd
        FROM budget_ledger
       WHERE created_at >= datetime('now', '-30 days')
    `).first<{ calls: number; input_tokens: number; output_tokens: number; cost_usd: number }>(),

    env.DB.prepare(`
      SELECT agent_id,
             COUNT(*) AS calls,
             COALESCE(SUM(input_tokens), 0)  AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cost_usd), 0)      AS cost_usd
        FROM budget_ledger
       WHERE created_at >= datetime('now', '-30 days')
       GROUP BY agent_id
       ORDER BY cost_usd DESC
       LIMIT 20
    `).all<{
      agent_id: string;
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>(),

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
    `).all<{
      day: string;
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>(),
  ]);

  const data = {
    windows: {
      "24h": w24h ?? { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      "7d":  w7d  ?? { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      "30d": w30d ?? { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    },
    by_agent_30d: byAgent30d.results,
    daily_30d:    daily30d.results,
    generated_at: new Date().toISOString(),
  };

  const body = { success: true, data };
  await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 300 });
  return json(body, 200, origin);
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

  const cacheKey = "metrics_feed_failures:v1";
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

// ─── Attribution Backlog (PR-B from 2026-05-16 audit) ────────────
//
// GET /api/admin/agents/attribution-backlog
//
// Returns infrastructure_clusters with `actor_id IS NULL`, ordered
// by threat_count DESC. Used by the admin "Attribution Backlog"
// queue at /admin/agents/attribution-backlog where an analyst can
// see the biggest unattributed clusters and route them for human
// attribution.
//
// Background (audit finding #6):
//   - 2,334 of 2,483 clusters (94%) have no actor_id
//   - Attributor called Haiku for 1,330 of them → 1,325 returned
//     'unknown' → 0.4% resolution rate
//   - Most clusters carry 1,000+ threats — high-value evidence
//     sitting unattributed
//
// Cached 5 min in KV. Returns up to 50 clusters per call. No
// mutations — this PR is read-only surfacing; attribution-action
// endpoints come in a follow-up.
export async function handleAttributionBacklog(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);

    // v2: pagination + q search + dismissed rows excluded. TTL dropped
    // 300s → 60s so attribute/dismiss mutations surface quickly (the UI
    // also drops mutated rows optimistically).
    const cacheKey = `attribution-backlog:v2:${limit}:${offset}:${q}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached), 200, origin);

    // Search matches the human-visible identifiers: name, ASNs, countries.
    const like = q ? `%${q.replace(/[%_]/g, "")}%` : null;
    const listStmt = env.DB.prepare(`
        SELECT id, cluster_name, asns, countries, threat_count,
               confidence_score, status, first_detected, last_seen,
               attribution_attempted_at, nexus_brief, agent_notes
          FROM infrastructure_clusters
         WHERE actor_id IS NULL
           AND attribution_dismissed_at IS NULL${like ? " AND (cluster_name LIKE ? OR asns LIKE ? OR countries LIKE ?)" : ""}
         ORDER BY threat_count DESC
         LIMIT ? OFFSET ?
      `);
    const [rowsRes, totalsRes] = await Promise.all([
      (like ? listStmt.bind(like, like, like, limit, offset) : listStmt.bind(limit, offset)).all<{
        id: string;
        cluster_name: string | null;
        asns: string | null;
        countries: string | null;
        threat_count: number | null;
        confidence_score: number | null;
        status: string | null;
        first_detected: string | null;
        last_seen: string | null;
        attribution_attempted_at: string | null;
        nexus_brief: string | null;
        agent_notes: string | null;
      }>(),
      env.DB.prepare(`
        SELECT
          COUNT(*)                                                       AS total_clusters,
          SUM(CASE WHEN actor_id IS NULL
                    AND attribution_dismissed_at IS NULL
                   THEN 1 ELSE 0 END)                                    AS unattributed,
          SUM(CASE WHEN actor_id IS NULL
                    AND attribution_dismissed_at IS NULL
                    AND attribution_attempted_at IS NOT NULL
                   THEN 1 ELSE 0 END)                                    AS attempted_unknown,
          SUM(CASE WHEN actor_id IS NULL
                    AND attribution_dismissed_at IS NULL
                    AND attribution_attempted_at IS NULL
                   THEN 1 ELSE 0 END)                                    AS never_attempted,
          SUM(CASE WHEN actor_id IS NULL
                    AND attribution_dismissed_at IS NOT NULL
                   THEN 1 ELSE 0 END)                                    AS dismissed
        FROM infrastructure_clusters
      `).first<{
        total_clusters: number;
        unattributed: number;
        attempted_unknown: number;
        never_attempted: number;
        dismissed: number;
      }>(),
    ]);

    // Trim the noisier text fields to avoid bloating the payload;
    // operator drills into the cluster detail page for the full view.
    const items = (rowsRes.results ?? []).map(r => ({
      id:                       r.id,
      cluster_name:             r.cluster_name,
      asns:                     r.asns,
      countries:                r.countries,
      threat_count:             r.threat_count ?? 0,
      confidence_score:         r.confidence_score,
      status:                   r.status,
      first_detected:           r.first_detected,
      last_seen:                r.last_seen,
      attribution_attempted_at: r.attribution_attempted_at,
      nexus_brief_preview:      r.nexus_brief?.slice(0, 200) ?? null,
      agent_notes_preview:      r.agent_notes?.slice(0, 200) ?? null,
    }));

    const body = {
      success: true,
      data: {
        items,
        totals: {
          total_clusters:    totalsRes?.total_clusters    ?? 0,
          unattributed:      totalsRes?.unattributed      ?? 0,
          attempted_unknown: totalsRes?.attempted_unknown ?? 0,
          never_attempted:   totalsRes?.never_attempted   ?? 0,
          dismissed:         totalsRes?.dismissed         ?? 0,
        },
        limit,
        offset,
        generated_at: new Date().toISOString(),
      },
    };
    await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 60 });
    return json(body, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "An internal error occurred",
    }, 500, origin);
  }
}

// ─── Attribution actions (backlog follow-up) ─────────────────────
//
// The manual half of the attributor: a human assigns an actor to a
// cluster (or dismisses it as unattributable). Mirrors the agent's
// write pattern — set infrastructure_clusters.actor_id, then fan the
// attribution out to the cluster's threats via threat_attributions
// (source='manual', confidence='confirmed'). Dismiss stamps
// attribution_dismissed_at so the backlog stops surfacing the row.

export async function handleAttributeCluster(
  request: Request,
  env: Env,
  clusterId: string,
  adminUserId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!clusterId || clusterId.length > 64) {
    return json({ success: false, error: "Invalid cluster id" }, 400, origin);
  }
  const body = await request.json().catch(() => null) as { actor_id?: unknown } | null;
  const actorId = body && typeof body.actor_id === "string" ? body.actor_id.trim() : "";
  if (!actorId || actorId.length > 64) {
    return json({ success: false, error: "actor_id required" }, 400, origin);
  }

  const [cluster, actor] = await Promise.all([
    env.DB.prepare(
      "SELECT id, cluster_name FROM infrastructure_clusters WHERE id = ?",
    ).bind(clusterId).first<{ id: string; cluster_name: string | null }>(),
    env.DB.prepare(
      "SELECT id, name FROM threat_actors WHERE id = ?",
    ).bind(actorId).first<{ id: string; name: string }>(),
  ]);
  if (!cluster) return json({ success: false, error: "Cluster not found" }, 404, origin);
  if (!actor)   return json({ success: false, error: "Threat actor not found" }, 404, origin);

  await env.DB.prepare(
    `UPDATE infrastructure_clusters
        SET actor_id = ?, attribution_attempted_at = datetime('now'),
            attribution_dismissed_at = NULL
      WHERE id = ?`,
  ).bind(actorId, clusterId).run();

  // Fan out to the cluster's threats — same shape the attributor agent
  // writes, but source='manual' + confidence='confirmed' (a human said so).
  const { recordAttribution } = await import("../lib/otx-attribution");
  const threats = await env.DB.prepare(
    "SELECT id FROM threats WHERE cluster_id = ?",
  ).bind(clusterId).all<{ id: string }>();
  let fannedOut = 0;
  for (const t of threats.results ?? []) {
    await recordAttribution(env.DB, {
      id: `tat_manual_${clusterId}_${t.id}`,
      threatId: t.id,
      actorId,
      source: "manual",
      sourcePulseId: clusterId,
      sourcePulseName: cluster.cluster_name ?? null,
      actorNameRaw: actor.name,
      confidence: "confirmed",
    });
    fannedOut++;
  }

  await audit(env, {
    action: "cluster_attributed",
    userId: adminUserId,
    resourceType: "infrastructure_cluster",
    resourceId: clusterId,
    details: { actor_id: actorId, actor_name: actor.name, threats_fanned_out: fannedOut },
    request,
  });

  return json({
    success: true,
    data: { cluster_id: clusterId, actor_id: actorId, actor_name: actor.name, threats_fanned_out: fannedOut },
  }, 200, origin);
}

export async function handleDismissClusterAttribution(
  request: Request,
  env: Env,
  clusterId: string,
  adminUserId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!clusterId || clusterId.length > 64) {
    return json({ success: false, error: "Invalid cluster id" }, 400, origin);
  }
  const res = await env.DB.prepare(
    `UPDATE infrastructure_clusters
        SET attribution_dismissed_at = datetime('now')
      WHERE id = ? AND actor_id IS NULL`,
  ).bind(clusterId).run();
  if ((res.meta?.changes ?? 0) === 0) {
    return json({ success: false, error: "Cluster not found (or already attributed)" }, 404, origin);
  }

  await audit(env, {
    action: "cluster_attribution_dismissed",
    userId: adminUserId,
    resourceType: "infrastructure_cluster",
    resourceId: clusterId,
    details: {},
    request,
  });

  return json({ success: true, data: { cluster_id: clusterId, dismissed: true } }, 200, origin);
}
