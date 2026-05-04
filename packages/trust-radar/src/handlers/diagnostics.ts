// Averrow — Platform Diagnostics Handler
//
// Comprehensive health check designed for programmatic consumption
// (Claude Code, monitoring, incident triage). Returns enrichment pipeline
// state, per-feed failure rates, per-agent run counts, backlog trends,
// AI spend, and platform totals in a single response.

import { json, corsHeaders } from "../lib/cors";
import { PRIVATE_IP_SQL_FILTER } from "../lib/geoip";
import { getBudgetDiagnostics, fetchD1TopQueries } from "../lib/d1-budget";
import type { Env } from "../types";

// ─── D1 metrics via Cloudflare GraphQL Analytics API ──────────────
// Pulls rows_read / rows_written / query counts from the past 24h. Used
// to track progress against the 25B rows_read/month plan ceiling
// ($25/mo at $0.001/M reads). Requires two secrets configured on the
// worker via wrangler.toml or `wrangler secret put`:
//   CF_API_TOKEN     — token with "Account Analytics: Read" scope
//   CF_ACCOUNT_ID    — your account's account_id (visible in CF dash)
// If either is missing, the diagnostic returns a setup_required: true
// stub instead of throwing — the rest of the diagnostic stays usable.

interface D1Metrics {
  rows_read_24h: number | null;
  rows_written_24h: number | null;
  read_queries_24h: number | null;
  write_queries_24h: number | null;
  monthly_rows_read_projection: number | null;
  pct_of_25b_plan_ceiling: number | null;
  setup_required: boolean;
  setup_instructions?: string;
  error?: string;
}

// Pull the most recent FC tick's phase timings (P2). Sourced from
// the diagnostic agent_outputs row FC writes at the end of each
// tick. Returns null if not available (e.g. fresh deploy not yet
// run).
async function getFcTickTimings(db: D1Database): Promise<{
  total_ms: number | null;
  generated_at: string | null;
  timings: Record<string, number> | null;
  ranked: Array<{ phase: string; ms: number; pct: number }>;
} | null> {
  try {
    const row = await db.prepare(
      `SELECT details, created_at FROM agent_outputs
        WHERE agent_id = 'flight_control' AND type = 'diagnostic'
        ORDER BY created_at DESC LIMIT 1`
    ).first<{ details: string; created_at: string }>();
    if (!row?.details) return null;
    const parsed = JSON.parse(row.details) as {
      timings?: Record<string, number>;
      total_ms?: number;
    };
    const timings = parsed.timings ?? null;
    const totalMs = parsed.total_ms ?? null;
    if (!timings) return { total_ms: totalMs, generated_at: row.created_at, timings: null, ranked: [] };
    const ranked = Object.entries(timings)
      .map(([phase, ms]) => ({
        phase,
        ms,
        pct: totalMs && totalMs > 0 ? Math.round((ms / totalMs) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.ms - a.ms);
    return { total_ms: totalMs, generated_at: row.created_at, timings, ranked };
  } catch {
    return null;
  }
}

async function fetchD1Metrics(env: Env, databaseId: string): Promise<D1Metrics> {
  const token = (env as unknown as Record<string, string | undefined>).CF_API_TOKEN;
  const accountId = (env as unknown as Record<string, string | undefined>).CF_ACCOUNT_ID;

  if (!token || !accountId) {
    return {
      rows_read_24h: null,
      rows_written_24h: null,
      read_queries_24h: null,
      write_queries_24h: null,
      monthly_rows_read_projection: null,
      pct_of_25b_plan_ceiling: null,
      setup_required: true,
      setup_instructions:
        "Set CF_API_TOKEN (Account Analytics: Read scope) and CF_ACCOUNT_ID via " +
        "`wrangler secret put` to enable D1 row-read tracking. Without these, " +
        "check the Cloudflare D1 dashboard manually.",
    };
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const query = `
    query {
      viewer {
        accounts(filter: { accountTag: "${accountId}" }) {
          d1AnalyticsAdaptiveGroups(
            filter: { datetimeHour_geq: "${since}", databaseId: "${databaseId}" }
            limit: 1000
          ) {
            sum {
              readQueries
              writeQueries
              rowsRead
              rowsWritten
            }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      return {
        rows_read_24h: null,
        rows_written_24h: null,
        read_queries_24h: null,
        write_queries_24h: null,
        monthly_rows_read_projection: null,
        pct_of_25b_plan_ceiling: null,
        setup_required: false,
        error: `CF GraphQL HTTP ${res.status}`,
      };
    }

    const json = (await res.json()) as {
      data?: {
        viewer?: {
          accounts?: Array<{
            d1AnalyticsAdaptiveGroups?: Array<{
              sum: {
                readQueries: number;
                writeQueries: number;
                rowsRead: number;
                rowsWritten: number;
              };
            }>;
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      return {
        rows_read_24h: null,
        rows_written_24h: null,
        read_queries_24h: null,
        write_queries_24h: null,
        monthly_rows_read_projection: null,
        pct_of_25b_plan_ceiling: null,
        setup_required: false,
        error: json.errors.map((e) => e.message).join("; "),
      };
    }

    const groups = json.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
    const totals = groups.reduce(
      (acc, g) => ({
        rowsRead: acc.rowsRead + g.sum.rowsRead,
        rowsWritten: acc.rowsWritten + g.sum.rowsWritten,
        readQueries: acc.readQueries + g.sum.readQueries,
        writeQueries: acc.writeQueries + g.sum.writeQueries,
      }),
      { rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 },
    );

    // Monthly projection assumes the past 24h is representative.
    const monthlyProjection = totals.rowsRead * 30;
    const planCeiling = 25_000_000_000; // 25B rows_read/month plan
    const pctOfCeiling = Math.round((monthlyProjection / planCeiling) * 1000) / 10;

    return {
      rows_read_24h: totals.rowsRead,
      rows_written_24h: totals.rowsWritten,
      read_queries_24h: totals.readQueries,
      write_queries_24h: totals.writeQueries,
      monthly_rows_read_projection: monthlyProjection,
      pct_of_25b_plan_ceiling: pctOfCeiling,
      setup_required: false,
    };
  } catch (err) {
    return {
      rows_read_24h: null,
      rows_written_24h: null,
      read_queries_24h: null,
      write_queries_24h: null,
      monthly_rows_read_projection: null,
      pct_of_25b_plan_ceiling: null,
      setup_required: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Per-endpoint D1 read attribution via Workers Analytics Engine ──
// Companion to fetchD1Metrics (database-wide) — surfaces which
// endpoints are eating the rows-read budget. Reads from the
// `trust_radar_d1_reads` AE dataset that lib/analytics.ts writes to.
// Uses AE's SQL API (separate from GraphQL — same auth though).

interface D1EndpointAttribution {
  endpoint: string;
  total_rows_read: number;
  total_queries: number;
  request_count: number;
  avg_rows_per_request: number;
}

async function fetchD1EndpointAttribution(env: Env): Promise<{
  by_endpoint: D1EndpointAttribution[];
  setup_required: boolean;
  setup_instructions?: string;
  error?: string;
}> {
  const token = (env as unknown as Record<string, string | undefined>).CF_API_TOKEN;
  const accountId = (env as unknown as Record<string, string | undefined>).CF_ACCOUNT_ID;

  if (!token || !accountId) {
    return {
      by_endpoint: [],
      setup_required: true,
      setup_instructions:
        "Set CF_API_TOKEN + CF_ACCOUNT_ID via `wrangler secret put` to enable " +
        "per-endpoint D1 read attribution.",
    };
  }

  // AE SQL API: blob1 is the endpoint label (set by recordD1Reads),
  // double1 = rowsRead, double2 = rowsWritten, double3 = queries.
  // Aggregate over the past 24h, top 20 endpoints by rows_read.
  const sql = `
    SELECT
      blob1 AS endpoint,
      SUM(double1) AS total_rows_read,
      SUM(double3) AS total_queries,
      COUNT() AS request_count
    FROM trust_radar_d1_reads
    WHERE timestamp > NOW() - INTERVAL '1' DAY
    GROUP BY blob1
    ORDER BY total_rows_read DESC
    LIMIT 20
  `;

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/plain",
        },
        body: sql,
      },
    );

    if (!res.ok) {
      return {
        by_endpoint: [],
        setup_required: false,
        error: `AE SQL HTTP ${res.status}`,
      };
    }

    const json = (await res.json()) as {
      data?: Array<{
        endpoint: string;
        total_rows_read: number;
        total_queries: number;
        request_count: number;
      }>;
    };

    const rows = json.data ?? [];
    return {
      by_endpoint: rows.map((r) => ({
        endpoint: r.endpoint,
        total_rows_read: r.total_rows_read,
        total_queries: r.total_queries,
        request_count: r.request_count,
        avg_rows_per_request: r.request_count > 0
          ? Math.round(r.total_rows_read / r.request_count)
          : 0,
      })),
      setup_required: false,
    };
  } catch (err) {
    return {
      by_endpoint: [],
      setup_required: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** GET /api/admin/platform-diagnostics  (JWT admin auth)
 *  GET /api/internal/platform-diagnostics (AVERROW_INTERNAL_SECRET auth) */
export async function handlePlatformDiagnostics(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const hoursBack = Math.min(parseInt(url.searchParams.get("hours") ?? "6"), 48);

  try {
    // ─── 1. Database clock ──────────────────────────────────────────
    const clockP = env.DB.prepare(
      "SELECT datetime('now') AS utc_now"
    ).first<{ utc_now: string }>();

    // ─── 2. Enrichment pipeline ─────────────────────────────────────
    const enrichmentP = env.DB.prepare(`
      SELECT
        COUNT(*) AS total_threats,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_threats,
        SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) AS total_enriched,
        SUM(CASE WHEN lat IS NOT NULL AND enriched_at >= datetime('now', '-1 hour') THEN 1 ELSE 0 END) AS enriched_last_hour,
        SUM(CASE WHEN lat IS NOT NULL AND enriched_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS enriched_last_24h,
        SUM(CASE WHEN enriched_at IS NOT NULL AND lat IS NULL AND ip_address IS NOT NULL THEN 1 ELSE 0 END) AS stuck_pile,
        SUM(CASE WHEN ip_address IS NULL AND malicious_domain IS NOT NULL THEN 1 ELSE 0 END) AS needs_dns
      FROM threats
    `).first<{
      total_threats: number;
      active_threats: number;
      total_enriched: number;
      enriched_last_hour: number;
      enriched_last_24h: number;
      stuck_pile: number;
      needs_dns: number;
    }>();

    // domain_geo_drainable — domains we can actually try right now
    // (cooldown expired, attempts < cap). Pairs with `domain_geo`
    // FC backlog (which includes all rows, even ones in cooldown).
    // The pair tells the operator: "30K total / 412 drainable now".
    const domainGeoDrainableP = env.DB.prepare(`
      SELECT COUNT(DISTINCT malicious_domain) AS n FROM threats
      WHERE (ip_address IS NULL OR ip_address = '')
        AND malicious_domain IS NOT NULL
        AND malicious_domain != ''
        AND malicious_domain NOT LIKE '*%'
        AND malicious_domain LIKE '%.%'
        AND COALESCE(enrichment_attempts, 0) < 8
        AND (attempted_resolve_at IS NULL
             OR attempted_resolve_at < datetime('now', '-6 hours'))
    `).first<{ n: number }>();

    // Cartographer queue — matches actual Phase 0 query (private IPs and
    // attempts-exhausted threats excluded — see migration 0110)
    const cartoQueueP = env.DB.prepare(`
      SELECT COUNT(*) AS n FROM threats
      WHERE enriched_at IS NULL
        AND ip_address IS NOT NULL AND ip_address != ''
        AND enrichment_attempts < 5
        ${PRIVATE_IP_SQL_FILTER}
    `).first<{ n: number }>();

    // Cartographer queue WITHOUT private IP filter (for comparison — shows inflation)
    const cartoQueueRawP = env.DB.prepare(`
      SELECT COUNT(*) AS n FROM threats
      WHERE enriched_at IS NULL
        AND ip_address IS NOT NULL AND ip_address != ''
        AND enrichment_attempts < 5
    `).first<{ n: number }>();

    // Threats exhausted by cartographer — hit the attempts cap with no geo.
    // These exit the active queue but stay in `threats`. A growing exhausted
    // count means ip-api can't enrich a meaningful share of the new threat
    // mix; consider adding a fallback geo source.
    const cartoExhaustedP = env.DB.prepare(`
      SELECT COUNT(*) AS n FROM threats
      WHERE enriched_at IS NULL
        AND ip_address IS NOT NULL AND ip_address != ''
        AND enrichment_attempts >= 5
    `).first<{ n: number }>();

    // Per-feed × per-type breakdown of the exhausted pile. Without
    // this, "cartographer_exhausted: 1,402" is opaque — operators
    // can't tell whether it's a feed regression (one feed dumping
    // un-resolvable IPs), a class of threats (e.g. botnet IPs from
    // sinkholes), or a geo-source coverage gap. Top 15 keeps the
    // payload bounded; the full distribution stays queryable in D1.
    const cartoExhaustedByFeedP = env.DB.prepare(`
      SELECT source_feed, threat_type, COUNT(*) AS n
        FROM threats
       WHERE status = 'active'
         AND enriched_at IS NULL
         AND ip_address IS NOT NULL AND ip_address != ''
         AND enrichment_attempts >= 5
       GROUP BY source_feed, threat_type
       ORDER BY n DESC
       LIMIT 15
    `).all<{ source_feed: string; threat_type: string; n: number }>();

    // ─── 3. Per-feed health ─────────────────────────────────────────
    const feedHealthP = env.DB.prepare(`
      SELECT
        fph.feed_name,
        fc.display_name,
        fc.enabled,
        fc.paused_reason,
        COUNT(*) AS total_pulls,
        SUM(CASE WHEN fph.status = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN fph.status = 'partial' THEN 1 ELSE 0 END) AS partial,
        SUM(CASE WHEN fph.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        COALESCE(SUM(fph.records_ingested), 0) AS total_ingested,
        COALESCE(SUM(fph.records_rejected), 0) AS total_rejected,
        MAX(CASE WHEN fph.status = 'success' THEN fph.completed_at END) AS last_success_at,
        MAX(CASE WHEN fph.status = 'failed' THEN fph.started_at END) AS last_failure_at
      FROM feed_pull_history fph
      LEFT JOIN feed_configs fc ON fc.feed_name = fph.feed_name
      WHERE fph.started_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY fph.feed_name
      ORDER BY failed DESC, fph.feed_name ASC
    `).bind(hoursBack).all<{
      feed_name: string;
      display_name: string | null;
      enabled: number | null;
      paused_reason: string | null;
      total_pulls: number;
      success: number;
      partial: number;
      failed: number;
      total_ingested: number;
      total_rejected: number;
      last_success_at: string | null;
      last_failure_at: string | null;
    }>();

    // Consecutive failures + auto-pause risk from feed_status
    const feedStatusP = env.DB.prepare(`
      SELECT fs.feed_name,
             fs.consecutive_failures,
             fs.health_status,
             fs.last_error,
             COALESCE(fc.consecutive_failure_threshold, 5) AS threshold
      FROM feed_status fs
      LEFT JOIN feed_configs fc ON fc.feed_name = fs.feed_name
      WHERE fs.consecutive_failures > 0
      ORDER BY fs.consecutive_failures DESC
    `).all<{
      feed_name: string;
      consecutive_failures: number;
      health_status: string;
      last_error: string | null;
      threshold: number;
    }>();

    // Recent feed errors (last 5 failed pulls with error messages)
    const feedErrorsP = env.DB.prepare(`
      SELECT feed_name, started_at, error_message
      FROM feed_pull_history
      WHERE status = 'failed' AND error_message IS NOT NULL
        AND started_at >= datetime('now', '-' || ? || ' hours')
      ORDER BY started_at DESC
      LIMIT 20
    `).bind(hoursBack).all<{
      feed_name: string;
      started_at: string;
      error_message: string;
    }>();

    // ─── 4. Agent mesh ──────────────────────────────────────────────
    // killed_runs = status='partial' AND completed_at IS NULL. The agentRunner
    // INSERTs new rows with status='partial' and only UPDATEs to 'success' (or
    // back to 'partial' with completed_at set if the agent returned approvals)
    // when execute() returns. A row stuck at status='partial' with completed_at
    // NULL means the Worker was killed mid-run (CPU ceiling, OOM, etc.). The
    // 'stalled' query only sees status='running', so without this metric these
    // mid-execution kills are invisible.
    const agentMeshP = env.DB.prepare(`
      SELECT
        agent_id,
        COUNT(*) AS total_runs,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
        SUM(CASE WHEN status = 'partial' AND completed_at IS NULL THEN 1 ELSE 0 END) AS killed_runs,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        MAX(completed_at) AS last_completed_at,
        MAX(CASE WHEN status = 'failed' THEN error_message END) AS last_error,
        SUM(records_processed) AS total_records_processed,
        AVG(duration_ms) AS avg_duration_ms
      FROM agent_runs
      WHERE started_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY agent_id
      ORDER BY agent_id ASC
    `).bind(hoursBack).all<{
      agent_id: string;
      total_runs: number;
      success: number;
      partial: number;
      killed_runs: number;
      failed: number;
      running: number;
      last_completed_at: string | null;
      last_error: string | null;
      total_records_processed: number;
      avg_duration_ms: number | null;
    }>();

    // Stalled agents — started but never completed in the last N hours
    const stalledP = env.DB.prepare(`
      SELECT agent_id, id AS run_id, started_at,
             ROUND((julianday('now') - julianday(started_at)) * 24 * 60, 1) AS minutes_stalled
      FROM agent_runs
      WHERE status = 'running'
        AND started_at < datetime('now', '-15 minutes')
      ORDER BY started_at ASC
      LIMIT 10
    `).all<{
      agent_id: string;
      run_id: string;
      started_at: string;
      minutes_stalled: number;
    }>();

    // ─── 5. Backlog trends ──────────────────────────────────────────
    const backlogP = env.DB.prepare(`
      SELECT backlog_name, count, recorded_at,
             ROW_NUMBER() OVER (PARTITION BY backlog_name ORDER BY recorded_at DESC) AS rn
      FROM backlog_history
      WHERE recorded_at > datetime('now', '-' || ? || ' hours')
    `).bind(hoursBack).all<{
      backlog_name: string;
      count: number;
      recorded_at: string;
      rn: number;
    }>();

    // ─── 6. AI spend (last 24h) ─────────────────────────────────────
    const aiSpendP = env.DB.prepare(`
      SELECT
        agent_id,
        COUNT(*) AS calls,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        ROUND(SUM(cost_usd), 4) AS cost_usd
      FROM budget_ledger
      WHERE created_at >= datetime('now', '-1 day')
      GROUP BY agent_id
      ORDER BY cost_usd DESC
    `).all<{
      agent_id: string;
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>();

    // ─── 7. Cron health (recent Navigator + orchestrator) ───────────
    // Navigator was renamed from 'fast_tick' — both IDs are queried so the
    // window spans the transition. Historical rows keep 'fast_tick'; new
    // rows land under 'navigator'.
    const cronHealthP = env.DB.prepare(`
      SELECT agent_id,
             COUNT(*) AS runs,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
             SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS not_success,
             MAX(completed_at) AS last_run_at,
             AVG(duration_ms) AS avg_duration_ms
      FROM agent_runs
      WHERE agent_id IN ('navigator', 'fast_tick', 'flight_control', 'orchestrator')
        AND started_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY agent_id
    `).bind(hoursBack).all<{
      agent_id: string;
      runs: number;
      success: number;
      not_success: number;
      last_run_at: string | null;
      avg_duration_ms: number | null;
    }>();

    // ─── 8. Platform totals ─────────────────────────────────────────
    const totalsP = env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM brands) AS brands,
        (SELECT COUNT(*) FROM hosting_providers) AS providers,
        (SELECT COUNT(*) FROM campaigns) AS campaigns,
        (SELECT COUNT(*) FROM infrastructure_clusters) AS clusters,
        (SELECT COUNT(*) FROM lookalike_domains) AS lookalike_domains,
        (SELECT COUNT(*) FROM feed_configs WHERE enabled = 1) AS feeds_enabled,
        (SELECT COUNT(*) FROM feed_configs WHERE enabled = 0) AS feeds_disabled
    `).first<{
      brands: number;
      providers: number;
      campaigns: number;
      clusters: number;
      lookalike_domains: number;
      feeds_enabled: number;
      feeds_disabled: number;
    }>();

    // D1 metrics from Cloudflare GraphQL Analytics API. Awaited in
    // parallel with the D1 queries so it doesn't extend the diagnostic.
    // Database id matches wrangler.toml's [[d1_databases]] entry — kept
    // as a literal to avoid passing it through env (which would require
    // additional secret config).
    const D1_DATABASE_ID = "a3776a5f-c07c-4e20-9f3b-8d7f8c7f90c6";
    const d1MetricsP = fetchD1Metrics(env, D1_DATABASE_ID);
    const d1AttributionP = fetchD1EndpointAttribution(env);
    // Soft-cap state (Navigator skip tracking + thresholds) and the
    // per-query top-N from CF's d1QueriesAdaptiveGroups. Both fail
    // gracefully — diagnostics endpoint stays usable when CF GraphQL
    // is down or CF_API_TOKEN isn't configured.
    const d1BudgetStateP = getBudgetDiagnostics(env);
    const d1TopQueriesP = fetchD1TopQueries(env, 20);

    // ── Execute all in parallel ─────────────────────────────────────
    const [
      clock, enrichment, cartoQueue, cartoQueueRaw, cartoExhausted, cartoExhaustedByFeed, domainGeoDrainable,
      feedHealth, feedStatus, feedErrors,
      agentMesh, stalled, backlog,
      aiSpend, cronHealth, totals, d1Metrics, d1Attribution,
      d1BudgetState, d1TopQueries,
    ] = await Promise.all([
      clockP, enrichmentP, cartoQueueP, cartoQueueRawP, cartoExhaustedP, cartoExhaustedByFeedP, domainGeoDrainableP,
      feedHealthP, feedStatusP, feedErrorsP,
      agentMeshP, stalledP, backlogP,
      aiSpendP, cronHealthP, totalsP, d1MetricsP, d1AttributionP,
      d1BudgetStateP, d1TopQueriesP,
    ]);

    // ── Build backlog trend map ─────────────────────────────────────
    const backlogTrends: Record<string, { current: number; previous: number | null; trend: number | null; measured_at: string | null }> = {};
    for (const row of backlog.results) {
      if (row.rn === 1) {
        backlogTrends[row.backlog_name] = {
          current: row.count,
          previous: null,
          trend: null,
          measured_at: row.recorded_at,
        };
      } else if (row.rn === 2) {
        const entry = backlogTrends[row.backlog_name];
        if (entry) {
          entry.previous = row.count;
          entry.trend = entry.current - row.count;
        }
      }
    }

    // ── Index health: verify migration 0123 indexes exist + show
    //    the planner's chosen plan for the offending Group 1 query.
    //    Triggered after we observed UPDATE WHERE ip_address=? AND
    //    source_feed=? still scanning ~213K rows/call post-deploy.
    //    Sequential (not in the parallel block) so we can include
    //    a structured error per probe without aborting the rest of
    //    diagnostics.
    type IndexInfo = { name: string; sql: string | null };
    type ExplainRow = { id: number; parent: number; notused: number; detail: string };
    let indexHealth: {
      threats_indexes: IndexInfo[];
      agent_outputs_indexes: IndexInfo[];
      budget_ledger_indexes: IndexInfo[];
      threat_cube_status_exists: boolean;
      explain_emerging_threats_update: ExplainRow[] | null;
      error: string | null;
    } = {
      threats_indexes: [],
      agent_outputs_indexes: [],
      budget_ledger_indexes: [],
      threat_cube_status_exists: false,
      explain_emerging_threats_update: null,
      error: null,
    };
    try {
      const [threatsIdx, outputsIdx, ledgerIdx, statusCube, explainPlan] = await Promise.all([
        env.DB.prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='threats' ORDER BY name`
        ).all<IndexInfo>(),
        env.DB.prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='agent_outputs' ORDER BY name`
        ).all<IndexInfo>(),
        env.DB.prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='budget_ledger' ORDER BY name`
        ).all<IndexInfo>(),
        env.DB.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='threat_cube_status' LIMIT 1`
        ).first<{ name: string }>(),
        env.DB.prepare(
          `EXPLAIN QUERY PLAN
           UPDATE threats SET last_seen = datetime('now')
           WHERE ip_address = ? AND source_feed = 'emerging_threats'`
        ).bind('1.2.3.4').all<ExplainRow>(),
      ]);
      indexHealth = {
        threats_indexes: threatsIdx.results,
        agent_outputs_indexes: outputsIdx.results,
        budget_ledger_indexes: ledgerIdx.results,
        threat_cube_status_exists: !!statusCube,
        explain_emerging_threats_update: explainPlan.results,
        error: null,
      };
    } catch (err) {
      indexHealth.error = err instanceof Error ? err.message : String(err);
    }

    // ── Build feeds-at-risk list ────────────────────────────────────
    const feedsAtRisk = feedStatus.results
      .filter(f => f.consecutive_failures >= Math.floor(f.threshold * 0.6))
      .map(f => ({
        feed_name: f.feed_name,
        consecutive_failures: f.consecutive_failures,
        threshold: f.threshold,
        health_status: f.health_status,
        last_error: f.last_error,
        pct_to_auto_pause: Math.round((f.consecutive_failures / f.threshold) * 100),
      }));

    // Recent platform_* notifications — operator-facing audit trail
    // of what FC + agents flagged as needing human attention.
    const recentPlatformAlerts = await env.DB.prepare(
      `SELECT MAX(created_at) AS created_at, type, severity, title, message, group_key, COUNT(*) AS occurrences
         FROM notifications
        WHERE type LIKE 'platform_%'
          AND created_at >= datetime('now', '-' || ? || ' hours')
        GROUP BY type, group_key
        ORDER BY created_at DESC
        LIMIT 50`,
    ).bind(hoursBack).all<{
      created_at: string; type: string; severity: string;
      title: string; message: string; group_key: string | null;
      occurrences: number;
    }>();

    // Briefing email status — exposes the threat_briefings table
    // state so operators can debug platform_briefing_silent alerts.
    // Fields: most recent attempt + most recent successful delivery
    // + Resend config presence + fail rate over the window.
    let briefingStatus: {
      resend_configured: boolean;
      most_recent_attempt: string | null;
      most_recent_emailed: string | null;
      hours_since_emailed: number | null;
      attempts_in_window: number;
      emailed_in_window: number;
      recent_attempts: Array<{ generated_at: string; trigger: string; emailed: number; report_date: string }>;
      most_recent_error: string | null;
      most_recent_recipient: string | null;
      /** Full Resend response on the most recent failure (cached in KV).
       *  Includes HTTP status, Resend error `name` discriminator, message,
       *  and up to 1KB of raw body. Null when no failure has been cached. */
      resend_last_error: unknown;
    };
    try {
      const recentRow = await env.DB.prepare(
        `SELECT MAX(generated_at) AS most_recent_attempt FROM threat_briefings
          WHERE generated_at >= datetime('now', '-' || ? || ' hours')`
      ).bind(hoursBack).first<{ most_recent_attempt: string | null }>();
      const emailedRow = await env.DB.prepare(
        `SELECT MAX(generated_at) AS most_recent_emailed FROM threat_briefings
          WHERE emailed = 1`
      ).first<{ most_recent_emailed: string | null }>();
      const counts = await env.DB.prepare(
        `SELECT COUNT(*) AS attempts,
                SUM(CASE WHEN emailed = 1 THEN 1 ELSE 0 END) AS emailed
           FROM threat_briefings
          WHERE generated_at >= datetime('now', '-' || ? || ' hours')`
      ).bind(hoursBack).first<{ attempts: number; emailed: number }>();
      const recentList = await env.DB.prepare(
        `SELECT generated_at, trigger, emailed, report_date
           FROM threat_briefings
          ORDER BY generated_at DESC LIMIT 10`
      ).all<{ generated_at: string; trigger: string; emailed: number; report_date: string }>();
      // Pull the most recent failed attempt's report_data and
      // surface email_error / email_recipient. Stored by the
      // sendBriefingEmail caller per #946 follow-up.
      const lastFailed = await env.DB.prepare(
        `SELECT report_data FROM threat_briefings
          WHERE emailed = 0
          ORDER BY generated_at DESC LIMIT 1`
      ).first<{ report_data: string | null }>();
      let mostRecentError: string | null = null;
      let mostRecentRecipient: string | null = null;
      if (lastFailed?.report_data) {
        try {
          const parsed = JSON.parse(lastFailed.report_data) as {
            email_error?: string; email_recipient?: string;
          };
          mostRecentError = parsed.email_error ?? null;
          mostRecentRecipient = parsed.email_recipient ?? null;
        } catch { /* non-JSON or stale row */ }
      }
      const hoursSinceEmailed = emailedRow?.most_recent_emailed
        ? Math.round((Date.now() - Date.parse(emailedRow.most_recent_emailed.replace(' ', 'T') + 'Z')) / 3_600_000)
        : null;
      // Resend full-error breadcrumb — written by sendViaResend on every
      // failed pull (TTL 7 days). The `message` field captured in
      // threat_briefings.report_data.email_error is truncated; this KV
      // entry has the HTTP status, error name discriminator, and raw body
      // up to 1KB. Surfacing it here lets the diagnostics endpoint show
      // operators whether the failure mode is "rotate the key,"
      // "verify the domain," or "you hit the rate limit."
      let resendLastError: unknown = null;
      try {
        const cached = await env.CACHE.get('briefing:resend_last_error');
        if (cached) {
          try { resendLastError = JSON.parse(cached); } catch { resendLastError = cached; }
        }
      } catch { /* non-fatal */ }

      briefingStatus = {
        resend_configured: !!env.RESEND_API_KEY,
        most_recent_attempt: recentRow?.most_recent_attempt ?? null,
        most_recent_emailed: emailedRow?.most_recent_emailed ?? null,
        hours_since_emailed: hoursSinceEmailed,
        attempts_in_window: counts?.attempts ?? 0,
        emailed_in_window: counts?.emailed ?? 0,
        recent_attempts: recentList.results,
        most_recent_error: mostRecentError,
        most_recent_recipient: mostRecentRecipient,
        resend_last_error: resendLastError,
      };
    } catch {
      briefingStatus = {
        resend_configured: !!env.RESEND_API_KEY,
        most_recent_attempt: null,
        most_recent_emailed: null,
        hours_since_emailed: null,
        attempts_in_window: 0,
        emailed_in_window: 0,
        recent_attempts: [],
        most_recent_error: null,
        most_recent_recipient: null,
        resend_last_error: null,
      };
    }

    return json({
      success: true,
      data: {
        _meta: {
          generated_at: new Date().toISOString(),
          db_clock_utc: clock?.utc_now ?? null,
          window_hours: hoursBack,
          endpoint_version: 5,
        },

        enrichment_pipeline: {
          total_threats: enrichment?.total_threats ?? 0,
          active_threats: enrichment?.active_threats ?? 0,
          total_enriched: enrichment?.total_enriched ?? 0,
          enriched_last_hour: enrichment?.enriched_last_hour ?? 0,
          enriched_last_24h: enrichment?.enriched_last_24h ?? 0,
          stuck_pile: enrichment?.stuck_pile ?? 0,
          needs_dns: enrichment?.needs_dns ?? 0,
          domain_geo_drainable: domainGeoDrainable?.n ?? 0,
          cartographer_queue: cartoQueue?.n ?? 0,
          cartographer_queue_raw: cartoQueueRaw?.n ?? 0,
          cartographer_exhausted: cartoExhausted?.n ?? 0,
          cartographer_exhausted_by_feed: cartoExhaustedByFeed.results.map((r) => ({
            source_feed: r.source_feed,
            threat_type: r.threat_type,
            count: r.n,
          })),
          private_ip_inflation: (cartoQueueRaw?.n ?? 0) - (cartoQueue?.n ?? 0),
        },

        feeds: {
          summary: {
            total_feeds_with_activity: feedHealth.results.length,
            total_pulls: feedHealth.results.reduce((s, f) => s + f.total_pulls, 0),
            total_failures: feedHealth.results.reduce((s, f) => s + f.failed, 0),
            total_ingested: feedHealth.results.reduce((s, f) => s + f.total_ingested, 0),
          },
          per_feed: feedHealth.results.map(f => ({
            feed_name: f.feed_name,
            display_name: f.display_name,
            enabled: f.enabled === 1,
            paused_reason: f.paused_reason,
            pulls: f.total_pulls,
            success: f.success,
            partial: f.partial,
            failed: f.failed,
            failure_rate_pct: f.total_pulls > 0 ? Math.round((f.failed / f.total_pulls) * 100) : 0,
            records_ingested: f.total_ingested,
            // records_rejected = duplicates + parse errors. With the
            // threats table at 217K+ rows, most feeds publish IOCs
            // already known — large rejected counts mean dedup is
            // working as designed, NOT that the feed is broken.
            // Operators care about ingested=0 AND rejected=0
            // (truly silent feed).
            records_rejected: f.total_rejected,
            last_success_at: f.last_success_at,
            last_failure_at: f.last_failure_at,
          })),
          at_risk: feedsAtRisk,
          recent_errors: feedErrors.results,
        },

        agent_mesh: {
          summary: {
            total_agents_active: agentMesh.results.length,
            total_runs: agentMesh.results.reduce((s, a) => s + a.total_runs, 0),
            total_failures: agentMesh.results.reduce((s, a) => s + a.failed, 0),
            total_killed: agentMesh.results.reduce((s, a) => s + (a.killed_runs ?? 0), 0),
            stalled_count: stalled.results.length,
          },
          per_agent: agentMesh.results,
          stalled: stalled.results,
        },

        cron_health: cronHealth.results,

        backlog_trends: backlogTrends,

        ai_spend_24h: {
          total_cost_usd: aiSpend.results.reduce((s, a) => s + (a.cost_usd ?? 0), 0),
          total_calls: aiSpend.results.reduce((s, a) => s + a.calls, 0),
          by_agent: aiSpend.results,
        },

        platform_totals: totals,

        // What FC + agents have alerted operators about in the
        // requested window. One row per (type, group_key) so the
        // same dedup'd alert doesn't show up multiple times.
        recent_platform_alerts: {
          count: recentPlatformAlerts.results.length,
          items: recentPlatformAlerts.results,
        },

        // Daily briefing email pipeline state — debug
        // platform_briefing_silent alerts. resend_configured=false
        // means the entire path is non-functional. emailed_in_window
        // < attempts_in_window means Resend is rejecting sends.
        briefing_status: briefingStatus,

        // GeoIP MMDB reference DB — third-tier geo provider
        // (Cartographer Phase 0.5). Surfaces row count + last
        // refresh on the admin Pipeline Automation card and in the
        // platform-diagnostics report. configured=false means the
        // operator hasn't provisioned the dedicated D1 yet (see
        // wrangler.toml runbook block).
        geoip_db: await (async () => {
          const { getGeoMmdbStatus } = await import('../lib/geoip-mmdb');
          return getGeoMmdbStatus(env);
        })(),

        // FC tick phase timings — pulled from the most recent
        // flight_control diagnostic snapshot. Used to investigate
        // which step dominates the FC duration (currently ~4 min
        // post-#948; target <60s).
        fc_tick_timings: await getFcTickTimings(env.DB),

        // D1 row-read tracking against the 25B/month plan ceiling.
        // setup_required: true when CF_API_TOKEN / CF_ACCOUNT_ID aren't
        // configured — set them via `wrangler secret put` to enable.
        d1_metrics_24h: d1Metrics,

        // Per-endpoint D1 read attribution from Workers Analytics Engine.
        // Reads from the trust_radar_d1_reads dataset that opt-in handlers
        // populate via lib/analytics.ts.
        d1_attribution_24h: d1Attribution,

        // Soft-cap state — proves the Navigator daily budget cap is
        // actually firing (or not). threshold_state goes ok → warn → skip
        // as rows_read_24h crosses 85% / 95% of the daily budget. The
        // skip_count_24h + last_skip_at fields show whether Navigator
        // has been actively dropping non-essential pre-warms.
        d1_budget_state: d1BudgetState,

        // Top 20 D1 queries by rows_read in the last 24h, pulled from
        // CF's d1QueriesAdaptiveGroups GraphQL endpoint. Complements
        // the AE-based d1_attribution_24h by showing reads from
        // uninstrumented code paths (cron crons, internal /agents/run
        // calls, etc.). Returns { queries, error } so we can debug
        // when the fetch fails without grepping worker logs.
        d1_top_queries_24h: d1TopQueries.queries,
        d1_top_queries_error: d1TopQueries.error,

        // One-shot index health probe added 2026-04-29 to debug why
        // the migration-0123 composite index isn't being used by the
        // four ip_address+source_feed UPDATE queries. Returns the
        // current sqlite_master index list for threats/agent_outputs/
        // budget_ledger plus EXPLAIN QUERY PLAN of the offending
        // UPDATE. Safe to leave in place — runs five small reads.
        index_health: indexHealth,
      },
    }, 200, origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ success: false, error: message }, 500, origin);
  }
}
