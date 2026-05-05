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
import { classifySaasTechnique } from "../lib/saas-classifier";
import { BudgetManager } from "../lib/budgetManager";
import {
  buildGeoCubeForHour,
  buildProviderCubeForHour,
  buildBrandCubeForHour,
  buildStatusCubeForHour,
  countGeoCubeForHour,
  countProviderCubeForHour,
  countBrandCubeForHour,
  countStatusCubeForHour,
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

  const [
    threatStats,
    agentStats,
    feedStats,
    sessionCount,
    migrationInfo,
    auditCount,
    threatTrend,
  ] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN created_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) as today,
        SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) as week
      FROM threats
    `).first<{ total: number; today: number; week: number }>(),
    env.DB.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors
      FROM agent_runs
      WHERE started_at >= datetime('now','-1 day')
    `).first<{ total: number; successes: number; errors: number }>(),
    env.DB.prepare(`
      SELECT COUNT(*) as pulls,
        COALESCE(SUM(records_ingested),0) as ingested
      FROM feed_pull_history
      WHERE started_at >= datetime('now','-1 day')
    `).first<{ pulls: number; ingested: number }>(),
    env.DB.prepare(`
      SELECT COUNT(*) as count FROM sessions
      WHERE expires_at > datetime('now') AND revoked_at IS NULL
    `).first<{ count: number }>(),
    env.DB.prepare(`
      SELECT COUNT(*) as total, MAX(applied_at) as last_run,
        (SELECT name FROM d1_migrations ORDER BY applied_at DESC LIMIT 1) as last_name
      FROM d1_migrations
    `).first<{ total: number; last_run: string | null; last_name: string | null }>(),
    env.AUDIT_DB.prepare(
      `SELECT COUNT(*) as count FROM audit_log`
    ).first<{ count: number }>(),
    env.DB.prepare(`
      SELECT date(created_at) as day, COUNT(*) as count
      FROM threats
      WHERE created_at >= datetime('now','-14 days')
      GROUP BY date(created_at)
      ORDER BY day ASC
    `).all<{ day: string; count: number }>(),
  ]);

  return json({
    success: true,
    data: {
      threats: threatStats,
      agents: agentStats,
      feeds: feedStats,
      sessions: sessionCount,
      migrations: migrationInfo,
      audit: auditCount,
      trend: threatTrend.results,
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
  }, 200, origin);
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
    adminCachedCount('admin.threats_total', 900, "SELECT COUNT(*) AS n FROM threats"),
    adminCachedCount('admin.threats_active', 900, "SELECT COUNT(*) AS n FROM threats WHERE status = 'active'"),
    env.DB.prepare(
      "SELECT COUNT(*) AS active_sessions FROM sessions WHERE expires_at > datetime('now') AND revoked_at IS NULL",
    ).first<{ active_sessions: number }>(),
    // Agent backlogs — cached individually
    adminCachedCount('admin.sentinel_backlog', 900, "SELECT COUNT(*) AS n FROM threats WHERE status = 'active' AND created_at > datetime('now', '-1 hour')"),
    adminCachedCount('admin.analyst_backlog', 900, "SELECT COUNT(*) AS n FROM threats WHERE status = 'active' AND severity IS NULL"),
    adminCachedCount('admin.cartographer_backlog', 900, "SELECT COUNT(*) AS n FROM threats WHERE status = 'active' AND ip_address IS NOT NULL AND lat IS NULL"),
    adminCachedCount('admin.strategist_backlog', 900, "SELECT COUNT(*) AS n FROM threats WHERE status = 'active' AND campaign_id IS NULL AND threat_type IN ('phishing','typosquatting')"),
    env.DB.prepare(
      "SELECT MAX(created_at) AS last_run FROM agent_outputs WHERE agent_id = 'observer' AND type != 'diagnostic'",
    ).first<{ last_run: string | null }>().catch(() => null),
    adminCachedCount('admin.ai_attr_pending', 900, "SELECT COUNT(*) AS n FROM threats WHERE target_brand_id IS NULL AND threat_type IN ('phishing','credential_harvesting','typosquatting','impersonation')").catch(() => null),
    adminCachedCount('admin.brands_total', 3600, "SELECT COUNT(*) AS n FROM brands").catch(() => null),
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
type PipelineMeta = {
  label: string;
  agent: string;
  schedule: string;
  endpoints?: Array<{ name: string; url: string }>;
};

const PIPELINE_META: Record<string, PipelineMeta> = {
  cartographer:  { label: 'Geo Enrichment',     agent: 'cartographer', schedule: 'hourly' },
  analyst:       { label: 'Brand Matching',      agent: 'analyst',     schedule: 'hourly' },
  domain_geo:    {
    label: 'DNS Resolution',
    agent: 'navigator',
    schedule: '5 min',
    endpoints: [
      { name: 'Cloudflare 1.1.1.1', url: 'https://cloudflare-dns.com' },
      { name: 'Google DNS',         url: 'https://dns.google' },
      { name: 'Quad9 DNS',          url: 'https://dns.quad9.net:5053' },
    ],
  },
  brand_enrich:  { label: 'Brand Enrichment',    agent: 'enricher',    schedule: 'hourly' },
  surbl:         { label: 'SURBL',               agent: 'surbl',       schedule: 'hourly' },
  virustotal:    { label: 'VirusTotal',          agent: 'virustotal',  schedule: 'hourly' },
  gsb:           { label: 'Safe Browsing',       agent: 'gsb',         schedule: 'hourly' },
  dbl:           { label: 'Spamhaus DBL',        agent: 'dbl',         schedule: 'hourly' },
  abuseipdb:     { label: 'AbuseIPDB',           agent: 'abuseipdb',   schedule: 'hourly' },
  pdns:          { label: 'Passive DNS',         agent: 'pdns',        schedule: 'hourly' },
  greynoise:     { label: 'GreyNoise',           agent: 'greynoise',   schedule: 'hourly' },
  seclookup:     { label: 'SecLookup',           agent: 'seclookup',   schedule: 'hourly' },
};

export async function handlePipelineStatus(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  const cacheKey = "pipeline_status_v2";
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  // Read latest 2 snapshots per backlog from backlog_history (pre-computed by FC).
  // This gives us current count + previous count for trend, with zero COUNT queries.
  const [historyRows, agentRuns] = await Promise.all([
    env.DB.prepare(`
      SELECT backlog_name, count, recorded_at,
             ROW_NUMBER() OVER (PARTITION BY backlog_name ORDER BY recorded_at DESC) AS rn
      FROM backlog_history
      WHERE recorded_at > datetime('now', '-6 hours')
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
  for (const row of historyRows.results) {
    if (row.rn === 1) latestByName.set(row.backlog_name, { count: row.count, recorded_at: row.recorded_at });
    if (row.rn === 2) previousByName.set(row.backlog_name, { count: row.count, recorded_at: row.recorded_at });
  }

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

    return {
      id: name,
      label: meta.label,
      agent: meta.agent,
      schedule: meta.schedule,
      endpoints: meta.endpoints ?? null,
      count,
      prev_count: prevCount,
      trend,                               // negative = draining, positive = growing, null = no data
      trend_direction: trend === null ? 'unknown' : trend < 0 ? 'down' : trend > 0 ? 'up' : 'flat',
      last_measured_at: latest?.recorded_at ?? null,
      agent_last_run_at: agentRun?.last_run_at ?? null,
      agent_last_status: agentRun?.status ?? null,
      agent_records_processed: agentRun?.records_processed ?? null,
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
      last_measured_at: geoipStatus.last_refresh_at,
      agent_last_run_at: geoipAgentRun?.last_run_at ?? null,
      agent_last_status: geoipStatus.last_refresh_status ?? geoipAgentRun?.status ?? null,
      agent_records_processed: rowsWritten,
    });
  } catch (err) {
    console.error('[pipeline-status] geoip status error:', err);
    // Non-fatal — surface a "not configured" tile so the operator
    // sees the line item instead of nothing.
    pipelines.push({
      id: 'geoip',
      label: 'GeoIP Database',
      agent: 'geoip_refresh',
      schedule: 'monthly',
      endpoints: [{ name: 'MaxMind GeoLite2', url: 'https://download.maxmind.com' }],
      count: 0,
      prev_count: null,
      trend: null,
      trend_direction: 'unknown',
      last_measured_at: null,
      agent_last_run_at: null,
      agent_last_status: 'unconfigured',
      agent_records_processed: null,
    });
  }

  const data = { success: true, data: pipelines };
  await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
  return json(data, 200, origin);
}

export async function handleAdminListUsers(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0");
  const roleFilter = url.searchParams.get("role");
  const statusFilter = url.searchParams.get("status");

  let sql = "SELECT id, email, name, role, status, created_at, last_login, last_active, invited_by FROM users WHERE 1=1";
  const params: unknown[] = [];

  if (roleFilter) {
    sql += " AND role = ?";
    params.push(roleFilter);
  }
  if (statusFilter) {
    sql += " AND status = ?";
    params.push(statusFilter);
  }

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const { results } = await env.DB.prepare(sql).bind(...params).all();
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();

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
    const totalRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM threats WHERE confidence_score IS NULL"
    ).first<{ n: number }>();
    const total = totalRow?.n ?? 0;

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
    const totalRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM threats WHERE saas_technique_id IS NULL"
    ).first<{ n: number }>();
    const totalPending = totalRow?.n ?? 0;

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
    // Count total pending before starting
    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM threats WHERE ip_address IS NOT NULL AND country_code IS NULL ${PRIVATE_IP_SQL_FILTER}`
    ).first<{ n: number }>();
    const totalPending = totalRow?.n ?? 0;

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

    // Sync provider counts after backfill
    try {
      await env.DB.prepare(`
        UPDATE hosting_providers SET
          active_threat_count = (SELECT COUNT(*) FROM threats WHERE threats.hosting_provider_id = hosting_providers.id AND threats.status = 'active'),
          total_threat_count = (SELECT COUNT(*) FROM threats WHERE threats.hosting_provider_id = hosting_providers.id)
      `).run();
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
    // Count remaining unique unresolved domains
    const totalRow = await env.DB.prepare(`
      SELECT COUNT(DISTINCT malicious_domain) AS n
      FROM threats
      WHERE (ip_address IS NULL OR ip_address = '')
        AND malicious_domain IS NOT NULL
        AND malicious_domain != ''
        AND malicious_domain NOT LIKE '*%'
        AND malicious_domain LIKE '%.%'
    `).first<{ n: number }>();
    const totalPending = totalRow?.n ?? 0;

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
    const { fetchRdap } = await import("../lib/brand-enricher");
    const { runSyncAgent } = await import("../lib/agentRunner");
    const { brandEnricherAgent } = await import("../agents/brand-enricher");
    type SectorResult = { sector: string; aiSucceeded: boolean };

    if (!env.ANTHROPIC_API_KEY) {
      return json({
        success: false,
        error:   "ANTHROPIC_API_KEY not configured",
      }, 500, origin);
    }

    // Count remaining (skip rows that have already failed 5 times)
    const totalRow = await env.DB.prepare(`
      SELECT COUNT(*) as n FROM brands
      WHERE (sector IS NULL OR sector_classified_at IS NULL)
        AND COALESCE(sector_attempts, 0) < 5
        AND canonical_domain IS NOT NULL
        AND canonical_domain != ''
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

    const batch = await env.DB.prepare(`
      SELECT id, name, canonical_domain FROM brands
      WHERE (sector IS NULL OR sector_classified_at IS NULL)
        AND COALESCE(sector_attempts, 0) < 5
        AND canonical_domain IS NOT NULL
        AND canonical_domain != ''
      LIMIT 20
    `).all<{ id: string; name: string; canonical_domain: string }>();

    const apiKey = env.ANTHROPIC_API_KEY;
    let classified = 0;

    for (const brand of batch.results) {
      try {
        // Run RDAP + sector classification in parallel. Phase 3.7 of
        // agent audit: sector classification is now a sync agent.
        const [rdap, sector] = await Promise.allSettled([
          fetchRdap(brand.canonical_domain),
          runSyncAgent<SectorResult>(env, brandEnricherAgent, {
            domain: brand.canonical_domain,
            brandName: brand.name,
          }),
        ]);

        const rdapData  = rdap.status === "fulfilled" ? rdap.value : null;
        const sectorVal = sector.status === "fulfilled" && sector.value.data
          ? sector.value.data.sector
          : null;

        // If both RDAP and sector classification returned nothing,
        // bump attempts counter and retry on the next tick instead of
        // marking this row as "classified" with no actual data.
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
          continue;
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
        // Bump attempt counter so we retry next tick instead of marking
        // a permanently-broken row as classified.
        await env.DB.prepare(
          `UPDATE brands SET sector_attempts = COALESCE(sector_attempts, 0) + 1 WHERE id = ?`,
        ).bind(brand.id).run();
      }
    }

    return json({
      success: true,
      data: {
        processed:  batch.results.length,
        classified,
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

  const pendingRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM threats WHERE target_brand_id IS NULL AND (malicious_domain IS NOT NULL OR malicious_url IS NOT NULL OR ioc_value IS NOT NULL)",
  ).first<{ n: number }>();
  const totalPending = pendingRow?.n ?? 0;

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

export async function handleImportTranco(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => null) as {
      limit?: number;
      min_rank?: number;
      max_rank?: number;
      sectors?: Record<string, string>;
    } | null;

    const limit = Math.min(body?.limit ?? 10000, 10000);
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

    // Filter out domains we already have
    const existing = await env.DB.prepare(
      "SELECT canonical_domain FROM brands"
    ).all<{ canonical_domain: string }>();
    const existingSet = new Set(existing.results.map(r => r.canonical_domain.toLowerCase()));

    const toImport = candidates.filter(c => !existingSet.has(c.domain));
    let imported = 0;
    const skipped = candidates.length - toImport.length;

    // Batch insert in groups of 50
    const BATCH_SIZE = 50;
    for (let i = 0; i < toImport.length; i += BATCH_SIZE) {
      const batch = toImport.slice(i, i + BATCH_SIZE);
      const stmts = batch.map(c => {
        const brandId = `brand_${c.domain.replace(/[^a-z0-9]+/g, "_")}`;
        const name = extractBrandName(c.domain);
        const sector = body?.sectors?.[c.domain] ?? null;
        return env.DB.prepare(
          `INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, first_seen, threat_count)
           VALUES (?, ?, ?, ?, 'tranco', datetime('now'), 0)`
        ).bind(brandId, name, c.domain, sector);
      });
      await env.DB.batch(stmts);
      imported += batch.length;
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
        skipped,
        backfillMatched,
        message: `Imported ${imported} brands from Tranco top ${maxRank} (${skipped} already existed, ${backfillMatched} threats backfill-matched)`,
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

// ─── POST /api/admin/backfill-social-config — Migrate brand_profiles → brands unified model ───

export async function handleBackfillSocialConfig(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // 1. Query all brand_profiles rows
    const profiles = await env.DB.prepare(
      "SELECT * FROM brand_profiles WHERE status != 'archived'"
    ).all<{
      id: string; user_id: string; domain: string; brand_name: string;
      aliases: string | null; official_handles: string | null;
      brand_keywords: string | null; executive_names: string | null;
      monitoring_tier: string | null; status: string;
      exposure_score: number | null; social_risk_score: number | null;
      domain_risk_score: number | null; email_grade: string | null;
      logo_url: string | null;
    }>();

    let brandsMigrated = 0;
    let profilesMigrated = 0;
    let schedulesMigrated = 0;
    let brandsNotFound = 0;

    for (const profile of profiles.results) {
      // 2. Find matching brands row by canonical_domain
      const brand = await env.DB.prepare(
        "SELECT id FROM brands WHERE canonical_domain = ?"
      ).bind(profile.domain).first<{ id: string }>();

      if (!brand) {
        brandsNotFound++;
        continue;
      }

      // 3. UPDATE brands with social fields from brand_profiles
      await env.DB.prepare(`
        UPDATE brands SET
          official_handles = COALESCE(?, official_handles),
          aliases = COALESCE(?, aliases),
          brand_keywords = COALESCE(?, brand_keywords),
          executive_names = COALESCE(?, executive_names),
          logo_url = COALESCE(?, logo_url),
          monitoring_tier = COALESCE(?, monitoring_tier),
          monitoring_status = CASE WHEN ? = 'active' THEN 'active' ELSE monitoring_status END,
          social_risk_score = COALESCE(?, social_risk_score),
          domain_risk_score = COALESCE(?, domain_risk_score),
          email_grade = COALESCE(?, email_grade),
          exposure_score = COALESCE(?, exposure_score)
        WHERE id = ?
      `).bind(
        profile.official_handles,
        profile.aliases,
        profile.brand_keywords,
        profile.executive_names,
        profile.logo_url,
        profile.monitoring_tier,
        profile.status,
        profile.social_risk_score,
        profile.domain_risk_score,
        profile.email_grade,
        profile.exposure_score,
        brand.id,
      ).run();
      brandsMigrated++;

      // 4. Migrate social_monitor_results → social_profiles
      const results = await env.DB.prepare(
        "SELECT * FROM social_monitor_results WHERE brand_id = ?"
      ).bind(profile.id).all<{
        id: string; platform: string; check_type: string;
        handle_checked: string; handle_available: number | null;
        suspicious_account_url: string | null; suspicious_account_name: string | null;
        impersonation_score: number; impersonation_signals: string | null;
        ai_assessment: string | null; severity: string; status: string;
        ai_confidence: number | null; ai_action: string | null;
        ai_evidence_draft: string | null; created_at: string;
      }>();

      for (const r of results.results) {
        const handle = r.handle_checked?.replace(/^@/, '') ?? '';
        if (!handle) continue;

        const classification = r.check_type === 'handle_check' ? 'official' :
          r.impersonation_score >= 0.7 ? 'impersonation' : 'suspicious';

        const newId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO social_profiles
            (id, brand_id, platform, handle, profile_url, display_name,
             classification, classified_by, classification_confidence,
             ai_assessment, ai_confidence, ai_action, ai_evidence_draft,
             impersonation_score, impersonation_signals, severity, status,
             last_checked, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (brand_id, platform, handle) DO UPDATE SET
            impersonation_score = MAX(excluded.impersonation_score, social_profiles.impersonation_score),
            updated_at = datetime('now')
        `).bind(
          newId, brand.id, r.platform, handle,
          r.suspicious_account_url, r.suspicious_account_name,
          classification, r.impersonation_score,
          r.ai_assessment, r.ai_confidence, r.ai_action, r.ai_evidence_draft,
          r.impersonation_score, r.impersonation_signals, r.severity,
          r.status === 'open' ? 'active' : r.status,
          r.created_at, r.created_at,
        ).run();
        profilesMigrated++;
      }

      // 5. Migrate social_monitor_schedule → brand_monitor_schedule
      const schedules = await env.DB.prepare(
        "SELECT * FROM social_monitor_schedule WHERE brand_id = ?"
      ).bind(profile.id).all<{
        id: string; platform: string; last_checked: string | null;
        next_check: string | null; check_interval_hours: number; enabled: number;
      }>();

      for (const s of schedules.results) {
        const schedId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO brand_monitor_schedule
            (id, brand_id, monitor_type, platform, last_checked, next_check, check_interval_hours, enabled)
          VALUES (?, ?, 'social', ?, ?, ?, ?, ?)
          ON CONFLICT (brand_id, monitor_type, platform) DO UPDATE SET
            last_checked = COALESCE(excluded.last_checked, brand_monitor_schedule.last_checked),
            next_check = COALESCE(excluded.next_check, brand_monitor_schedule.next_check),
            enabled = excluded.enabled
        `).bind(
          schedId, brand.id, s.platform, s.last_checked, s.next_check,
          s.check_interval_hours, s.enabled,
        ).run();
        schedulesMigrated++;
      }
    }

    return json({
      success: true,
      data: {
        profiles_processed: profiles.results.length,
        brands_migrated: brandsMigrated,
        brands_not_found: brandsNotFound,
        social_profiles_migrated: profilesMigrated,
        schedules_migrated: schedulesMigrated,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
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
    cube !== "both" &&
    cube !== "all"
  ) {
    return json({
      success: false,
      error: "cube query param is required and must be 'geo' | 'provider' | 'brand' | 'status' | 'both' | 'all'",
    }, 400, origin);
  }
  const buildGeo = cube === "geo" || cube === "both" || cube === "all";
  const buildProvider = cube === "provider" || cube === "both" || cube === "all";
  const buildBrand = cube === "brand" || cube === "all";
  const buildStatus = cube === "status" || cube === "all";

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
            }
          } catch (err) {
            errParts.push(err instanceof Error ? err.message : String(err));
          }

          const errMsg = errParts.length > 0 ? errParts.join("; ") : null;
          totalRows += geoRows + providerRows + brandRows + statusRows;
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
