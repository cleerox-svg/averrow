// Averrow — Platform Diagnostics Handler
//
// Comprehensive health check designed for programmatic consumption
// (Claude Code, monitoring, incident triage). Returns enrichment pipeline
// state, per-feed failure rates, per-agent run counts, backlog trends,
// AI spend, and platform totals in a single response.

import { json, corsHeaders } from "../lib/cors";
import { PRIVATE_IP_SQL_FILTER } from "../lib/geoip";
import { getBudgetDiagnostics, fetchD1TopQueries, fetchBillingCycleMetrics, fetchRecentWindowMetrics } from "../lib/d1-budget";
import { cachedCount, getCachedCountStats } from "../lib/cached-count";
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

export async function fetchD1Metrics(env: Env): Promise<D1Metrics> {
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
  // No databaseId filter: the projection below is expressed as a
  // percentage of the account-wide 25B/month ceiling, so the 24h
  // numerator must also be account-wide. Filtering to the primary `DB`
  // binding under-counted reads (and, more visibly, rows_written — the
  // audit DB dominates writes) and made monthly_rows_read_projection /
  // pct_of_25b_plan_ceiling read low. Mirrors fetchBillingCycleMetrics;
  // the groups are summed below across whatever databases CF returns.
  const query = `
    query {
      viewer {
        accounts(filter: { accountTag: "${accountId}" }) {
          d1AnalyticsAdaptiveGroups(
            filter: { datetimeHour_geq: "${since}" }
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

export async function fetchD1EndpointAttribution(env: Env): Promise<{
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
        SUM(CASE WHEN ip_address IS NULL AND dns_exhausted_at IS NULL AND malicious_domain IS NOT NULL THEN 1 ELSE 0 END) AS needs_dns
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

    // ── DNS-queue parity (PR-2 of DNS-queue split) ──
    // Counts the dns_queue side-DB so operators can verify the
    // reconciler is converging before PR-3 flips dns-backfill reads.
    // |queueSize - domain_geo_drainable| ≈ 0 means parity is healthy.
    // Skipped cleanly if DNS_QUEUE_DB isn't bound (dev environments).
    const dnsQueueSizeP: Promise<{ n: number; bound: boolean }> = (async () => {
      if (!env.DNS_QUEUE_DB) return { n: 0, bound: false };
      try {
        const row = await env.DNS_QUEUE_DB.prepare(
          'SELECT COUNT(*) AS n FROM dns_queue'
        ).first<{ n: number }>();
        return { n: row?.n ?? 0, bound: true };
      } catch {
        return { n: 0, bound: false };
      }
    })();

    // DNS-queue stability signals — server-side aggregation of the
    // five checks documented in `docs/PLATFORM_DATA_DEPENDENCIES.md`.
    // Consumed by `scripts/dns-queue-stability-check.sh` to print a
    // single green/red verdict before greenlighting PR-4 cleanup.
    // Three aggregates in parallel, each bounded by hoursBack.
    interface DnsQueueStability {
      source_counts: { queue: number; threats: number; total: number };
      throughput: {
        avg_processed: number | null;
        avg_resolved: number | null;
        avg_dead: number | null;
        avg_duration_ms: number | null;
      };
      reconciler: {
        runs: number;
        runs_with_failures: number;
        total_batch_failures: number;
        avg_scanned: number | null;
        avg_enqueued: number | null;
        avg_cursor_lag_minutes: number | null;
        max_cursor_lag_minutes: number | null;
      };
      reaper: {
        last_run_at: string | null;
        last_run_age_hours: number | null;
        last_stale_removed: number | null;
        runs_in_window: number;
        total_stale_removed: number | null;
      };
    }
    const dnsQueueStabilityP: Promise<DnsQueueStability> = (async () => {
      const windowExpr = `datetime('now', '-${hoursBack} hours')`;
      try {
        const reaperKvP = (async () => {
          try {
            const [lastRun, lastDelta] = await Promise.all([
              env.CACHE.get('reconciler:dns_queue:reaper_last_run'),
              env.CACHE.get('reconciler:dns_queue:reaper_last_delta'),
            ]);
            return { lastRun, lastDelta };
          } catch {
            return { lastRun: null, lastDelta: null };
          }
        })();
        const [sourceRow, throughputRow, reconcilerRow, reaperRow, reaperKv] = await Promise.all([
          env.DB.prepare(`
            SELECT
              SUM(CASE WHEN summary LIKE '%source=queue%' THEN 1 ELSE 0 END) AS queue_n,
              SUM(CASE WHEN summary LIKE '%source=threats%' THEN 1 ELSE 0 END) AS threats_n,
              COUNT(*) AS total_n
            FROM agent_outputs
            WHERE agent_id = 'navigator'
              AND type = 'diagnostic'
              AND summary LIKE 'dns-backfill:%'
              AND created_at >= ${windowExpr}
          `).first<{ queue_n: number; threats_n: number; total_n: number }>(),
          env.DB.prepare(`
            SELECT
              AVG(CAST(json_extract(details, '$.processed')      AS REAL)) AS avg_processed,
              AVG(CAST(json_extract(details, '$.resolved')       AS REAL)) AS avg_resolved,
              AVG(CAST(json_extract(details, '$.graduated_dead') AS REAL)) AS avg_dead,
              AVG(CAST(json_extract(details, '$.duration_ms')    AS REAL)) AS avg_duration_ms
            FROM agent_outputs
            WHERE agent_id = 'navigator'
              AND type = 'diagnostic'
              AND summary LIKE 'dns-backfill:%'
              AND created_at >= ${windowExpr}
          `).first<{
            avg_processed: number | null;
            avg_resolved: number | null;
            avg_dead: number | null;
            avg_duration_ms: number | null;
          }>(),
          env.DB.prepare(`
            SELECT
              COUNT(*)                                                       AS runs,
              SUM(CASE WHEN CAST(json_extract(details, '$.batches_failed')
                                AS INT) > 0 THEN 1 ELSE 0 END)               AS runs_with_failures,
              SUM(CAST(json_extract(details, '$.batches_failed') AS INT))    AS total_batch_failures,
              AVG(CAST(json_extract(details, '$.scanned')  AS REAL))         AS avg_scanned,
              AVG(CAST(json_extract(details, '$.enqueued') AS REAL))         AS avg_enqueued,
              AVG(CAST(json_extract(details, '$.cursor_lag_minutes') AS REAL)) AS avg_cursor_lag_minutes,
              MAX(CAST(json_extract(details, '$.cursor_lag_minutes') AS REAL)) AS max_cursor_lag_minutes
            FROM agent_outputs
            WHERE agent_id = 'navigator'
              AND type = 'diagnostic'
              AND summary LIKE 'dns-queue-reconcile%'
              AND created_at >= ${windowExpr}
          `).first<{
            runs: number;
            runs_with_failures: number;
            total_batch_failures: number;
            avg_scanned: number | null;
            avg_enqueued: number | null;
            avg_cursor_lag_minutes: number | null;
            max_cursor_lag_minutes: number | null;
          }>(),
          env.DB.prepare(`
            SELECT
              COUNT(*) AS runs,
              SUM(CAST(json_extract(details, '$.stale_removed') AS INT)) AS total_stale_removed
            FROM agent_outputs
            WHERE agent_id = 'navigator'
              AND type = 'diagnostic'
              AND summary LIKE 'dns-queue-reap%'
              AND created_at >= ${windowExpr}
          `).first<{ runs: number; total_stale_removed: number | null }>(),
          reaperKvP,
        ]);
        let reaperLastRunAgeHours: number | null = null;
        if (reaperKv.lastRun) {
          const ts = Date.parse(reaperKv.lastRun);
          if (!Number.isNaN(ts)) {
            reaperLastRunAgeHours = Math.floor((Date.now() - ts) / 3_600_000);
          }
        }
        const reaperLastDelta = reaperKv.lastDelta != null ? parseInt(reaperKv.lastDelta, 10) : null;
        return {
          source_counts: {
            queue: sourceRow?.queue_n ?? 0,
            threats: sourceRow?.threats_n ?? 0,
            total: sourceRow?.total_n ?? 0,
          },
          throughput: {
            avg_processed: throughputRow?.avg_processed ?? null,
            avg_resolved: throughputRow?.avg_resolved ?? null,
            avg_dead: throughputRow?.avg_dead ?? null,
            avg_duration_ms: throughputRow?.avg_duration_ms ?? null,
          },
          reconciler: {
            runs: reconcilerRow?.runs ?? 0,
            runs_with_failures: reconcilerRow?.runs_with_failures ?? 0,
            total_batch_failures: reconcilerRow?.total_batch_failures ?? 0,
            avg_scanned: reconcilerRow?.avg_scanned ?? null,
            avg_enqueued: reconcilerRow?.avg_enqueued ?? null,
            avg_cursor_lag_minutes: reconcilerRow?.avg_cursor_lag_minutes ?? null,
            max_cursor_lag_minutes: reconcilerRow?.max_cursor_lag_minutes ?? null,
          },
          reaper: {
            last_run_at: reaperKv.lastRun ?? null,
            last_run_age_hours: reaperLastRunAgeHours,
            last_stale_removed: Number.isNaN(reaperLastDelta as number) ? null : reaperLastDelta,
            runs_in_window: reaperRow?.runs ?? 0,
            total_stale_removed: reaperRow?.total_stale_removed ?? null,
          },
        };
      } catch {
        return {
          source_counts: { queue: 0, threats: 0, total: 0 },
          throughput: { avg_processed: null, avg_resolved: null, avg_dead: null, avg_duration_ms: null },
          reconciler: {
            runs: 0, runs_with_failures: 0, total_batch_failures: 0,
            avg_scanned: null, avg_enqueued: null,
            avg_cursor_lag_minutes: null, max_cursor_lag_minutes: null,
          },
          reaper: {
            last_run_at: null, last_run_age_hours: null,
            last_stale_removed: null, runs_in_window: 0, total_stale_removed: null,
          },
        };
      }
    })();

    // domain_geo_drainable — domains we can actually try right now
    // (cooldown expired, attempts < cap). Pairs with `domain_geo`
    // FC backlog (which includes all rows, even ones in cooldown).
    // The pair tells the operator: "30K total / 412 drainable now".
    //
    // PR-4: now reads from dns_queue (DNS_QUEUE_DB) instead of the
    // threats table. dns_queue is the source of truth for cooldown
    // + attempts state after the cleanup; threats.attempted_resolve_at
    // stops being written so the old query would return all rows as
    // "drainable" (false). Falls back to 0 when DNS_QUEUE_DB is
    // unbound (dev environments) since the legacy threats-side
    // dns-backfill path no longer matches the same semantics.
    const domainGeoDrainableP = cachedCount(env, 'count.dns_queue.drainable', 300, async () => {
      if (!env.DNS_QUEUE_DB) return 0;
      try {
        const row = await env.DNS_QUEUE_DB.prepare(`
          SELECT COUNT(*) AS n
          FROM dns_queue INDEXED BY idx_dns_queue_drainable
          WHERE enrichment_attempts < 8
            AND (attempted_resolve_at IS NULL
                 OR attempted_resolve_at < datetime('now', '-6 hours'))
        `).first<{ n: number }>();
        return row?.n ?? 0;
      } catch {
        return 0;
      }
    }).then((n) => ({ n }));

    // Cartographer queue — matches actual Phase 0 query (private IPs and
    // attempts-exhausted threats excluded — see migration 0110).
    //
    // All three carto-queue counts route through cachedCount with a 300s
    // TTL — diag is operator-facing and called multiple times per session
    // (script + dashboard + ad-hoc curl). 5-min freshness is well within
    // tolerance and avoids three full-table scans per call. PR-V bumped
    // from 60s → 300s after the cache hit-rate stayed at ~22% (the
    // diagnostics endpoint's own short-TTL counters were dominating
    // the miss ring and re-firing scans every minute).
    const cartoQueueP = cachedCount(env, 'count.threats.carto_queue', 300, async () => {
      const row = await env.DB.prepare(`
        SELECT COUNT(*) AS n FROM threats
        WHERE enriched_at IS NULL
          AND ip_address IS NOT NULL AND ip_address != ''
          AND enrichment_attempts < 5
          ${PRIVATE_IP_SQL_FILTER}
      `).first<{ n: number }>();
      return row?.n ?? 0;
    }).then((n) => ({ n }));

    // Cartographer queue WITHOUT private IP filter (for comparison — shows inflation)
    const cartoQueueRawP = cachedCount(env, 'count.threats.carto_queue_raw', 300, async () => {
      const row = await env.DB.prepare(`
        SELECT COUNT(*) AS n FROM threats
        WHERE enriched_at IS NULL
          AND ip_address IS NOT NULL AND ip_address != ''
          AND enrichment_attempts < 5
      `).first<{ n: number }>();
      return row?.n ?? 0;
    }).then((n) => ({ n }));

    // Threats exhausted by cartographer — hit the attempts cap with no geo.
    // These exit the active queue but stay in `threats`. A growing exhausted
    // count means ip-api can't enrich a meaningful share of the new threat
    // mix; consider adding a fallback geo source.
    const cartoExhaustedP = cachedCount(env, 'count.threats.carto_exhausted', 300, async () => {
      const row = await env.DB.prepare(`
        SELECT COUNT(*) AS n FROM threats
        WHERE enriched_at IS NULL
          AND ip_address IS NOT NULL AND ip_address != ''
          AND enrichment_attempts >= 5
      `).first<{ n: number }>();
      return row?.n ?? 0;
    }).then((n) => ({ n }));

    // Geo-enrichment coverage — mapped vs total threats per window. The
    // home tile reads `threats_mapped` from threat_cube_geo (lat/lng
    // required); `threats_total` reads from threat_cube_status (no geo
    // requirement). The ratio tells operators when the home tile is
    // bleeding because of geo regressions (empty MMDB, ip-api outages,
    // exhausted enrichment_attempts) rather than actual ingest decline.
    //
    // Windows are picked to mirror the home tile (`7d`) plus a near-term
    // (`24h`) and a longer trend (`30d`) for sanity checks. All three
    // queries hit the cubes — no raw threats scans.
    const geoCoverageWindows: Array<{ key: '24h' | '7d' | '30d'; sqlOffset: string }> = [
      { key: '24h', sqlOffset: "datetime('now', '-24 hours')" },
      { key: '7d',  sqlOffset: "datetime('now', '-7 days')" },
      { key: '30d', sqlOffset: "datetime('now', '-30 days')" },
    ];
    const geoCoverageP = Promise.all(
      geoCoverageWindows.map(async (w) => {
        const [mapped, total] = await Promise.all([
          env.DB.prepare(
            `SELECT COALESCE(SUM(threat_count), 0) AS n FROM threat_cube_geo WHERE hour_bucket >= strftime('%Y-%m-%d %H:00:00', ${w.sqlOffset})`
          ).first<{ n: number }>(),
          env.DB.prepare(
            `SELECT COALESCE(SUM(threat_count), 0) AS n FROM threat_cube_status WHERE hour_bucket >= strftime('%Y-%m-%d %H:00:00', ${w.sqlOffset})`
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
      })
    );

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

    // Alerts table growth by brand tier (NX2 tier-gate visibility).
    // The createAlert tier gate skips inserts when brands.tier='tracked'
    // so the alerts table doesn't grow proportional to the ~76K tracked
    // brands. This query proves the gate is working: under steady state
    // the 'tracked' row should be 0 (or only legacy rows from before
    // the gate landed).
    const alertsByTierP = env.DB.prepare(`
      SELECT
        COALESCE(b.tier, 'unclassified') AS tier,
        COUNT(*) AS total,
        SUM(CASE WHEN a.created_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS created_24h
      FROM alerts a
      LEFT JOIN brands b ON b.id = a.brand_id
      GROUP BY COALESCE(b.tier, 'unclassified')
      ORDER BY total DESC
    `).all<{ tier: string; total: number; created_24h: number }>();

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
      WHERE datetime(fph.started_at) >= datetime('now', '-' || ? || ' hours')
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
        AND datetime(started_at) >= datetime('now', '-' || ? || ' hours')
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
        -- Average only over runs that completed normally. Reaped runs are
        -- stamped status='failed' with a duration spanning the full reap
        -- ceiling (e.g. 510min for strategist), which otherwise dominates
        -- the mean and makes avg_duration_ms meaningless. Mid-run kills are
        -- status='partial' with completed_at NULL. Excluding both (and any
        -- still-'running' row) keeps the figure representative of real
        -- execution time.
        AVG(CASE WHEN status IN ('success', 'partial') AND completed_at IS NOT NULL THEN duration_ms END) AS avg_duration_ms
      FROM agent_runs
      WHERE datetime(started_at) >= datetime('now', '-' || ? || ' hours')
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

    // Workflow-agent rollup from agent_activity_log. The Workflow path
    // (lib/workflow-dispatch.ts + workflows/*.ts) does NOT write to
    // agent_runs — it writes structured events to agent_activity_log:
    //
    //   workflow_dispatched / workflow_dispatch_failed / workflow_cooldown_skip
    //     written by dispatchWorkflow() at dispatch time
    //   started / batch_complete
    //     written by the workflow body itself once it begins running
    //
    // Without this rollup, the agent_runs query above counts 0 runs
    // and 0 successes for nexus (and any other workflow agent) — even
    // when nexus is firing successfully every 4h. PR-J reconciles
    // workflow agents into the same agent_mesh.per_agent shape so the
    // dashboard reflects reality.
    const workflowAgentMeshP = env.DB.prepare(`
      SELECT
        agent_id,
        SUM(CASE WHEN event_type = 'workflow_dispatched' THEN 1 ELSE 0 END) AS dispatched,
        SUM(CASE WHEN event_type = 'batch_complete' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN event_type = 'workflow_dispatch_failed' THEN 1 ELSE 0 END) AS dispatch_failed,
        SUM(CASE WHEN event_type = 'workflow_cooldown_skip' THEN 1 ELSE 0 END) AS cooldown_skipped,
        MAX(CASE WHEN event_type = 'batch_complete' THEN created_at END) AS last_completed_at,
        MAX(CASE WHEN event_type = 'workflow_dispatch_failed' THEN message END) AS last_error
      FROM agent_activity_log
      WHERE created_at >= datetime('now', '-' || ? || ' hours')
        AND event_type IN ('workflow_dispatched','batch_complete','workflow_dispatch_failed','workflow_cooldown_skip')
      GROUP BY agent_id
    `).bind(hoursBack).all<{
      agent_id: string;
      dispatched: number;
      completed: number;
      dispatch_failed: number;
      cooldown_skipped: number;
      last_completed_at: string | null;
      last_error: string | null;
    }>();

    // Stalled agents — started but never completed in the last N hours
    const stalledP = env.DB.prepare(`
      SELECT agent_id, id AS run_id, started_at,
             ROUND((julianday('now') - julianday(started_at)) * 24 * 60, 1) AS minutes_stalled
      FROM agent_runs
      WHERE status = 'running'
        AND datetime(started_at) < datetime('now', '-15 minutes')
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
             -- See per-agent query above: exclude reaped/failed runs and
             -- mid-run kills so a single reaped cron run (e.g. navigator
             -- stamped at the 60min reap ceiling) can't dominate the mean.
             AVG(CASE WHEN status IN ('success', 'partial') AND completed_at IS NOT NULL THEN duration_ms END) AS avg_duration_ms
      FROM agent_runs
      WHERE agent_id IN ('navigator', 'fast_tick', 'flight_control', 'orchestrator')
        AND datetime(started_at) >= datetime('now', '-' || ? || ' hours')
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
    // Account-wide (all databases) so the 25B-ceiling projection is
    // computed against a matching numerator — see fetchD1Metrics.
    const d1MetricsP = fetchD1Metrics(env);
    const d1AttributionP = fetchD1EndpointAttribution(env);
    // Soft-cap state (Navigator skip tracking + thresholds) and the
    // per-query top-N from CF's d1QueriesAdaptiveGroups. Both fail
    // gracefully — diagnostics endpoint stays usable when CF GraphQL
    // is down or CF_API_TOKEN isn't configured.
    const d1BudgetStateP = getBudgetDiagnostics(env);
    const d1TopQueriesP = fetchD1TopQueries(env, 20, "reads");
    // Parallel write-spender view. Writes have their own included
    // quota on Workers Paid (50M/mo) so the operator needs a separate
    // top-N ordered by rowsWritten to attribute overage.
    const d1TopWriteQueriesP = fetchD1TopQueries(env, 20, "writes");
    // PR-X: billing-cycle (18th-17th) reads summed across all D1 DBs
    // on the account. Replaces the rolling-24h × 30 projection in the
    // monthly meter — see lib/d1-budget.ts header for why.
    const d1BillingCycleP = fetchBillingCycleMetrics(env);
    // PR-AM: recent-window per-DB metrics (default 12h). Used to monitor
    // post-fix activity without waiting for cycle aggregates. The `hours`
    // query param on the endpoint controls the window — falls back to
    // 12h when missing.
    const d1RecentP = fetchRecentWindowMetrics(env, hoursBack);

    // ─── 9. Module entitlements (v3 Phase A) ────────────────────────
    // Per-module count of orgs in each status. With 7 modules and a
    // small number of orgs this is a tiny scan; revisit when org
    // count > 1000 (we'd materialize into a daily snapshot).
    const moduleEntitlementsP = env.DB.prepare(`
      SELECT module_key,
        SUM(CASE WHEN status = 'active'    THEN 1 ELSE 0 END) AS active_orgs,
        SUM(CASE WHEN status = 'trial'     THEN 1 ELSE 0 END) AS trial_orgs,
        SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended_orgs
      FROM org_modules
      GROUP BY module_key
      ORDER BY module_key
    `).all<{
      module_key: string;
      active_orgs: number;
      trial_orgs: number;
      suspended_orgs: number;
    }>();

    // ── Execute all in parallel ─────────────────────────────────────
    const [
      clock, enrichment, cartoQueue, cartoQueueRaw, cartoExhausted, cartoExhaustedByFeed, domainGeoDrainable,
      geoCoverage,
      feedHealth, feedStatus, feedErrors,
      agentMesh, workflowAgentMesh, stalled, backlog,
      aiSpend, cronHealth, totals, d1Metrics, d1Attribution,
      d1BudgetState, d1TopQueries, d1TopWriteQueries, d1BillingCycle, d1Recent,
      cachedCountStats,
      moduleEntitlements,
      alertsByTier,
      dnsQueueSize,
      dnsQueueStability,
    ] = await Promise.all([
      clockP, enrichmentP, cartoQueueP, cartoQueueRawP, cartoExhaustedP, cartoExhaustedByFeedP, domainGeoDrainableP,
      geoCoverageP,
      feedHealthP, feedStatusP, feedErrorsP,
      agentMeshP, workflowAgentMeshP, stalledP, backlogP,
      aiSpendP, cronHealthP, totalsP, d1MetricsP, d1AttributionP,
      d1BudgetStateP, d1TopQueriesP, d1TopWriteQueriesP, d1BillingCycleP, d1RecentP,
      getCachedCountStats(env),
      moduleEntitlementsP,
      alertsByTierP,
      dnsQueueSizeP,
      dnsQueueStabilityP,
    ]);

    // Reconcile workflow-agent rollups into agent_mesh.per_agent shape.
    // For each workflow agent (anything with workflow_* events in
    // agent_activity_log), build a synthetic row matching the agent_runs
    // rollup shape. If an agent appears in BOTH agent_runs and the
    // workflow rollup (e.g. nexus has historical inline-recovery rows in
    // agent_runs from before PR-D's deploy), the workflow-derived numbers
    // win because workflow dispatch is the canonical path going forward.
    // The agent_runs side gets surfaced as a `legacy_inline` field for
    // operator awareness (so a partial stuck-row backlog from before the
    // workflow cutover doesn't go invisible).
    type AgentMeshRow = typeof agentMesh.results[number] & {
      dispatch_source?: 'agent_runs' | 'workflow';
      cooldown_skipped?: number;
      legacy_inline?: {
        total_runs: number;
        success: number;
        failed: number;
        partial: number;
        killed_runs: number;
      };
    };
    const agentMeshMerged: AgentMeshRow[] = (() => {
      const byAgent: Record<string, AgentMeshRow> = {};
      for (const row of agentMesh.results) {
        byAgent[row.agent_id] = { ...row, dispatch_source: 'agent_runs' };
      }
      for (const wf of workflowAgentMesh.results) {
        const inlineLegacy = byAgent[wf.agent_id];
        byAgent[wf.agent_id] = {
          agent_id: wf.agent_id,
          total_runs: wf.dispatched + wf.dispatch_failed + wf.cooldown_skipped,
          success: wf.completed,
          partial: 0,
          killed_runs: 0,
          failed: wf.dispatch_failed,
          running: Math.max(0, wf.dispatched - wf.completed - wf.dispatch_failed),
          last_completed_at: wf.last_completed_at,
          last_error: wf.last_error,
          total_records_processed: 0, // workflows don't write records_processed
          avg_duration_ms: null,
          dispatch_source: 'workflow',
          cooldown_skipped: wf.cooldown_skipped,
          ...(inlineLegacy ? { legacy_inline: {
            total_runs: inlineLegacy.total_runs,
            success: inlineLegacy.success,
            failed: inlineLegacy.failed,
            partial: inlineLegacy.partial,
            killed_runs: inlineLegacy.killed_runs,
          } } : {}),
        };
      }
      return Object.values(byAgent).sort((a, b) => a.agent_id.localeCompare(b.agent_id));
    })();

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
      // surface email_error / email_recipient — but ONLY if no
      // successful email has landed since. Stickiness fix: pre-
      // change, a single past failure stayed visible forever in
      // diagnostics (`most_recent_error: API key is invalid`)
      // even after the next refresh succeeded, leading operators
      // to think the issue was still active. Now the error clears
      // automatically once a later success row exists.
      const lastFailed = await env.DB.prepare(
        `SELECT generated_at, report_data
           FROM threat_briefings
          WHERE emailed = 0
          ORDER BY generated_at DESC LIMIT 1`
      ).first<{ generated_at: string; report_data: string | null }>();
      let mostRecentError: string | null = null;
      let mostRecentRecipient: string | null = null;
      const lastFailedAfterLastSuccess =
        !!lastFailed?.generated_at &&
        (!emailedRow?.most_recent_emailed ||
          Date.parse(lastFailed.generated_at.replace(' ', 'T') + 'Z')
          > Date.parse(emailedRow.most_recent_emailed.replace(' ', 'T') + 'Z'));
      if (lastFailedAfterLastSuccess && lastFailed?.report_data) {
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

    // Brand counter drift telemetry — stamped by the cube_healer's
    // reconciliation stage (lib/brand-count-reconciler.ts) every 6h.
    // `drifted` staying large across runs means a brand-link writer is
    // skipping the counter bump again. null = reconciler hasn't run
    // since deploy (or KV stamp expired after 7 days of not running).
    const brandCountDrift = await (async () => {
      try {
        const raw = await env.CACHE.get('metrics:brand_threat_count_drift');
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })();

    return json({
      success: true,
      data: {
        _meta: {
          generated_at: new Date().toISOString(),
          db_clock_utc: clock?.utc_now ?? null,
          window_hours: hoursBack,
          endpoint_version: 9,
        },

        brand_count_drift: brandCountDrift,

        geo_coverage: {
          // Per-window mapped/total/coverage_pct. The home tile's "Threats · 7d"
          // reads `mapped` for the 7d window; if `coverage_pct` drops noticeably
          // (>15pt below the 30d baseline), the GeoIP enrichment path is degraded
          // even when ingest is healthy.
          windows: geoCoverage,
          // Convenience flag — true when 7d coverage is below 50% AND the 30d
          // baseline was above 70%. Surfaces "we used to map 80%, now we're
          // mapping 40%" without needing to compare windows manually.
          degraded: (() => {
            const w7  = geoCoverage.find((w) => w.window === '7d');
            const w30 = geoCoverage.find((w) => w.window === '30d');
            if (!w7 || !w30) return false;
            if (w7.coverage_pct === null || w30.coverage_pct === null) return false;
            return w7.coverage_pct < 50 && w30.coverage_pct > 70;
          })(),
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

        // DNS-queue parity (PR-2 of DNS-queue split). Mirrors the
        // dns-backfill working set into DNS_QUEUE_DB. Healthy state:
        // |delta| ≈ 0 after one Navigator tick. Persistent positive
        // delta = stale rows not being dequeued; persistent negative
        // delta = enqueue lagging behind threats. Use this as the
        // green-light check before merging PR-3 (the read flip).
        dns_queue_parity: {
          bound: dnsQueueSize.bound,
          queue_size: dnsQueueSize.n,
          drainable_in_threats: domainGeoDrainable?.n ?? 0,
          delta: dnsQueueSize.bound ? dnsQueueSize.n - (domainGeoDrainable?.n ?? 0) : null,
        },

        // PR-3 → PR-4 gate: aggregated stability signals over the
        // requested window. Consumed by `scripts/dns-queue-stability-
        // check.sh` to print a single green/red verdict before
        // merging the cleanup PR. Each signal is documented in
        // `docs/PLATFORM_DATA_DEPENDENCIES.md` and the script's
        // header comment.
        dns_queue_stability: dnsQueueStability,

        alerts: {
          // NX2 tier-gate visibility. `tracked` should trend to 0 (or
          // hold steady at the legacy pre-gate count); growth there means
          // a producer is bypassing createAlert. `customer` + `monitored`
          // are the normal path. `unclassified` is the LEFT JOIN miss.
          by_tier: alertsByTier.results.map((r) => ({
            tier: r.tier,
            total: r.total,
            created_24h: r.created_24h,
          })),
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
            total_agents_active: agentMeshMerged.length,
            total_runs: agentMeshMerged.reduce((s, a) => s + a.total_runs, 0),
            total_failures: agentMeshMerged.reduce((s, a) => s + a.failed, 0),
            total_killed: agentMeshMerged.reduce((s, a) => s + (a.killed_runs ?? 0), 0),
            stalled_count: stalled.results.length,
          },
          per_agent: agentMeshMerged,
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

        // v3 Phase A — module entitlements summary across the platform.
        // One row per module; counts are how many orgs sit in each
        // status. Empty list pre-seeding (no orgs entitled to anything
        // yet) is the correct steady state until averrow-tenant
        // onboarding lands in Phase A sprint 2.
        modules: {
          per_module: moduleEntitlements.results,
          total_entitlements: moduleEntitlements.results.reduce(
            (s, r) => s + r.active_orgs + r.trial_orgs + r.suspended_orgs,
            0,
          ),
        },

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

        // KV-backed counter cache hit/miss ratio over the recent ring
        // window. Surfaces whether the Phase 1 cachedCount migration
        // is actually reducing D1 spend (hit_rate >70% expected once
        // the cache is warm). hit_rate is null until the ring has any
        // observed hit/miss outcomes. See `lib/cached-count.ts`.
        cached_count: cachedCountStats,

        // D1 row-read tracking against the 25B/month plan ceiling.
        // Account-wide (all databases) rolling 24h — the numerator now
        // matches the account-wide ceiling in pct_of_25b_plan_ceiling.
        // setup_required: true when CF_API_TOKEN / CF_ACCOUNT_ID aren't
        // configured — set them via `wrangler secret put` to enable.
        d1_metrics_24h: d1Metrics,

        // PR-X: Cloudflare billing-cycle (18th → 17th) tracker. Sums
        // rows_read/written across ALL D1 databases on the account, with
        // a per-database breakdown and cycle-to-date pace. The rolling-24h
        // block above is the same account-wide scope over the last 24h;
        // this is the cycle-to-date view. Drives the "Billing-cycle
        // projection" meter on /admin/metrics and gives operators an
        // honest "X of N days elapsed, on pace for Y% of the 25B ceiling".
        d1_billing_cycle: d1BillingCycle,

        // PR-AM: per-database read/write activity over the requested
        // window (defaults to 6h, capped at 48h via `hours` query
        // param). Lets the operator see whether a recent fix to a
        // specific worker has actually reduced its load, without
        // waiting for the cycle aggregate to update.
        d1_recent_window: d1Recent,

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

        // Parallel top-N ordered by rowsWritten instead of rowsRead —
        // attributes write spend so the operator can tell which
        // INSERT/UPDATE/DELETE paths are driving toward the 50M/mo
        // Workers Paid included write quota. Same { queries, error }
        // shape as the reads view.
        d1_top_write_queries_24h: d1TopWriteQueries.queries,
        d1_top_write_queries_error: d1TopWriteQueries.error,

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
