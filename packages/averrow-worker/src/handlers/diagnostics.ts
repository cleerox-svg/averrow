// Averrow — Platform Diagnostics Handler
//
// Comprehensive health check designed for programmatic consumption
// (Claude Code, monitoring, incident triage). Returns enrichment pipeline
// state, per-feed failure rates, per-agent run counts, backlog trends,
// AI spend, and platform totals in a single response.

import { json, corsHeaders } from "../lib/cors";
import { PRIVATE_IP_SQL_FILTER } from "../lib/geoip";
import { GEO_UNMAPPED_POPULATION_SQL, GEO_UNMAPPED_THREATS_FROM, GEO_TERMINAL_SQL } from "../lib/geo-exhaustion";
import { withIndexHintFallback } from "../lib/indexed-by-fallback";
import { getBudgetDiagnostics, fetchD1TopQueries, fetchBillingCycleMetrics, fetchRecentWindowMetrics, fetchD1HourlyMetrics, clampHourlyWindow, hourlyWindowStart, toHourLabel, D1_TOP_QUERIES_SAMPLING_NOTE } from "../lib/d1-budget";
import { cachedCount, getCachedCountStats, peekCountEntry } from "../lib/cached-count";
import { cachedValue, type SingleFlightOptions } from "../lib/cached-value";
import { runSequential, softSection, sleep, type SectionErrors } from "../lib/run-sequential";
import { isD1OverloadError } from "../lib/d1-retry";
import { readVelocityDiag, VELOCITY_DIAG_PENDING_ERROR, type VelocityDiag } from "../lib/velocity-diag";
import { readDmarcDrops24h, type DmarcDropCounts } from "../lib/dmarc-enrollment";
import {
  countDnsCandidatesInThreats,
  DNS_DRAINABLE_CACHE_KEY,
  DNS_DRAINABLE_TTL_S,
} from "../lib/dns-drainable";
import { parseNewestFailure } from "../lib/haiku";
import { notRetiredClusterSql, retiredClusterSql } from "../lib/cluster-status";
import { SHADOW_SIGNAL_WEIGHTS, shadowScoreDelta } from "../lib/page-phishing-scorer";
import { NRD_RETENTION_LAST_RESULT_KEY, parseNrdRetentionLastResult } from "../lib/nrd-retention";
import type { Env } from "../types";
import { labelPerDatabase } from "../lib/db-registry";
import { getDatabasesPayload, type DatabasesPayload } from "../lib/db-health";
import { getWorkflowAgentStats } from "../lib/workflow-agent-stats";
import { familyStore, telemetryStore } from "../lib/db-route";
import { byDesc, byId, historyParts, unionAggregateFirst, unionFirst, unionGroupedResult, unionRowsResult } from "../lib/telemetry-read";

/**
 * Track B1d: on the feeds union path, the per-feed rollup's config columns
 * (display_name, enabled, paused_reason) come from the ROUTED store's
 * feed_configs — not the per-part LEFT JOIN, which for a feed whose in-window
 * pulls all sit on core would show core's stale pause state. One part (feeds
 * never on telemetry): the rows are returned untouched.
 */
export async function withRoutedFeedConfig<T extends { feed_name: string; display_name: string | null; enabled: number | null; paused_reason: string | null }>(
  env: Env,
  result: { results: T[]; meta: { rows_read: number; rows_written: number } },
): Promise<{ results: T[]; meta: { rows_read: number; rows_written: number } }> {
  if ((await historyParts(env, 'feed_pull_history')).length === 1) return result;
  const cfg = await (await familyStore(env, 'feeds')).prepare(
    `SELECT feed_name, display_name, enabled, paused_reason FROM feed_configs`,
  ).all<{ feed_name: string; display_name: string | null; enabled: number | null; paused_reason: string | null }>();
  const byName = new Map((cfg.results ?? []).map((c) => [c.feed_name, c]));
  return {
    ...result,
    results: result.results.map((r) => {
      const c = byName.get(r.feed_name);
      return { ...r, display_name: c?.display_name ?? null, enabled: c?.enabled ?? null, paused_reason: c?.paused_reason ?? null };
    }),
  };
}

// ─── Diagnostics caching (D1 overload 2026-11-08) ─────────────────
/** KV key + TTL for the enrichment_pipeline whole-threats-table pass. */
export const DIAG_ENRICHMENT_CACHE_KEY = "diag.enrichment_pipeline.v1";
// The endpoint is called on demand (script / MCP / admin tab), often less
// than once per TTL, so a short TTL meant most calls arrived to an empty
// key and paid the full scan anyway. 30 min / 1h TTLs (entries live 2x
// that for stale-serve) keep a typical health-check cadence on cache.
export const DIAG_ENRICHMENT_TTL_S = 1800;
/** TTL for slow-moving whole-table sections (platform_totals, alerts.by_tier). */
export const DIAG_SLOW_SECTION_TTL_S = 3600;
/**
 * Single-flight refill for the scan-backed diagnostics caches: one caller
 * recomputes an expired entry while the others get the stale value, so
 * the script + MCP + an admin tab can't each fire the same full scan.
 * A cold-key waiter gives up after 2s (5 sections × 2s worst case), not
 * 10s each — a longer wait only delayed a duplicate scan, not prevented it.
 */
export const DIAG_SINGLE_FLIGHT: SingleFlightOptions = { lockTtlSeconds: 120, waitMs: 2_000, pollMs: 500 };

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
async function getFcTickTimings(env: Env): Promise<{
  total_ms: number | null;
  generated_at: string | null;
  timings: Record<string, number> | null;
  ranked: Array<{ phase: string; ms: number; pct: number }>;
} | null> {
  try {
    // Newest FC diagnostic on EITHER DB (agent_outputs spans telemetry ∪
    // core, Track B1 wave 2).
    const row = await unionFirst<{ details: string; created_at: string }>(await historyParts(env, "agent_outputs"), () => ({
      sql: `SELECT details, created_at FROM agent_outputs
        WHERE agent_id = 'flight_control' AND type = 'diagnostic'
        ORDER BY created_at DESC LIMIT 1`,
      binds: [],
    }), { sort: byDesc<{ details: string; created_at: string }>("created_at") });
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

// ─── AE SQL record counting (2026-11-23 fix) ───────────────────────
// The v2 point shape (lib/analytics.ts) needs a RECORD count, not a point
// count: double6 is 1 on a record's first point, 0 on its extra store
// points; pre-v2 points have blob2 '' and double6 0. The 2026-11-22 readers
// expressed that as `SUM(_sample_interval * if(blob2 = '', 1, double6))`,
// and from that deploy on both AE readers answered HTTP 422 (the only SQL
// change in both). The readers now use only constructs the pre-22nd queries
// and lib/db-health.ts already run successfully — plain
// `SUM(_sample_interval * doubleN)` grouped by blob2 — and fold the weight in
// code: a '' point is always its record's only point (new: double6 = 1;
// pre-v2: double6 = 0), so its record count is SUM(_sample_interval); any
// other store's is SUM(_sample_interval * double6). Same numbers as the
// if() form intended.

/** Top endpoints returned by d1_attribution_24h. */
export const D1_ENDPOINT_ATTRIBUTION_TOP = 40;

/** Weighted record count of one (…, store) AE row (see the block comment). */
export function foldAeRecordCount(r: { store?: string | null; points?: unknown; weighted?: unknown }): number {
  const store = r.store ?? "";
  return store === "" ? Number(r.points) || 0 : Number(r.weighted) || 0;
}

/** HTTP-status error text plus the head of AE's error body (no secrets in it). */
async function aeSqlErrorText(res: Response): Promise<string> {
  let detail = "";
  try {
    detail = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    // body unreadable — status alone
  }
  return detail ? `AE SQL HTTP ${res.status}: ${detail}` : `AE SQL HTTP ${res.status}`;
}

/**
 * d1_attribution_24h query: per (endpoint, store) over the past 24h. Every
 * aggregate is weighted by _sample_interval (AE down-samples). Per-endpoint
 * totals and the top D1_ENDPOINT_ATTRIBUTION_TOP are computed in code, so
 * the LIMIT only guards the row count (endpoints × ≤6 stores).
 */
export const D1_ENDPOINT_ATTRIBUTION_SQL = `
    SELECT
      blob1 AS endpoint,
      blob2 AS store,
      SUM(_sample_interval * double1) AS total_rows_read,
      SUM(_sample_interval * double3) AS total_queries,
      SUM(_sample_interval) AS points,
      SUM(_sample_interval * double6) AS weighted
    FROM trust_radar_d1_reads
    WHERE timestamp > NOW() - INTERVAL '1' DAY
    GROUP BY endpoint, store
    ORDER BY total_rows_read DESC
    LIMIT 2000
  `;

/** d1_attribution_hourly query for a window start (`YYYY-MM-DD HH:MM:SS`, computed by us). */
export function buildD1HourlyAttributionSql(start: string): string {
  return `
    SELECT
      toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour,
      blob1 AS endpoint,
      blob2 AS store,
      SUM(_sample_interval * double1) AS rows_read,
      SUM(_sample_interval * double2) AS rows_written,
      SUM(_sample_interval * double3) AS queries,
      SUM(_sample_interval) AS points,
      SUM(_sample_interval * double6) AS weighted
    FROM trust_radar_d1_reads
    WHERE timestamp >= toDateTime('${start}')
      AND (startsWith(blob1, 'agent:') OR startsWith(blob1, 'cron:') OR startsWith(blob1, 'workflow:') OR startsWith(blob1, 'feed:') OR startsWith(blob1, 'job:'))
    GROUP BY hour, endpoint, store
    ORDER BY hour DESC, rows_read DESC
    LIMIT 10000
  `;
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
  // double1 = rowsRead, double2 = rowsWritten, double3 = queries,
  // double6 = record weight. Built by D1_ENDPOINT_ATTRIBUTION_SQL; the
  // per-endpoint record count is folded in code (foldAeRecordCount).
  const sql = D1_ENDPOINT_ATTRIBUTION_SQL;

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
        error: await aeSqlErrorText(res),
      };
    }

    const json = (await res.json()) as {
      data?: Array<{
        endpoint: string;
        store?: string;
        total_rows_read: number | string;
        total_queries: number | string;
        points?: number | string;
        weighted?: number | string;
      }>;
    };

    // Rows are per (endpoint, store); fold to one row per endpoint.
    const byEndpoint = new Map<string, { read: number; queries: number; reqs: number }>();
    for (const r of json.data ?? []) {
      const e = byEndpoint.get(r.endpoint) ?? { read: 0, queries: 0, reqs: 0 };
      // AE SQL can serialise sums as strings — coerce defensively.
      e.read += Number(r.total_rows_read) || 0;
      e.queries += Number(r.total_queries) || 0;
      e.reqs += foldAeRecordCount(r);
      byEndpoint.set(r.endpoint, e);
    }
    return {
      by_endpoint: Array.from(byEndpoint.entries())
        .map(([endpoint, e]) => ({
          endpoint,
          total_rows_read: e.read,
          total_queries: e.queries,
          request_count: e.reqs,
          avg_rows_per_request: e.reqs > 0 ? Math.round(e.read / e.reqs) : 0,
        }))
        .sort((a, b) => b.total_rows_read - a.total_rows_read)
        .slice(0, D1_ENDPOINT_ATTRIBUTION_TOP),
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

// ─── Hourly per-job D1 attribution (AE) ─────────────────────────────
// Same dataset as fetchD1EndpointAttribution, bucketed by UTC hour and
// restricted to the per-job labels written by lib/d1-meter.ts
// (`agent:` / `cron:` / `workflow:`, incl. `:bg` tails), top
// D1_ATTRIBUTION_HOURLY_TOP per hour by rows_read. Covers exactly the same
// whole-hour buckets as `d1_hourly` (hourlyWindowStart) with the same
// `YYYY-MM-DDTHH:00:00Z` labels (toHourLabel), so the two join on `hour`.
// The meter layers are exclusive, so these rows are disjoint: they can be
// summed and compared against that hour's `d1_hourly.rows_read` — the
// remainder is unmetered traffic (HTTP handlers, the GeoIP import, …).
// `points` counts records, not AE points (per-store split: see
// fetchD1EndpointAttribution).

export const D1_ATTRIBUTION_HOURLY_TOP = 10;

export interface D1HourlyAttributionRow {
  hour: string;
  endpoints: Array<{ endpoint: string; rows_read: number; rows_written: number; queries: number; points: number }>;
}

export async function fetchD1HourlyAttribution(
  env: Env,
  hoursBack: number,
  now: Date = new Date(),
): Promise<{ hours: D1HourlyAttributionRow[]; setup_required: boolean; error?: string }> {
  const token = (env as unknown as Record<string, string | undefined>).CF_API_TOKEN;
  const accountId = (env as unknown as Record<string, string | undefined>).CF_ACCOUNT_ID;
  if (!token || !accountId) return { hours: [], setup_required: true };

  // The window start is derived from a Date we compute (never from request
  // input) and interpolated into AE SQL, which has no bind parameters.
  const start = hourlyWindowStart(hoursBack, now).toISOString().slice(0, 19).replace("T", " ");
  // ORDER BY hour DESC so that if LIMIT ever truncates, the oldest hours go,
  // not the newest.
  const sql = buildD1HourlyAttributionSql(start);

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
        body: sql,
      },
    );
    if (!res.ok) return { hours: [], setup_required: false, error: await aeSqlErrorText(res) };
    const json = (await res.json()) as {
      data?: Array<{
        hour: string;
        endpoint: string;
        store?: string;
        rows_read: number | string;
        rows_written: number | string;
        queries: number | string;
        points?: number | string;
        weighted?: number | string;
      }>;
    };
    // Rows are per (hour, endpoint, store); fold the stores per endpoint.
    const byHour = new Map<string, D1HourlyAttributionRow>();
    const index = new Map<string, D1HourlyAttributionRow["endpoints"][number]>();
    for (const r of json.data ?? []) {
      const hour = toHourLabel(String(r.hour));
      const bucket = byHour.get(hour) ?? { hour, endpoints: [] };
      byHour.set(hour, bucket);
      const key = `${hour}\u0000${r.endpoint}`;
      let e = index.get(key);
      if (!e) {
        e = { endpoint: r.endpoint, rows_read: 0, rows_written: 0, queries: 0, points: 0 };
        index.set(key, e);
        bucket.endpoints.push(e);
      }
      e.rows_read += Number(r.rows_read) || 0;
      e.rows_written += Number(r.rows_written) || 0;
      e.queries += Number(r.queries) || 0;
      e.points += foldAeRecordCount(r);
    }
    const out = Array.from(byHour.values()).sort((a, b) => a.hour.localeCompare(b.hour));
    for (const h of out) {
      h.endpoints.sort((a, b) => b.rows_read - a.rows_read);
      h.endpoints = h.endpoints.slice(0, D1_ATTRIBUTION_HOURLY_TOP);
    }
    return { hours: out, setup_required: false };
  } catch (err) {
    return { hours: [], setup_required: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── DNS-queue parity: threats-side candidate count ──────────────────
// The REAL "how many domains still need DNS resolution" number. Its
// predicate is the same candidate set that FC's `platform_dns_queue_drift`
// alert gates on (KV count.threats.dns_drainable, lib/dns-drainable.ts),
// that `lib/dns-queue-reconciler.ts` enqueues from, and that
// `lib/dns-queue-reaper.ts` reaps against. This — NOT the cooldown-filtered
// dns_queue "drainable right now" count — is the correct parity partner for
// dns_queue's row count: |queue_size - candidatesInThreats| ≈ 0 shortly
// after the daily recount in the healthy steady state (matches the
// reaper's observed scanned≈candidates parity); the count is a daily
// value, so the block also reports its age. Cooldown-independent: a domain mid-retry-cooldown is still a
// candidate that needs resolving, so it counts here.
//
// (The cooldown-filtered "how many can I try THIS tick" count is a
// different, still-useful metric — it stays under its honest name
// `enrichment_pipeline.domain_geo_drainable`.)
//
// The count is defined once in lib/dns-drainable.ts; Navigator recomputes
// it daily into the shared cache key that Flight Control peeks and this
// handler reads. The reconciler/
// reaper still wrap the same core conditions in load-bearing, non-identical
// SQL (distinct `INDEXED BY` hints, a cursor `created_at >= ?` predicate, an
// `IN (...)` existence check) — keep them in sync if the predicate changes.
// Implementation lives in lib/dns-drainable.ts (shared with Flight Control);
// re-exported here for existing importers.
export { countDnsCandidatesInThreats };

/** Build the `dns_queue_parity` diagnostics block. `drainable_in_threats`
 *  is the threats-side candidate count (cooldown-independent), computed
 *  ONCE A DAY (Navigator, UTC hour 3 — lib/dns-drainable.ts) and therefore
 *  up to ~24h old; `drainable_computed_at` / `drainable_age_hours` say how
 *  old (null when unknown). `delta` is the live queue_size minus that
 *  count: ≈ 0 shortly after the daily recount in steady state, but it also
 *  absorbs queue movement since the recount, so read it together with the
 *  age — a sizable delta on an old count is not by itself drift (FC's
 *  drift alert only acts on a count < 90 min old). `delta` is null when
 *  DNS_QUEUE_DB is unbound (nothing to compare). */
export function buildDnsQueueParity(opts: {
  bound: boolean;
  queueSize: number;
  candidatesInThreats: number;
  /** Epoch ms the candidate count was computed, or null/absent if unknown. */
  candidatesComputedAtMs?: number | null;
  nowMs?: number;
}): {
  bound: boolean;
  queue_size: number;
  drainable_in_threats: number;
  drainable_computed_at: string | null;
  drainable_age_hours: number | null;
  delta: number | null;
} {
  const t = opts.candidatesComputedAtMs ?? null;
  const nowMs = opts.nowMs ?? Date.now();
  return {
    bound: opts.bound,
    queue_size: opts.queueSize,
    drainable_in_threats: opts.candidatesInThreats,
    drainable_computed_at: t === null ? null : new Date(t).toISOString(),
    drainable_age_hours: t === null ? null : Math.round(((nowMs - t) / 3_600_000) * 10) / 10,
    delta: opts.bound ? opts.queueSize - opts.candidatesInThreats : null,
  };
}

/** Clamp the `?hours=` query param to [1, 168]. Extracted from
 *  handlePlatformDiagnostics for direct unit testing — pure, no I/O.
 *  Cap raised to 168h (7d) so 24/48/168h trending works. Floored at 1h and
 *  guarded against NaN/negatives from a bad param so the window can never be
 *  0 or negative. On-demand admin/internal endpoint — no windowed query here
 *  full-scans threats, so 168h is safe. */
export function clampHoursBack(raw: string | null): number {
  const hoursParsed = parseInt(raw ?? "6");
  return Math.min(Math.max(1, Number.isFinite(hoursParsed) ? hoursParsed : 6), 168);
}

// ── Cloaking blind-spot rate (Wave 3, rec 4) ────────────────────────
// Crawler blind-spot metric over the ANALYZED lookalike population.
// lib/page-fetch.ts is a plain HTTP fetcher (no JS, no headless
// browser), so a hostile lookalike behind a Turnstile / reCAPTCHA /
// hCaptcha / managed-challenge wall blinds the deterministic scorer —
// the credential-harvest payload sits behind the wall. On the already-
// gated lookalike set, the PRESENCE of a wall is itself evasion
// evidence. This surfaces walls_observed / fetched_ok (the blind-spot
// rate) plus a per-family breakdown, reading the authoritative
// `page_anti_bot_wall` column (migration 0260) — no JSON parsing.
interface PageAnalysisDiag {
  /** Rows that have been page-analyzed (page_fetched_at IS NOT NULL),
   *  capped at PAGE_DIAG_ROW_LIMIT — see `truncated`. */
  fetched_ok: number;
  /** Analyzed rows on which an anti-bot wall was observed. */
  walls_observed: number;
  /** walls_observed / fetched_ok as a percentage, or null when none analyzed. */
  wall_rate_pct: number | null;
  /** Per-wall-family counts over the analyzed population (NULL excluded). */
  by_family: Array<{ family: string; n: number }>;
  /**
   * True when the analyzed population exceeded PAGE_DIAG_ROW_LIMIT and
   * this block therefore describes only the first N rows. Every number
   * above and below is then a LOWER BOUND. Explicit so the block
   * degrades VISIBLY rather than silently under-reporting.
   */
  truncated: boolean;
  /**
   * Outcome breakdown of the analyzed population (Lane 3 §6). The
   * existing `fetched_ok` above is a MISNOMER retained for contract
   * stability — it counts every row the pass has touched, successes and
   * failures alike, which is exactly the gap this field closes.
   *
   * AUTHORITATIVE since migration 0266 (spec §11.3/§11.4). The label is
   * read from `page_last_outcome`, which the page-analysis pass writes on
   * BOTH branches — `'scored'` on success, a normalized reject reason on
   * failure — so it describes the LAST pass, not the last successful one.
   * The vocabulary is `PAGE_OUTCOMES` in `lib/page-fetch.ts`; it is
   * bounded on purpose, because three upstream reason strings interpolate
   * (one of them an IP) and would otherwise give this `GROUP BY`
   * unbounded cardinality.
   *
   * This replaced an inference from `page_ai_signals IS NOT NULL`, which
   * answered "was this row EVER scored" while being read as "what did the
   * last pass do" — so a row that scored once and had 403'd for a month
   * still contributed its stale signal set to the §5.2 lift rates. It
   * also folded `oversize_declared` in with `non_html_content_type`,
   * hiding the possible bias against fat AI-builder pages that §11.4
   * calls out as a bigger recall lever than any individual signal.
   *
   * Rows not yet re-analyzed since 0266 have no `page_last_outcome` and
   * fall back to that old inference, in `*_pre_0266` buckets so they are
   * never mistaken for measured values. See
   * `ai_build.unverified_denominator_rows` for how much of the `ai_build`
   * denominator that still accounts for. Both decay on the 24 h cadence.
   */
  by_fetch_outcome: Array<{ outcome: string; n: number }>;
  /**
   * Lane 3 Class A/B/C shadow-signal telemetry. STRUCTURALLY SEPARATE
   * from `exfil` below — different classes, different authority.
   * Collapsing them here is the first step toward collapsing them in
   * the scorer (spec §6).
   */
  ai_build: {
    /** Rows with a shadow verdict (page_ai_signals IS NOT NULL) — the denominator. */
    scored: number;
    /** Rows on which at least one shadow signal fired. */
    any_fired: number;
    /**
     * Per-signal firing counts + rate over `scored`.
     * ALARMS: 0.0% for 30 days → the extractor is broken or the signal
     * is dead (both Class A signals are expected to decay — retirement
     * is the planned end state, spec §5.6). >15% of `scored` → it is a
     * builder-popularity detector, not a phishing signal; demote it to
     * metadata. No rate is actionable below n = 30 (spec §4.6).
     */
    by_signal: Array<{ signal: string; n: number; rate_pct: number | null }>;
    /**
     * How much of `scored` above is taken on trust. Rows last analyzed
     * before migration 0266 have no `page_last_outcome`, so whether
     * their LAST pass reached the scorer is inferred from
     * `page_ai_signals` being non-NULL — the §11.3 defect. They are
     * still counted (excluding them would empty the §5.2 denominator
     * for the ~week the 24 h cadence takes to re-analyze everything),
     * but this is the size of the un-verified remainder.
     *
     * Read it before running the §5.2 promotion gate: a lift ratio
     * computed while this is a large fraction of `scored` is measured
     * over a population that may mix live verdicts with stale ones. It
     * should decay to 0; a value that does not decay means rows are not
     * being re-analyzed, which is a cadence problem, not a data one.
     */
    unverified_denominator_rows: number;
    /** Rows where the Class A cap actually bound (uncapped sum > 20). */
    class_a_cap_hits: number;
    /**
     * THE ONE THAT MATTERS. Rows whose threat band WOULD rise because
     * of Class A specifically — i.e. band(score + full delta) is above
     * band(score + Class B/C only). Near-zero over a full cycle means
     * Class A is decorative and should become metadata-only.
     */
    escalations_attributable: number;
    /** Rows whose band would rise from the full delta, Class A or not. */
    escalations_any: number;
    /**
     * Rows whose PERSISTED `page_score_delta` disagrees with the delta
     * recomputed here from `page_ai_signals`. Non-zero means the weight
     * table (SHADOW_SIGNAL_WEIGHTS / SHADOW_CLASS_A_CAP) changed after
     * those rows were written, so their persisted delta — and any
     * measurement taken from it — is stale. Self-heals on the 24 h
     * per-domain re-analysis cadence; a value that does NOT decay is a
     * writer bug. Rows written before migration 0264 are excluded
     * (page_score_delta IS NULL).
     */
    persisted_delta_drift: number;
  };
  /**
   * Lane 3 Class B sink telemetry. Actor intelligence, not health.
   */
  exfil: {
    /** Rows where covert_exfil_sink or form_relay_sink fired. */
    firings: number;
    /** Campaign mix by matched sink host. */
    by_sink_host: Array<{ host: string; n: number }>;
    /** Distinct bot/webhook ids seen. */
    distinct_sink_ids: number;
    /** Rows carrying an extractable sink id (denominator for the ratio). */
    sink_id_firings: number;
    /**
     * distinct_sink_ids / sink_id_firings. FAR BELOW 1.0 means one
     * operator is running many kits — the clustering finding this lane
     * exists to produce.
     */
    sink_ids_per_firing: number | null;
  };
  /**
   * M1 builder mix. WEIGHT ZERO by doctrine. This block also serves to
   * permanently falsify any future proposal to score the generator tag
   * (spec §8 item 5).
   */
  generator: {
    /** Scored rows that declared a <meta name="generator">. */
    tagged: number;
    by_token: Array<{ token: string; n: number }>;
  };
}

/**
 * Threat band a page lands in, mirroring ALL FOUR branches of
 * `escalateThreatLevelForPage` (lib/page-phishing-scorer.ts) as
 * LOW 0 / MEDIUM 1 / HIGH 2 / CRITICAL 3. Used ONLY to answer the
 * counterfactual "would this have escalated?" in diagnostics — it
 * escalates nothing and writes nothing.
 *
 * Exported for the test that pins it against the real escalation
 * function; the two must not drift, because `escalations_attributable`
 * is the gate spec §6 uses to decide whether Class A is promoted or
 * demoted to metadata-only.
 */
export function pageScoreBand(
  score: number,
  credentialHarvest: boolean,
  antiBotWall: boolean,
): number {
  // ALL FOUR branches of escalateThreatLevelForPage, in its order. The
  // earlier two-branch model (>= 60, >= 30) was wrong in the direction
  // that matters most: it omitted the credentialHarvest → CRITICAL
  // branch and the bare-anti-bot-wall → MEDIUM floor, so a page already
  // sitting at MEDIUM because of a wall was counted as a Class A
  // escalation Class A did not cause. Anti-bot walls are the single most
  // common finding on this population, and spec §6 names
  // `escalations_attributable` as the gate that decides whether Class A
  // is promoted or demoted to metadata-only — passing that gate on
  // phantom escalations is the worst available failure.
  if (credentialHarvest) return 3; // CRITICAL
  if (score >= 60) return 2; // HIGH
  if (score >= 30) return 1; // MEDIUM
  if (antiBotWall) return 1; // MEDIUM — bare-wall floor
  return 0; // LOW
}

/**
 * Row cap for the single page-analysis pass. lookalike_domains is a
 * small bounded table, so this is a guard rail, not a working limit —
 * but an unbounded SELECT whose every distinct sink host becomes a
 * Worker-side Map key is exactly the shape that fails silently as the
 * table grows. One row over the cap sets `truncated`.
 */
const PAGE_DIAG_ROW_LIMIT = 20_000;

/** Build the `page_analysis` diagnostics block. cachedValue-wrapped so
 *  repeated diagnostics calls don't re-scan; the full scan is acceptable
 *  ONLY because lookalike_domains is a small bounded table (unlike
 *  threats). Key `diag.page_analysis.cloaking.v3` — the version suffix is
 *  load-bearing: without a new key a deploy keeps serving the OLD shape
 *  from KV for a whole TTL (spec §6 requires the bump on every
 *  shape change). `.v2` added ai_build / exfil / generator / truncated;
 *  `.v3` reads the authoritative `page_last_outcome` (migration 0266)
 *  instead of inferring the last outcome, which changes both the
 *  `by_fetch_outcome[]` label set and the `ai_build` denominator, and
 *  adds `ai_build.unverified_denominator_rows`. Bump again on the next
 *  shape change. TTL 600s. */
async function buildPageAnalysisDiag(env: Env): Promise<PageAnalysisDiag> {
  return cachedValue<PageAnalysisDiag>(env, 'diag.page_analysis.cloaking.v3', 600, async () => {
    // ONE pass over the analyzed population, aggregated in the Worker
    // (Lane 3 §6). This was three separate full scans of the SAME table
    // under the SAME predicate (a SUM(CASE…), a GROUP BY
    // page_anti_bot_wall, and this row SELECT); folding them into one
    // pass costs two fewer scans and is what makes `page_anti_bot_wall`
    // available per-row for the escalation counterfactual below.
    //
    // Deliberately NOT eight `LIKE '%"key"%'` scans over the
    // page_ai_signals TEXT column — that is the dead-index full-scan
    // failure class, multiplied by eight. Bounded by the
    // page_fetched_at IS NOT NULL predicate AND by an explicit row cap;
    // runs at most once per 600 s TTL.
    const scan = await env.DB.prepare(`
      SELECT page_ai_signals, page_score_delta, page_phishing_score,
             page_signals, page_anti_bot_wall,
             page_generator, page_exfil_sink, page_exfil_sink_id,
             page_http_status, page_last_outcome
      FROM lookalike_domains
      WHERE page_fetched_at IS NOT NULL
      LIMIT ?
    `).bind(PAGE_DIAG_ROW_LIMIT + 1).all<{
      page_ai_signals: string | null;
      page_score_delta: number | null;
      page_phishing_score: number | null;
      page_signals: string | null;
      page_anti_bot_wall: string | null;
      page_generator: string | null;
      page_exfil_sink: string | null;
      page_exfil_sink_id: string | null;
      page_http_status: number | null;
      page_last_outcome: string | null;
    }>();

    // One row over the cap is the sentinel; drop it and flag the block.
    const truncated = scan.results.length > PAGE_DIAG_ROW_LIMIT;
    const rows = truncated ? scan.results.slice(0, PAGE_DIAG_ROW_LIMIT) : scan.results;

    // ── Worker-side aggregation of the single pass ──────────────────
    const byFamily = new Map<string, number>();
    const outcomes = new Map<string, number>();
    const bySignal = new Map<string, number>();
    const byGenerator = new Map<string, number>();
    const bySinkHost = new Map<string, number>();
    const sinkIds = new Set<string>();
    let scored = 0;
    // Rows counted into the `ai_build` denominator on the pre-0266
    // inference rather than an authoritative `page_last_outcome`. Decays
    // to 0 as the 24 h cadence re-analyzes each row; a value that does
    // NOT decay means rows are no longer being re-analyzed at all.
    let unverifiedDenominatorRows = 0;
    let anyFired = 0;
    let capHits = 0;
    let escalationsAny = 0;
    let escalationsAttributable = 0;
    let deltaDrift = 0;
    let exfilFirings = 0;
    let sinkIdFirings = 0;
    let generatorTagged = 0;
    let wallsObserved = 0;

    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

    /** Did BOTH credential-harvest legs fire on the LIVE signal set? */
    const parseJsonKeys = (raw: string | null): string[] => {
      if (raw === null) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
      } catch {
        return [];
      }
    };

    for (const row of rows) {
      // Wall family, folded in from what used to be two extra scans.
      if (row.page_anti_bot_wall !== null) {
        wallsObserved += 1;
        bump(byFamily, row.page_anti_bot_wall);
      }

      // Per-pass outcome, authoritative since migration 0266: written on
      // BOTH branches of the page-analysis UPDATE, so it describes the
      // LAST pass rather than the last successful one (spec §11.3), and
      // carries a normalized reject reason that keeps `oversize_declared`
      // separate from `non_html_content_type` (§11.4).
      //
      // NULL means the row has not been re-analyzed since 0266. Those
      // fall back to the old inference — which is exactly the defect
      // 0266 fixes, so they are counted into a clearly-labelled
      // `*_pre_0266` bucket rather than the real ones, and their number
      // is reported as `ai_build.unverified_denominator_rows` below.
      // They self-heal on the 24 h per-domain cadence.
      const authoritative = row.page_last_outcome;
      let lastPassScored: boolean;
      if (authoritative !== null) {
        bump(outcomes, authoritative);
        lastPassScored = authoritative === 'scored';
      } else if (row.page_ai_signals === null) {
        const status = row.page_http_status;
        if (status !== null && status >= 400) bump(outcomes, 'not_scored_http_error_pre_0266');
        else if (status === null) bump(outcomes, 'not_scored_no_status_pre_0266');
        else bump(outcomes, 'not_scored_other_pre_0266');
        lastPassScored = false;
      } else {
        bump(outcomes, 'scored_pre_0266');
        unverifiedDenominatorRows += 1;
        lastPassScored = true;
      }

      // `ai_build` aggregates only over rows whose LAST pass reached the
      // scorer. Pre-0266 rows are included on the inference above so the
      // §5.2 denominator is not emptied for the ~week it takes them to
      // self-heal; `unverified_denominator_rows` is how much of it is
      // still taken on trust.
      if (!lastPassScored) continue;
      scored += 1;

      // Unparseable JSON counts as "scored, nothing fired" rather than
      // poisoning the whole block.
      const keys = parseJsonKeys(row.page_ai_signals);

      if (keys.length > 0) anyFired += 1;
      for (const k of keys) bump(bySignal, k);

      const delta = shadowScoreDelta(keys);
      if (delta.capHit) capHits += 1;

      // Shadow-mode drift detector: the delta persisted at analysis time
      // vs the delta this weight table produces now. Divergence = the
      // weight table moved under the stored rows.
      if (row.page_score_delta !== null && row.page_score_delta !== delta.delta) {
        deltaDrift += 1;
      }

      // Counterfactual banding. Nothing is written; this only answers
      // "would the shadow delta have moved the band, and was Class A
      // what moved it?". The two NON-score inputs to
      // escalateThreatLevelForPage are held CONSTANT across all three
      // bands (the shadow delta cannot create a credential-harvest page
      // or an anti-bot wall) — which is precisely what stops a page
      // already floored to MEDIUM by a bare wall, or already CRITICAL
      // from credential harvest, being miscounted as a Class A
      // escalation.
      const liveSignals = parseJsonKeys(row.page_signals);
      const credentialHarvest =
        liveSignals.includes('credential_form') && liveSignals.includes('offdomain_form_exfil');
      const wall = row.page_anti_bot_wall !== null;

      const base = row.page_phishing_score ?? 0;
      const bandBase = pageScoreBand(base, credentialHarvest, wall);
      const withAll = pageScoreBand(base + delta.delta, credentialHarvest, wall);
      const withoutClassA = pageScoreBand(base + delta.classBCSum, credentialHarvest, wall);
      if (withAll > bandBase) escalationsAny += 1;
      if (withAll > withoutClassA) escalationsAttributable += 1;

      if (row.page_generator) { generatorTagged += 1; bump(byGenerator, row.page_generator); }
      if (row.page_exfil_sink) {
        exfilFirings += 1;
        bump(bySinkHost, row.page_exfil_sink);
        if (row.page_exfil_sink_id) { sinkIdFirings += 1; sinkIds.add(row.page_exfil_sink_id); }
      }
    }

    const pct = (n: number, d: number): number | null =>
      d > 0 ? Math.round((n / d) * 1000) / 10 : null;
    const topN = <K extends string>(m: Map<string, number>, key: K, limit = 20) =>
      Array.from(m.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([k, n]) => ({ [key]: k, n }) as Record<K, string> & { n: number });

    const fetchedOk = rows.length;

    return {
      fetched_ok: fetchedOk,
      walls_observed: wallsObserved,
      wall_rate_pct: fetchedOk > 0 ? Math.round((wallsObserved / fetchedOk) * 1000) / 10 : null,
      // Was a dedicated `GROUP BY page_anti_bot_wall` scan; now folded
      // into the single pass. Same shape, same ORDER BY n DESC. Not
      // top-N-capped: the family set is a closed 5-value enum.
      by_family: Array.from(byFamily.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([family, n]) => ({ family, n })),
      truncated,
      by_fetch_outcome: Array.from(outcomes.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([outcome, n]) => ({ outcome, n })),
      ai_build: {
        scored,
        any_fired: anyFired,
        // Every signal is listed even at n = 0: a signal that silently
        // disappears from the list is indistinguishable from one that
        // never fired, and "0.0% for 30 days" is itself the alarm.
        by_signal: Object.keys(SHADOW_SIGNAL_WEIGHTS).map((signal) => {
          const n = bySignal.get(signal) ?? 0;
          return { signal, n, rate_pct: pct(n, scored) };
        }).sort((a, b) => b.n - a.n),
        unverified_denominator_rows: unverifiedDenominatorRows,
        class_a_cap_hits: capHits,
        escalations_attributable: escalationsAttributable,
        escalations_any: escalationsAny,
        persisted_delta_drift: deltaDrift,
      },
      exfil: {
        firings: exfilFirings,
        by_sink_host: topN(bySinkHost, 'host'),
        distinct_sink_ids: sinkIds.size,
        sink_id_firings: sinkIdFirings,
        sink_ids_per_firing: sinkIdFirings > 0
          ? Math.round((sinkIds.size / sinkIdFirings) * 1000) / 1000
          : null,
      },
      generator: {
        tagged: generatorTagged,
        by_token: topN(byGenerator, 'token'),
      },
    };
  }, { singleFlight: DIAG_SINGLE_FLIGHT });
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** Overload retries per diagnostics request (shared by every section). */
export const DIAG_OVERLOAD_RETRIES = 2;
/** Wait before an overload retry: past D1's rolling 10 s window. */
export const DIAG_OVERLOAD_RETRY_DELAY_MS = 10_500;

/**
 * Per-request wrapper: runs `fn`; when it is rejected with D1's overload
 * error and the request still has retries left, waits `delayMs` and runs it
 * once more. Other errors (and an exhausted budget) rethrow unchanged.
 */
export function diagOverloadRetrier(
  retries: number = DIAG_OVERLOAD_RETRIES,
  delayMs: number = DIAG_OVERLOAD_RETRY_DELAY_MS,
  wait: (ms: number) => Promise<void> = sleep,
): <T>(fn: () => Promise<T>) => Promise<T> {
  let left = retries;
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (left <= 0 || !isD1OverloadError(msg)) throw err;
      left -= 1;
      await wait(delayMs);
      return fn();
    }
  };
}

/** Build the `velocity` diagnostics block from KV ONLY — zero D1 reads.
 *  The distribution is a GROUP BY over every threats row (~3.3M rows read
 *  as one statement in prod); run inside this request it spent D1's 10 s
 *  window by itself, so the sections read after it (dmarc_ingest,
 *  recent_platform_alerts) failed "D1 DB is overloaded". Navigator now
 *  computes it twice a day in bounded rowid chunks (lib/velocity-diag.ts,
 *  UTC hours VELOCITY_DIAG_HOURS_UTC) and this block reads the stored
 *  result: it can lag by up to ~12h (26h if a recompute was skipped). No
 *  stored result → `velocity: null` + `velocity_error`. */
async function buildVelocityDiag(env: Env): Promise<VelocityDiag> {
  const entry = await readVelocityDiag(env);
  if (!entry) throw new Error(VELOCITY_DIAG_PENDING_ERROR);
  return entry.value;
}

// ── nrd_domains retention (lib/nrd-retention.ts) ────────────────────
export interface NrdRetentionDiag {
  /** False when no last-result stamp exists (never run, or TTL expired). */
  has_run: boolean;
  last_run_at: string | null;
  deleted: number | null;
  cutoff: string | null;
  age_cutoff: string | null;
  cursor: string | null;
  held_by_matcher: boolean | null;
  /** True when the phantom cursor was missing or older than the 30-day age
   *  cutoff, so the rows being purged were never scanned by the manual
   *  phantom matcher (lib/nrd-retention.ts). */
  phantom_hold_clamped: boolean | null;
  /** created_at of the NRD <-> lookalike matcher's cursor (lib/lookalike-nrd-matcher.ts). */
  lookalike_cursor: string | null;
  /** True when that cursor, not the age window or the phantom cursor, set the
   *  cutoff — only when an unscanned row exists above it (a caught-up cursor
   *  parked on an old row of the now-sparse table does not count). */
  held_by_lookalike_matcher: boolean | null;
  more_remaining: boolean | null;
  skipped: string | null;
  error: string | null;
}

/** Build the `nrd_retention` block from the KV last-result stamp ONLY —
 *  zero D1 reads. Retention is tiered: 30 days hot, `brand_matched = 1`
 *  rows never purged, every row inserted since 2026-10-05 also archived
 *  to R2 by the feed. The phantom matcher's nrd cursor is clamped AT the
 *  30-day age cutoff, so it never extends retention:
 *  `phantom_hold_clamped: true` = the manual matcher has not run
 *  incrementally within 30 days (or ever) and the purged rows were never
 *  scanned by it. `held_by_matcher` is therefore always false on new
 *  stamps (kept for shape); `held_by_lookalike_matcher: true` = a stuck
 *  lookalike matcher (unscanned rows above its cursor) extended retention
 *  (to ≤ 37 days) — a caught-up cursor on the sparse table never sets it. A legacy
 *  `skipped: 'no_cursor'` can only come from a pre-tiering stamp. */
export async function buildNrdRetentionDiag(env: Env): Promise<NrdRetentionDiag> {
  let raw: string | null = null;
  try {
    raw = await env.CACHE.get(NRD_RETENTION_LAST_RESULT_KEY);
  } catch {
    raw = null;
  }
  const last = parseNrdRetentionLastResult(raw);
  return {
    has_run: last !== null,
    last_run_at: last?.ran_at ?? null,
    deleted: last?.deleted ?? null,
    cutoff: last?.cutoff ?? null,
    age_cutoff: last?.age_cutoff ?? null,
    cursor: last?.cursor ?? null,
    held_by_matcher: last?.held_by_matcher ?? null,
    phantom_hold_clamped: last?.phantom_hold_clamped ?? null,
    lookalike_cursor: last?.lookalike_cursor ?? null,
    held_by_lookalike_matcher: last?.held_by_lookalike_matcher ?? null,
    more_remaining: last?.more_remaining ?? null,
    skipped: last?.skipped ?? null,
    error: last?.error ?? null,
  };
}

/** `dmarc_ingest` block — hosted DMARC aggregate reporting (2026-11-14).
 *  Three small indexed main-DB reads (dmarc_reports by received_at,
 *  idx_dmarc_reports_received; the dmarc_enrollment table, one row per
 *  enrolled brand; the rollup-pending partial index) plus the 24 hourly KV
 *  drop buckets the receiver writes (lib/dmarc-enrollment.ts
 *  recordDmarcDrop). Every drop reason is reported, including `error`, so
 *  a receiver that fails every message does not read as a quiet day. */
export interface DmarcIngestDiag {
  reports_24h: number;
  verified_reports_24h: number;
  incomplete_reports_24h: number;
  last_report_at: string | null;
  enrolled_brands: number;
  rollup_pending: number;
  dropped_unenrolled_24h: number;
  dropped_no_brand_24h: number;
  dropped_24h: DmarcDropCounts;
}

export async function buildDmarcIngestDiag(env: Env): Promise<DmarcIngestDiag> {
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS v,
            SUM(CASE WHEN processed <> 1 THEN 1 ELSE 0 END) AS incomplete, MAX(received_at) AS last
     FROM dmarc_reports WHERE received_at >= datetime('now', '-24 hours')`,
  ).first<{ n: number; v: number | null; incomplete: number | null; last: string | null }>();
  const enrolled = await env.DB.prepare(
    "SELECT COUNT(*) AS n, MAX(last_report_at) AS last FROM dmarc_enrollment",
  ).first<{ n: number; last: string | null }>();
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM dmarc_reports WHERE rolled_up_at IS NULL AND processed IN (0, 1)",
  ).first<{ n: number }>();
  const drops = await readDmarcDrops24h(env);
  const lasts = [recent?.last ?? null, enrolled?.last ?? null].filter((x): x is string => !!x).sort();
  return {
    reports_24h: recent?.n ?? 0,
    verified_reports_24h: recent?.v ?? 0,
    incomplete_reports_24h: recent?.incomplete ?? 0,
    last_report_at: lasts.length > 0 ? lasts[lasts.length - 1]! : null,
    enrolled_brands: enrolled?.n ?? 0,
    rollup_pending: pending?.n ?? 0,
    dropped_unenrolled_24h: drops.unenrolled,
    dropped_no_brand_24h: drops.no_brand,
    dropped_24h: drops,
  };
}

export { foldVelocityDistribution } from "../lib/velocity-diag";

/** Workflow-agent run counters, derived from the `agent_activity_log`
 *  event rollup. Extracted so the disjointness rules are unit-testable —
 *  test/geo-exhaustion-and-diag-folds.test.ts.
 *
 *  The rules, from lib/workflow-dispatch.ts:
 *    `workflow_dispatched`, `workflow_dispatch_failed` and
 *    `workflow_cooldown_skip` are MUTUALLY EXCLUSIVE outcomes of one
 *    dispatch attempt (:144 on success, :165 in the catch, and the
 *    cooldown short-circuit before either). Summing them = attempts.
 *    `workflow_failed` is emitted by the workflow BODY, so it only ever
 *    occurs on a run that already emitted `workflow_dispatched`. */
export function deriveWorkflowRunTotals(wf: {
  dispatched: number;
  completed: number;
  dispatch_failed: number;
  cooldown_skipped: number;
  run_failed: number;
}): { total_runs: number; failed: number; running: number } {
  return {
    // Three disjoint dispatch outcomes. `run_failed` is deliberately
    // absent — those runs are already counted inside `dispatched`.
    total_runs: wf.dispatched + wf.dispatch_failed + wf.cooldown_skipped,
    failed: wf.dispatch_failed + wf.run_failed,
    // Residual of the DISPATCHED cohort only, so it may subtract only
    // terms that are inside `dispatched`. `dispatch_failed` never
    // entered it — subtracting it was double-counting and under-reported
    // in-flight runs. `run_failed` DID (body started, then threw).
    running: Math.max(0, wf.dispatched - wf.completed - wf.run_failed),
  };
}

/** One circuit-broken (or manually paused) agent in `agent_mesh.paused[]`. */
export interface PausedAgentDiag {
  agent_id: string;
  paused_reason: string | null;
  paused_at: string | null;
  paused_after_n_failures: number | null;
  consecutive_failures: number;
  /** Hours since `paused_at`; null when `paused_at` is missing/unparseable. */
  hours_paused: number | null;
  /** Newest non-null `agent_runs.error_message` among the agent's last
   *  PAUSED_AGENT_RECENT_RUNS runs (truncated to 500 chars); null if none. */
  last_error: string | null;
  last_error_at: string | null;
}

/** Cap on paused agents reported (agent_configs is ~50 rows total). */
export const PAUSED_AGENT_LIMIT = 50;
/** Runs inspected per paused agent when looking for `last_error`. */
export const PAUSED_AGENT_RECENT_RUNS = 20;

/** D1 `datetime('now')` text (`YYYY-MM-DD HH:MM:SS`, UTC, no zone) → ms. */
function sqliteUtcMs(ts: string): number {
  const s = ts.trim();
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

/**
 * `agent_mesh.paused[]` — every `agent_configs` row with `enabled = 0`.
 *
 * `agent_mesh.per_agent` is a GROUP BY over `agent_runs` in the window, so
 * an agent whose circuit breaker tripped (executeAgent skips it, so it
 * writes no rows) simply vanished from diagnostics — strategist, sparrow
 * and attributor sat paused for weeks with no hint. This block reads the
 * breaker state directly.
 *
 * Cost: one read of agent_configs (tiny table), then ONE `db.batch` of
 * per-agent point lookups that seek the agent_runs (agent_id, started_at
 * DESC) index with `LIMIT PAUSED_AGENT_RECENT_RUNS` — the
 * error filter runs in JS so a manually-paused agent with a long clean
 * history can't turn the lookup into a walk of its whole run history.
 */
export async function fetchPausedAgents(
  db: D1Database,
  nowMs: number = Date.now(),
  env?: Env,
): Promise<PausedAgentDiag[]> {
  // Track B1c: with env, agent_configs is read from the routed store and
  // the run lookups run on each part of the telemetry ∪ core union.
  const configDb = env ? await telemetryStore(env) : db;
  const configs = await configDb.prepare(`
    SELECT agent_id, paused_reason, paused_at, paused_after_n_failures,
           consecutive_failures
      FROM agent_configs
     WHERE enabled = 0
     ORDER BY paused_at ASC, agent_id ASC
     LIMIT ?
  `).bind(PAUSED_AGENT_LIMIT).all<{
    agent_id: string;
    paused_reason: string | null;
    paused_at: string | null;
    paused_after_n_failures: number | null;
    consecutive_failures: number | null;
  }>();
  const rows = configs.results ?? [];
  if (rows.length === 0) return [];

  type RecentRun = { id: string; error_message: string | null; started_at: string };
  const parts = await historyParts(env, 'agent_runs', { core: db });
  const perPart = await Promise.all(parts.map((part) => {
    const partDb = part.writeDb ?? db;
    const stmt = partDb.prepare(`
    SELECT id, error_message, started_at
      FROM agent_runs
     WHERE agent_id = ?
     ORDER BY started_at DESC
     LIMIT ?
  `);
    return partDb.batch<RecentRun>(
      rows.map((r) => stmt.bind(r.agent_id, PAUSED_AGENT_RECENT_RUNS)),
    );
  }));
  // One part: that batch verbatim. Union: per agent, the newest
  // PAUSED_AGENT_RECENT_RUNS across parts (duplicates are identical rows).
  const runBatches: Array<{ results: RecentRun[] }> = perPart.length === 1
    ? (perPart[0] ?? [])
    : rows.map((_, i) => {
        const seen = new Set<string>();
        const merged = perPart.flatMap((b) => b[i]?.results ?? [])
          .filter((run) => {
            const k = run.id;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))
          .slice(0, PAUSED_AGENT_RECENT_RUNS);
        return { results: merged };
      });

  return rows.map((r, i) => {
    const runs = runBatches[i]?.results ?? [];
    const errRun = runs.find((run) => run.error_message != null && run.error_message !== '');
    const pausedMs = r.paused_at ? sqliteUtcMs(r.paused_at) : NaN;
    return {
      agent_id: r.agent_id,
      paused_reason: r.paused_reason,
      paused_at: r.paused_at,
      paused_after_n_failures: r.paused_after_n_failures,
      consecutive_failures: r.consecutive_failures ?? 0,
      hours_paused: Number.isFinite(pausedMs)
        ? Math.round(((nowMs - pausedMs) / 3_600_000) * 10) / 10
        : null,
      last_error: errRun?.error_message ? errRun.error_message.slice(0, 500) : null,
      last_error_at: errRun?.started_at ?? null,
    };
  });
}

/**
 * fetchPausedAgents for the diagnostics handler: a failure (missing
 * column, D1 blip) degrades to `paused: []` + `paused_error` instead of
 * rejecting the whole endpoint with a 500.
 */
export async function fetchPausedAgentsSafe(
  db: D1Database,
  nowMs: number = Date.now(),
  env?: Env,
): Promise<{ paused: PausedAgentDiag[]; paused_error: string | null }> {
  try {
    return { paused: await fetchPausedAgents(db, nowMs, env), paused_error: null };
  } catch (err) {
    return { paused: [], paused_error: err instanceof Error ? err.message : String(err) };
  }
}

/** GET /api/admin/platform-diagnostics  (JWT admin auth)
 *  GET /api/internal/platform-diagnostics (AVERROW_INTERNAL_SECRET auth) */
export async function handlePlatformDiagnostics(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const hoursBack = clampHoursBack(url.searchParams.get("hours"));

  try {
    // Overload safety (prod 2026-11-08: 5/5 calls tripped `D1 DB is
    // overloaded` and briefly took every other request on the main DB down
    // with them). Three rules hold for everything below:
    //   1. Main-DB reads are THUNKS run one after another (runSequential),
    //      never one big Promise.all — D1 serialises a database's queries
    //      anyway, so a fan only queues ~40 reads inside one 10s window.
    //      Off-main work (CF GraphQL, KV, DNS_QUEUE_DB) runs alongside.
    //   2. Full-table scans sit behind cachedValue / cachedCount with
    //      single-flight refill; windowed reads are sargable range seeks.
    //   3. Every read is wrapped in softSection: a failing read degrades
    //      its section to an empty/zero fallback and reports
    //      `<section>_error` at the top of `data`, instead of 500-ing.
    //   4. A read rejected by D1's 10-second overload window (spent by
    //      other work on core, or by an earlier read here) is retried once
    //      after the window rolls over (DIAG_OVERLOAD_RETRY_DELAY_MS), at
    //      most DIAG_OVERLOAD_RETRIES times per request — a cheap indexed
    //      read (dmarc_ingest, recent_platform_alerts) then fills instead
    //      of reporting `<section>_error`. Any other error fails at once.
    const sectionErrors: SectionErrors = {};
    const overloadRetry = diagOverloadRetrier();
    const soft = <T>(section: string, fallback: T | ((message: string) => T), fn: () => Promise<T>) =>
      softSection(sectionErrors, section, fallback, () => overloadRetry(fn));
    const rows = <T>(r: { results?: T[] } | null | undefined): { results: T[] } => ({ results: r?.results ?? [] });
    const noRows = <T>(): { results: T[] } => ({ results: [] });

    // ─── 1. Database clock ──────────────────────────────────────────
    const clockT = soft<{ utc_now: string } | null>("db_clock", null, () => env.DB.prepare(
      "SELECT datetime('now') AS utc_now"
    ).first<{ utc_now: string }>());

    // ─── 2. Enrichment pipeline ─────────────────────────────────────
    // One pass over the WHOLE threats table (~1.5M rows, every column it
    // needs is outside any index) — the single heaviest read here and, run
    // uncached on every call, the bulk of the 2026-11-08 overload. Cached
    // 10 min with single-flight refill (stale-while-revalidate), so at most
    // one scan per TTL however many callers hit the endpoint.
    // enriched_last_hour can therefore lag by up to ~10 min.
    const enrichmentT = soft("enrichment_pipeline", null, () => cachedValue(
      env, DIAG_ENRICHMENT_CACHE_KEY, DIAG_ENRICHMENT_TTL_S,
      () => env.DB.prepare(`
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
    }>(),
      { singleFlight: DIAG_SINGLE_FLIGHT },
    ));

    // ── DNS-queue parity ──
    // Counts the dns_queue side-DB row total so operators can verify the
    // reconciler/reaper are keeping it in sync with the threats-side
    // candidate set. Parity is healthy when
    // |queue_size - candidatesInThreats| ≈ 0, where candidatesInThreats
    // is `countDnsCandidatesInThreats` (the FC-drift predicate), NOT the
    // cooldown-filtered `domain_geo_drainable`. Comparing against the
    // cooldown-filtered count made this look like a huge phantom drift in
    // normal operation (most rows are mid-cooldown) — fixed in S0.2.
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
    // Four aggregates, run one after another, each bounded by hoursBack.
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
    // Four indexed (agent_id, created_at) seeks over navigator's outputs in
    // the window, run one after another; a failure reports
    // dns_queue_stability_error with the zeroed shape below.
    const dnsQueueStabilityFallback: DnsQueueStability = {
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
    const dnsQueueStabilityT = soft<DnsQueueStability>("dns_queue_stability", dnsQueueStabilityFallback, async () => {
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
      // agent_outputs spans telemetry ∪ core (Track B1 wave 2): each
      // aggregate runs per part (the split keeps a backfilled row from
      // counting twice) and is merged in code — AVGs weighted by their
      // COUNT(col) companion, so NULLs are ignored exactly as SQL does.
      const navParts = await historyParts(env, "agent_outputs");
      const windowBind = `-${hoursBack} hours`;
      const [sourceRow, throughputRow, reconcilerRow, reaperRow, reaperKv] = await runSequential([
        () => unionAggregateFirst<{ queue_n: number; threats_n: number; total_n: number }>(navParts, () => ({ sql: `
          SELECT
            SUM(CASE WHEN summary LIKE '%source=queue%' THEN 1 ELSE 0 END) AS queue_n,
            SUM(CASE WHEN summary LIKE '%source=threats%' THEN 1 ELSE 0 END) AS threats_n,
            COUNT(*) AS total_n
          FROM agent_outputs
          WHERE agent_id = 'navigator'
            AND type = 'diagnostic'
            AND summary LIKE 'dns-backfill:%'
            AND created_at >= datetime('now', ?)/*split*/
        `, binds: [windowBind] }), { sum: ["queue_n", "threats_n", "total_n"] }),
        () => unionAggregateFirst<{
          avg_processed: number | null;
          avg_resolved: number | null;
          avg_dead: number | null;
          avg_duration_ms: number | null;
          n_processed: number;
          n_resolved: number;
          n_dead: number;
          n_duration_ms: number;
        }>(navParts, () => ({ sql: `
          SELECT
            AVG(CAST(json_extract(details, '$.processed')      AS REAL)) AS avg_processed,
            AVG(CAST(json_extract(details, '$.resolved')       AS REAL)) AS avg_resolved,
            AVG(CAST(json_extract(details, '$.graduated_dead') AS REAL)) AS avg_dead,
            AVG(CAST(json_extract(details, '$.duration_ms')    AS REAL)) AS avg_duration_ms,
            COUNT(CAST(json_extract(details, '$.processed')      AS REAL)) AS n_processed,
            COUNT(CAST(json_extract(details, '$.resolved')       AS REAL)) AS n_resolved,
            COUNT(CAST(json_extract(details, '$.graduated_dead') AS REAL)) AS n_dead,
            COUNT(CAST(json_extract(details, '$.duration_ms')    AS REAL)) AS n_duration_ms
          FROM agent_outputs
          WHERE agent_id = 'navigator'
            AND type = 'diagnostic'
            AND summary LIKE 'dns-backfill:%'
            AND created_at >= datetime('now', ?)/*split*/
        `, binds: [windowBind] }), {
          sum: ["n_processed", "n_resolved", "n_dead", "n_duration_ms"],
          avg: [
            { col: "avg_processed", weight: "n_processed" },
            { col: "avg_resolved", weight: "n_resolved" },
            { col: "avg_dead", weight: "n_dead" },
            { col: "avg_duration_ms", weight: "n_duration_ms" },
          ],
          drop: ["n_processed", "n_resolved", "n_dead", "n_duration_ms"],
        }),
        () => unionAggregateFirst<{
          runs: number;
          runs_with_failures: number;
          total_batch_failures: number;
          avg_scanned: number | null;
          avg_enqueued: number | null;
          avg_cursor_lag_minutes: number | null;
          max_cursor_lag_minutes: number | null;
          n_scanned: number;
          n_enqueued: number;
          n_cursor_lag: number;
        }>(navParts, () => ({ sql: `
          SELECT
            COUNT(*)                                                       AS runs,
            SUM(CASE WHEN CAST(json_extract(details, '$.batches_failed')
                              AS INT) > 0 THEN 1 ELSE 0 END)               AS runs_with_failures,
            SUM(CAST(json_extract(details, '$.batches_failed') AS INT))    AS total_batch_failures,
            AVG(CAST(json_extract(details, '$.scanned')  AS REAL))         AS avg_scanned,
            AVG(CAST(json_extract(details, '$.enqueued') AS REAL))         AS avg_enqueued,
            AVG(CAST(json_extract(details, '$.cursor_lag_minutes') AS REAL)) AS avg_cursor_lag_minutes,
            MAX(CAST(json_extract(details, '$.cursor_lag_minutes') AS REAL)) AS max_cursor_lag_minutes,
            COUNT(CAST(json_extract(details, '$.scanned')  AS REAL))       AS n_scanned,
            COUNT(CAST(json_extract(details, '$.enqueued') AS REAL))       AS n_enqueued,
            COUNT(CAST(json_extract(details, '$.cursor_lag_minutes') AS REAL)) AS n_cursor_lag
          FROM agent_outputs
          WHERE agent_id = 'navigator'
            AND type = 'diagnostic'
            AND summary LIKE 'dns-queue-reconcile%'
            AND created_at >= datetime('now', ?)/*split*/
        `, binds: [windowBind] }), {
          sum: ["runs", "runs_with_failures", "total_batch_failures", "n_scanned", "n_enqueued", "n_cursor_lag"],
          max: ["max_cursor_lag_minutes"],
          avg: [
            { col: "avg_scanned", weight: "n_scanned" },
            { col: "avg_enqueued", weight: "n_enqueued" },
            { col: "avg_cursor_lag_minutes", weight: "n_cursor_lag" },
          ],
          drop: ["n_scanned", "n_enqueued", "n_cursor_lag"],
        }),
        () => unionAggregateFirst<{ runs: number; total_stale_removed: number | null }>(navParts, () => ({ sql: `
          SELECT
            COUNT(*) AS runs,
            SUM(CAST(json_extract(details, '$.stale_removed') AS INT)) AS total_stale_removed
          FROM agent_outputs
          WHERE agent_id = 'navigator'
            AND type = 'diagnostic'
            AND summary LIKE 'dns-queue-reap%'
            AND created_at >= datetime('now', ?)/*split*/
        `, binds: [windowBind] }), { sum: ["runs", "total_stale_removed"] }),
        () => reaperKvP,
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
    });

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

    // Threats-side DNS candidate count — the REAL parity partner for
    // dns_queue's row total (see countDnsCandidatesInThreats). Distinct
    // from domainGeoDrainable above, which is cooldown-filtered.
    // Shares the dns_drainable cache key + TTL (lib/dns-drainable.ts) so this
    // piggybacks on Navigator's once-daily count (26h TTL) instead of
    // running its own full-table COUNT(DISTINCT) scan on every diagnostics
    // call. It computes only when the key is absent (first deploy / the
    // daily recount was skipped); the value can be up to ~24h old.
    const dnsCandidatesInThreatsT = soft<{ n: number; t: number | null } | null>("dns_queue_parity", null, () => cachedCount(
      env, DNS_DRAINABLE_CACHE_KEY, DNS_DRAINABLE_TTL_S,
      () => countDnsCandidatesInThreats(env.DB),
    ).then(async (n) => {
      // Write time of the entry just read (or just written on a miss) so
      // the parity block can say how old the count is — it is a daily
      // value compared against a live queue size.
      const e = await peekCountEntry(env, DNS_DRAINABLE_CACHE_KEY, DNS_DRAINABLE_TTL_S);
      return { n, t: e?.t ?? null };
    }));

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
    //
    // INDEXED BY idx_threats_carto_phase0 (migration 0110: enriched_at IS
    // NULL AND ip_address IS NOT NULL AND ip_address != '' AND
    // enrichment_attempts < 5) on both queue counts: each WHERE repeats that
    // predicate term for term, so the partial index (~1K rows) is always
    // usable. Without the hint the planner picks an `ip_address > ?` range
    // on idx_threats_ip_source_feed (~1.35M rows) — measured with EXPLAIN
    // QUERY PLAN in prod, 2026-10-14. Keep the WHERE implying the index
    // predicate; an unusable hint re-runs unhinted (withIndexHintFallback).
    const cartoQueueT = soft<{ n: number } | null>("enrichment_pipeline", null, () => cachedCount(env, 'count.threats.carto_queue', 300, async () => {
      const row = await withIndexHintFallback(`
        SELECT COUNT(*) AS n FROM threats INDEXED BY idx_threats_carto_phase0
        WHERE enriched_at IS NULL
          AND ip_address IS NOT NULL AND ip_address != ''
          AND enrichment_attempts < 5
          ${PRIVATE_IP_SQL_FILTER}
      `, (q) => env.DB.prepare(q).first<{ n: number }>());
      return row?.n ?? 0;
    }).then((n) => ({ n })));

    // Cartographer queue WITHOUT private IP filter (for comparison — shows inflation)
    const cartoQueueRawT = soft<{ n: number } | null>("enrichment_pipeline", null, () => cachedCount(env, 'count.threats.carto_queue_raw', 300, async () => {
      const row = await withIndexHintFallback(`
        SELECT COUNT(*) AS n FROM threats INDEXED BY idx_threats_carto_phase0
        WHERE enriched_at IS NULL
          AND ip_address IS NOT NULL AND ip_address != ''
          AND enrichment_attempts < 5
      `, (q) => env.DB.prepare(q).first<{ n: number }>());
      return row?.n ?? 0;
    }).then((n) => ({ n })));

    // Threats exhausted by cartographer — BOTH geo phases gave up with no
    // coordinates. These exit the active queue but stay in `threats`. A
    // growing exhausted count means ip-api + GeoLite2 together can't
    // enrich a meaningful share of the new threat mix; consider adding a
    // fallback geo source.
    //
    // Predicate + population are shared with the `_by_feed` breakdown
    // below, the GeoCoverage admin panel and cartographer-health — see
    // lib/geo-exhaustion.ts. Previously this headline omitted
    // `status='active'` while its own `_by_feed` breakdown required it,
    // so the breakdown could never sum to the headline.
    //
    // Cache key bumped to .v2 alongside the semantic change so a stale
    // payload can't serve the old definition for a TTL after deploy.
    const cartoExhaustedT = soft<{ n: number } | null>("enrichment_pipeline", null, () => cachedCount(env, 'count.threats.carto_exhausted.v2', 300, async () => {
      const row = await withIndexHintFallback(`
        SELECT COUNT(*) AS n FROM ${GEO_UNMAPPED_THREATS_FROM}
        WHERE ${GEO_UNMAPPED_POPULATION_SQL}
          AND ${GEO_TERMINAL_SQL}
      `, (q) => env.DB.prepare(q).first<{ n: number }>());
      return row?.n ?? 0;
    }).then((n) => ({ n })));

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
    type GeoCoverageWindow = {
      window: '24h' | '7d' | '30d';
      mapped: number;
      total: number;
      unmapped: number;
      coverage_pct: number | null;
    };
    // Six cube range reads (idx_cube_*_hour), one after another.
    const geoCoverageT = soft<GeoCoverageWindow[]>("geo_coverage", [], async () => {
      const out: GeoCoverageWindow[] = [];
      for (const w of geoCoverageWindows) {
        const mapped = await env.DB.prepare(
          `SELECT COALESCE(SUM(threat_count), 0) AS n FROM threat_cube_geo WHERE hour_bucket >= strftime('%Y-%m-%d %H:00:00', ${w.sqlOffset})`
        ).first<{ n: number }>();
        const total = await env.DB.prepare(
          `SELECT COALESCE(SUM(threat_count), 0) AS n FROM threat_cube_status WHERE hour_bucket >= strftime('%Y-%m-%d %H:00:00', ${w.sqlOffset})`
        ).first<{ n: number }>();
        const m = mapped?.n ?? 0;
        const t = total?.n ?? 0;
        out.push({
          window: w.key,
          mapped: m,
          total: t,
          unmapped: Math.max(0, t - m),
          coverage_pct: t > 0 ? Math.round((m / t) * 1000) / 10 : null,
        });
      }
      return out;
    });

    // Per-feed × per-type breakdown of the exhausted pile. Without
    // this, "cartographer_exhausted: 1,402" is opaque — operators
    // can't tell whether it's a feed regression (one feed dumping
    // un-resolvable IPs), a class of threats (e.g. botnet IPs from
    // sinkholes), or a geo-source coverage gap. Top 15 keeps the
    // payload bounded; the full distribution stays queryable in D1.
    //
    // Same predicate + population as the headline above, so this list
    // sums to `cartographer_exhausted` (modulo the LIMIT 15 tail).
    //
    // Cached 5 min like the headline count it breaks down (it walks the
    // same partial index), so the pair stays roughly in step.
    const cartoExhaustedByFeedT = soft("enrichment_pipeline", noRows<{ source_feed: string; threat_type: string; n: number }>, () => cachedValue(
      env, 'diag.carto_exhausted_by_feed.v1', 300,
      async () => rows(await withIndexHintFallback(`
      SELECT source_feed, threat_type, COUNT(*) AS n
        FROM ${GEO_UNMAPPED_THREATS_FROM}
       WHERE ${GEO_UNMAPPED_POPULATION_SQL}
         AND ${GEO_TERMINAL_SQL}
       GROUP BY source_feed, threat_type
       ORDER BY n DESC
       LIMIT 15
    `,
      (q) => env.DB.prepare(q).all<{ source_feed: string; threat_type: string; n: number }>())),
    ));

    // Alerts table growth by brand tier (NX2 tier-gate visibility).
    // The createAlert tier gate skips inserts when brands.tier='tracked'
    // so the alerts table doesn't grow proportional to the ~76K tracked
    // brands. This query proves the gate is working: under steady state
    // the 'tracked' row should be 0 (or only legacy rows from before
    // the gate landed).
    //
    // Whole-table scan of alerts with a brands point lookup per alert, for
    // a slow-moving tier split — cached 15 min with single-flight refill.
    const alertsByTierT = soft("alerts", noRows<{ tier: string; total: number; created_24h: number }>, () => cachedValue(
      env, 'diag.alerts_by_tier.v1', DIAG_SLOW_SECTION_TTL_S,
      async () => rows(await env.DB.prepare(`
      SELECT
        COALESCE(b.tier, 'unclassified') AS tier,
        COUNT(*) AS total,
        SUM(CASE WHEN a.created_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS created_24h
      FROM alerts a
      LEFT JOIN brands b ON b.id = a.brand_id
      GROUP BY COALESCE(b.tier, 'unclassified')
      ORDER BY total DESC
    `).all<{ tier: string; total: number; created_24h: number }>()),
      { singleFlight: DIAG_SINGLE_FLIGHT },
    ));

    // ─── 3. Per-feed health ─────────────────────────────────────────
    // Window predicates on started_at (here and agent_runs below) are
    // written as `started_at >= datetime(<bound>) AND datetime(started_at)
    // >= datetime(<bound>)`. The first term is a plain range the
    // idx_*_started indexes (migration 0319) can seek; the second keeps
    // the exact semantics. The range is a SUPERSET of the exact window
    // for both stored formats: SQLite text ('YYYY-MM-DD HH:MM:SS')
    // compares exactly, and ISO text ('YYYY-MM-DDTHH:MM:SS.sssZ', which
    // feedRunner and nexus write) sorts 'T' above ' ', so ISO rows can
    // only be over-included (from the bound's date), never dropped.
    // `GROUP BY +col` stops the planner walking the (col, started_at)
    // index for the grouping, which reads the whole table.
    const feedHealthT = soft("feeds", noRows<{
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
    }>, async () => rows(await withRoutedFeedConfig(env, await unionGroupedResult<{
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
    }>(
      // Track B1d: history ⋈ config, both feeds-family tables, so each part
      // runs the JOIN on its own DB; groups merge per feed, config columns
      // from the routed store's part.
      await historyParts(env, 'feed_pull_history', { alias: 'fph', routedFirst: true }),
      () => ({ sql: `
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
        AND datetime(fph.started_at) >= datetime('now', '-' || ? || ' hours')/*split*/
      GROUP BY +fph.feed_name
      ORDER BY failed DESC, fph.feed_name ASC
    `, binds: [hoursBack, hoursBack] }), {
        groupBy: ['feed_name'],
        sum: ['total_pulls', 'success', 'partial', 'failed', 'total_ingested', 'total_rejected'],
        max: ['last_success_at', 'last_failure_at'],
        sort: (a, b) => (b.failed - a.failed) || (a.feed_name < b.feed_name ? -1 : a.feed_name > b.feed_name ? 1 : 0),
      }))));

    // Consecutive failures + auto-pause risk from feed_status
    const feedStatusT = soft("feeds", noRows<{
      feed_name: string;
      consecutive_failures: number;
      health_status: string;
      last_error: string | null;
      threshold: number;
    }>, async () => rows(await (await familyStore(env, 'feeds')).prepare(`
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
    }>()));

    // Recent feed errors (last 20 failed pulls with error messages).
    // `+status` keeps the planner off idx_feed_pulls_status, which would
    // read every failed pull ever recorded; the started_at range (see the
    // window note above) reads only the window.
    const feedErrorsT = soft("feeds", noRows<{
      feed_name: string;
      started_at: string;
      error_message: string;
    }>, async () => rows(await unionRowsResult<{
      id: string;
      feed_name: string;
      started_at: string;
      error_message: string;
    }>(await historyParts(env, 'feed_pull_history'), (p) => ({ sql: `
      SELECT id, feed_name, started_at, error_message
      FROM feed_pull_history
      WHERE +status = 'failed' AND error_message IS NOT NULL
        AND started_at >= datetime('now', '-' || ? || ' hours')
        AND datetime(started_at) >= datetime('now', '-' || ? || ' hours')/*split*/
      ORDER BY started_at DESC
      LIMIT ?
    `, binds: [hoursBack, hoursBack, p.limit] }), { key: byId, sort: byDesc('started_at'), limit: 20, drop: ['id'] })));

    // ─── 4. Agent mesh ──────────────────────────────────────────────
    // killed_runs = status='partial' AND completed_at IS NULL. The agentRunner
    // INSERTs new rows with status='partial' and only UPDATEs to 'success' (or
    // back to 'partial' with completed_at set if the agent returned approvals)
    // when execute() returns. A row stuck at status='partial' with completed_at
    // NULL means the Worker was killed mid-run (CPU ceiling, OOM, etc.). The
    // 'stalled' query only sees status='running', so without this metric these
    // mid-execution kills are invisible.
    type AgentMeshQueryRow = {
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
    };
    // Was `WHERE datetime(started_at) >= …` + `GROUP BY agent_id`: a walk
    // of the whole agent_runs table (~132K rows, never pruned) with a
    // table lookup per row. Now a started_at range seek on
    // idx_agent_runs_started (window note under §3).
    const agentMeshT = soft("agent_mesh", noRows<AgentMeshQueryRow>, async () => {
      const parts = await historyParts(env, 'agent_runs');
      return rows(await unionGroupedResult<AgentMeshQueryRow & { n_dur?: number }>(parts, (p) => ({ sql: `
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
        AVG(CASE WHEN status IN ('success', 'partial') AND completed_at IS NOT NULL THEN duration_ms END) AS avg_duration_ms,
        COUNT(CASE WHEN status IN ('success', 'partial') AND completed_at IS NOT NULL THEN duration_ms END) AS n_dur
      FROM agent_runs
      WHERE started_at >= datetime('now', '-' || ? || ' hours')
        AND datetime(started_at) >= datetime('now', '-' || ? || ' hours')/*split*/
      GROUP BY +agent_id
      ORDER BY agent_id ASC
    `, binds: [hoursBack, hoursBack] }), {
        groupBy: ['agent_id'],
        sum: ['total_runs', 'success', 'partial', 'killed_runs', 'failed', 'running', 'total_records_processed', 'n_dur'],
        max: ['last_completed_at', 'last_error'],
        avg: [{ col: 'avg_duration_ms', weight: 'n_dur' }],
        sort: (a, b) => (a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0),
        drop: ['n_dur'],
      }));
    });

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
    //
    // `GROUP BY +agent_id`: grouped by the bare column, the planner walks
    // idx_activity_agent end to end (the whole activity log); this way it
    // seeks idx_activity_recent (created_at DESC) for the window instead.
    type WorkflowMeshRow = {
      agent_id: string;
      dispatched: number;
      completed: number;
      dispatch_failed: number;
      cooldown_skipped: number;
      run_failed: number;
      last_completed_at: string | null;
      last_error: string | null;
    };
    const workflowAgentMeshT = soft("agent_mesh", noRows<WorkflowMeshRow>, async () => {
      // Track B1c: during the cut-over the activity log spans telemetry ∪
      // core; the shared rollup (lib/workflow-agent-stats.ts) merges the
      // parts (last_error from the part holding the newest failure).
      if ((await historyParts(env, 'agent_activity_log')).length > 1) {
        const merged = await getWorkflowAgentStats(env.DB, hoursBack, env);
        return { results: [...merged.values()].map((w): WorkflowMeshRow => ({
          agent_id: w.agent_id, dispatched: w.dispatched, completed: w.completed,
          dispatch_failed: w.dispatch_failed, cooldown_skipped: w.cooldown_skipped,
          run_failed: w.run_failed, last_completed_at: w.last_completed_at, last_error: w.last_error,
        })) };
      }
      return rows(await env.DB.prepare(`
      SELECT
        agent_id,
        SUM(CASE WHEN event_type = 'workflow_dispatched' THEN 1 ELSE 0 END) AS dispatched,
        SUM(CASE WHEN event_type = 'batch_complete' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN event_type = 'workflow_dispatch_failed' THEN 1 ELSE 0 END) AS dispatch_failed,
        SUM(CASE WHEN event_type = 'workflow_cooldown_skip' THEN 1 ELSE 0 END) AS cooldown_skipped,
        -- run_failed: the workflow body STARTED and then threw
        -- (NEXUS_DARK_2026-09). Distinct from dispatch_failed, which is
        -- a platform-side failure to start it at all. Without this a run
        -- that starts and dies looks identical to one still in flight —
        -- which is why nexus reported running=6 / completed=0 for weeks
        -- with last_error NULL and nothing in agent_mesh.stalled[].
        SUM(CASE WHEN event_type = 'workflow_failed' THEN 1 ELSE 0 END) AS run_failed,
        MAX(CASE WHEN event_type = 'batch_complete' THEN created_at END) AS last_completed_at,
        -- Correlated subquery, NOT MAX(message): MAX() returns the
        -- lexicographically largest message, which with two failure
        -- classes folded in (workflow_dispatch_failed = platform-side,
        -- workflow_failed = body-side) routinely belongs to a different
        -- event than the most recent failure. An operator would be shown
        -- a dispatch error for a run that actually died in its body —
        -- exactly the confusion this rollup exists to end. One indexed
        -- point-lookup per agent group (idx_activity_agent is
        -- (agent_id, created_at DESC)); the group count is 1-2 agents.
        (SELECT f.message
           FROM agent_activity_log f
          WHERE f.agent_id = a.agent_id
            AND f.created_at >= datetime('now', '-' || ? || ' hours')
            AND f.event_type IN ('workflow_dispatch_failed','workflow_failed')
          ORDER BY f.created_at DESC, f.id DESC
          LIMIT 1) AS last_error
      FROM agent_activity_log a
      WHERE created_at >= datetime('now', '-' || ? || ' hours')
        AND event_type IN ('workflow_dispatched','batch_complete','workflow_dispatch_failed','workflow_cooldown_skip','workflow_failed')
      GROUP BY +agent_id
    `).bind(hoursBack, hoursBack).all<WorkflowMeshRow>());
    });

    // Stalled agents — started but never completed in the last N hours.
    // Seeks idx_agent_runs_status (status = 'running' is a handful of
    // rows), so the non-sargable datetime() term only filters those.
    const stalledT = soft("agent_mesh", noRows<{
      agent_id: string;
      run_id: string;
      started_at: string;
      minutes_stalled: number;
    }>, async () => rows(await unionRowsResult<{
      agent_id: string;
      run_id: string;
      started_at: string;
      minutes_stalled: number;
    }>(await historyParts(env, 'agent_runs'), (p) => ({ sql: `
      SELECT agent_id, id AS run_id, started_at,
             ROUND((julianday('now') - julianday(started_at)) * 24 * 60, 1) AS minutes_stalled
      FROM agent_runs
      WHERE status = 'running'
        AND datetime(started_at) < datetime('now', '-15 minutes')/*split*/
      ORDER BY started_at ASC
      LIMIT 10
    `, binds: [] }), {
      key: (r) => r.run_id,
      sort: (a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0),
      limit: 10,
    })));

    // ─── 5. Backlog trends ──────────────────────────────────────────
    // backlog_history is pruned to 7 days by Flight Control — small.
    const backlogT = soft("backlog_trends", noRows<{
      backlog_name: string;
      count: number;
      recorded_at: string;
      rn: number;
    }>, async () => rows(await env.DB.prepare(`
      SELECT backlog_name, count, recorded_at,
             ROW_NUMBER() OVER (PARTITION BY backlog_name ORDER BY recorded_at DESC) AS rn
      FROM backlog_history
      WHERE recorded_at > datetime('now', '-' || ? || ' hours')
    `).bind(hoursBack).all<{
      backlog_name: string;
      count: number;
      recorded_at: string;
      rn: number;
    }>()));

    // ─── 6. AI spend (last 24h) ─────────────────────────────────────
    // `GROUP BY +agent_id` → idx_ledger_month range seek on created_at
    // instead of a walk of the whole ledger via idx_ledger_agent.
    const aiSpendT = soft("ai_spend_24h", noRows<{
      agent_id: string;
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>, async () => rows(await unionGroupedResult<{
      agent_id: string;
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>(await historyParts(env, 'budget_ledger'), () => ({ sql: `
      SELECT
        agent_id,
        COUNT(*) AS calls,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        ROUND(SUM(cost_usd), 4) AS cost_usd
      FROM budget_ledger
      WHERE created_at >= datetime('now', '-1 day')/*split*/
      GROUP BY +agent_id
      ORDER BY cost_usd DESC
    `, binds: [] }), {
      // Track B1d: per agent across telemetry ∪ core.
      groupBy: ['agent_id'],
      sum: ['calls', 'input_tokens', 'output_tokens', 'cost_usd'],
      sort: (a, b) => b.cost_usd - a.cost_usd,
    })));

    // ─── 6b. AI health (silent-AI-failure surface) ──────────────────
    // ai_spend_24h above answers "what did AI cost". It CANNOT answer
    // "is AI working": a zero-cost window looks identical whether the
    // platform had nothing to classify or every call was returning
    // HTTP 400. That ambiguity is how ~3 months of total AI outage
    // (last budget_ledger row 2026-07-10) read as healthy on every
    // surface, including this endpoint.
    //
    // `last_ledger_row_at` is ground truth for the last SUCCESSFUL
    // call (lib/anthropic.ts writes one ledger row per success, nothing
    // on failure). The per-agent attempted/succeeded rollup is the
    // disambiguator: attempted = 0 means a quiet platform, attempted > 0
    // with succeeded = 0 means an outage. Same pair Flight Control's
    // platform_ai_calls_failing check alerts on.
    // The newest row on EITHER DB during the budget cut-over (Track B1d);
    // no split — a backfilled duplicate cannot change a MAX.
    const aiLedgerLastT = soft<{ last_at: string | null } | null>("ai_health", null, async () => unionAggregateFirst<{ last_at: string | null }>(
      await historyParts(env, 'budget_ledger'), () => ({ sql: `
      SELECT MAX(created_at) AS last_at FROM budget_ledger
    `, binds: [] }), { max: ['last_at'] }));

    // Strictly-API counters, written into agent_outputs.details by the
    // instrumented agents. Agent-agnostic — any agent that starts
    // emitting aiCallsAttempted / aiCallsSucceeded shows up here with no
    // change.
    //
    // The json_valid() CASE wrapper is load-bearing: json_extract()
    // RAISES on a malformed JSON payload, which would abort the whole
    // diagnostics response. Rows surviving the WHERE all have valid
    // JSON, so the SELECT-list extracts need no wrapper. Flat rather
    // than a CTE to match the Flight Control query this mirrors (see
    // the resource-drift note there).
    //
    // `GROUP BY +agent_id`: grouped by the bare column the planner walks
    // idx_agent_outputs_agent over the WHOLE table (json_valid per row);
    // this way it seeks idx_agent_outputs_created_at for the window.
    type AiCallHealthRow = {
      agent_id: string;
      attempted: number;
      succeeded: number;
      skipped: number;
      last_run_at: string | null;
      newest_failure: string | null;
    };
    // agent_outputs spans telemetry ∪ core (Track B1 wave 2): per-part
    // SUMs / MAXes merged per agent (split excludes backfilled rows), then
    // re-sorted — no HAVING, so nothing is filtered per DB.
    const aiCallHealthT = soft("ai_health", noRows<AiCallHealthRow>, async () => rows(await unionGroupedResult<AiCallHealthRow>(await historyParts(env, "agent_outputs"), () => ({ sql: `
      SELECT agent_id,
             SUM(COALESCE(CAST(json_extract(details, '$.aiCallsAttempted') AS INTEGER), 0)) AS attempted,
             SUM(COALESCE(CAST(json_extract(details, '$.aiCallsSucceeded') AS INTEGER), 0)) AS succeeded,
             SUM(COALESCE(CAST(json_extract(details, '$.aiCallsSkipped')   AS INTEGER), 0)) AS skipped,
             MAX(created_at)                                     AS last_run_at,
             -- Kind + message from THE SAME, NEWEST failing row. Two
             -- independent MAX() aggregates (the first version) paired a
             -- kind from one row with a message from another, and MAX on
             -- text is lexicographic rather than temporal so neither was
             -- the newest. See flightControl.ts parseNewestFailure for the
             -- decoder and the full rationale.
             MAX(CASE WHEN json_extract(details, '$.aiFirstError') IS NOT NULL
                      THEN created_at || char(31) || json_object(
                             'kind',  json_extract(details, '$.aiFirstFailureKind'),
                             'error', json_extract(details, '$.aiFirstError'))
                      END)                                       AS newest_failure
        FROM agent_outputs
       WHERE created_at > datetime('now', '-' || ? || ' hours')
         AND (CASE WHEN json_valid(details)
                   THEN json_extract(details, '$.aiCallsAttempted')
                   ELSE NULL END) IS NOT NULL/*split*/
       GROUP BY +agent_id
       ORDER BY attempted DESC
    `, binds: [hoursBack] }), {
      groupBy: ["agent_id"],
      sum: ["attempted", "succeeded", "skipped"],
      max: ["last_run_at", "newest_failure"],
      sort: (a, b) => b.attempted - a.attempted,
    })));

    // ─── 7. Cron health (recent Navigator + orchestrator) ───────────
    // Navigator was renamed from 'fast_tick' — both IDs are queried so the
    // window spans the transition. Historical rows keep 'fast_tick'; new
    // rows land under 'navigator'.
    // The started_at range turns this into four (agent_id, started_at)
    // seeks on idx_agent_runs_agent; the datetime()-only predicate read
    // every run those four agents ever wrote (navigator alone: one per 5 min).
    type CronHealthRow = {
      agent_id: string;
      runs: number;
      success: number;
      not_success: number;
      last_run_at: string | null;
      avg_duration_ms: number | null;
    };
    const cronHealthT = soft("cron_health", noRows<CronHealthRow>, async () => {
      const parts = await historyParts(env, 'agent_runs');
      return rows(await unionGroupedResult<CronHealthRow & { n_dur?: number }>(parts, (p) => ({ sql: `
      SELECT agent_id,
             COUNT(*) AS runs,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
             SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS not_success,
             MAX(completed_at) AS last_run_at,
             -- See per-agent query above: exclude reaped/failed runs and
             -- mid-run kills so a single reaped cron run (e.g. navigator
             -- stamped at the 60min reap ceiling) can't dominate the mean.
             AVG(CASE WHEN status IN ('success', 'partial') AND completed_at IS NOT NULL THEN duration_ms END) AS avg_duration_ms,
             COUNT(CASE WHEN status IN ('success', 'partial') AND completed_at IS NOT NULL THEN duration_ms END) AS n_dur
      FROM agent_runs
      WHERE agent_id IN ('navigator', 'fast_tick', 'flight_control', 'orchestrator')
        AND started_at >= datetime('now', '-' || ? || ' hours')
        AND datetime(started_at) >= datetime('now', '-' || ? || ' hours')/*split*/
      GROUP BY agent_id
    `, binds: [hoursBack, hoursBack] }), {
        groupBy: ['agent_id'],
        sum: ['runs', 'success', 'not_success', 'n_dur'],
        max: ['last_run_at'],
        avg: [{ col: 'avg_duration_ms', weight: 'n_dur' }],
        drop: ['n_dur'],
      }));
    });

    // ─── 8. Platform totals ─────────────────────────────────────────
    // Eight whole-table counts (brands ~114K, lookalike_domains, two
    // passes over infrastructure_clusters …) for numbers that move slowly
    // — cached 15 min with single-flight refill.
    // feed_configs is in the feeds family (Track B1d): its two counts are
    // read from the routed feeds store, the rest from core, then merged.
    const totalsT = soft("platform_totals", null, () => cachedValue(env, 'diag.platform_totals.v1', DIAG_SLOW_SECTION_TTL_S, async () => {
      // brands (~139K-row scan, half of this statement's reads) comes from
      // the shared `count.brands.total` counter (1h, same key + TTL as
      // brand_stats / brand_list / admin stats), so it may lag by up to 1h.
      const brands = await cachedCount(env, 'count.brands.total', 3600, async () => {
        const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM brands").first<{ n: number }>();
        return r?.n ?? 0;
      });
      const coreRest = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM hosting_providers) AS providers,
        (SELECT COUNT(*) FROM campaigns) AS campaigns,
        (SELECT COUNT(*) FROM infrastructure_clusters WHERE ${notRetiredClusterSql()}) AS clusters,
        (SELECT COUNT(*) FROM infrastructure_clusters WHERE ${retiredClusterSql()}) AS clusters_retired,
        (SELECT COUNT(*) FROM lookalike_domains) AS lookalike_domains
    `).first<{
        providers: number;
        campaigns: number;
        clusters: number;
        clusters_retired: number;
        lookalike_domains: number;
      }>();
      const feeds = await (await familyStore(env, 'feeds')).prepare(`
      SELECT
        (SELECT COUNT(*) FROM feed_configs WHERE enabled = 1) AS feeds_enabled,
        (SELECT COUNT(*) FROM feed_configs WHERE enabled = 0) AS feeds_disabled
    `).first<{ feeds_enabled: number; feeds_disabled: number }>();
      const core = coreRest ? { brands, ...coreRest } : null;
      return core ? { ...core, feeds_enabled: feeds?.feeds_enabled ?? 0, feeds_disabled: feeds?.feeds_disabled ?? 0 } : null;
    }, { singleFlight: DIAG_SINGLE_FLIGHT }));

    // ─── Off-main-DB work (CF GraphQL / Analytics Engine / KV / side DBs)
    // None of these read the main D1, so they start now and run alongside
    // the sequential main-DB reads below; each degrades to its usual
    // "no data" shape (+ `<section>_error`) if it throws.
    const offMain = <T>(section: string, fallback: T | ((message: string) => T), fn: () => Promise<T>) =>
      soft(section, fallback, fn)();
    // D1 metrics from Cloudflare GraphQL Analytics API. Account-wide (all
    // databases) so the 25B-ceiling projection is computed against a
    // matching numerator — see fetchD1Metrics.
    const d1MetricsP = offMain<D1Metrics>("d1_metrics_24h", (error) => ({
      rows_read_24h: null, rows_written_24h: null, read_queries_24h: null, write_queries_24h: null,
      monthly_rows_read_projection: null, pct_of_25b_plan_ceiling: null, setup_required: false, error,
    }), () => fetchD1Metrics(env));
    const d1AttributionP = offMain<Awaited<ReturnType<typeof fetchD1EndpointAttribution>>>("d1_attribution_24h", (error) => ({
      by_endpoint: [], setup_required: false, error,
    }), () => fetchD1EndpointAttribution(env));
    // Soft-cap state (Navigator skip tracking + thresholds) and the
    // per-query top-N from CF's d1QueriesAdaptiveGroups. Both fail
    // gracefully — diagnostics endpoint stays usable when CF GraphQL
    // is down or CF_API_TOKEN isn't configured.
    const d1BudgetStateP = offMain<Awaited<ReturnType<typeof getBudgetDiagnostics>> | null>(
      "d1_budget_state", null, () => getBudgetDiagnostics(env));
    const d1TopQueriesP = offMain<Awaited<ReturnType<typeof fetchD1TopQueries>>>("d1_top_queries", (error) => ({ queries: [], error }),
      () => fetchD1TopQueries(env, 20, "reads"));
    // Parallel write-spender view. Writes have their own included
    // quota on Workers Paid (50M/mo) so the operator needs a separate
    // top-N ordered by rowsWritten to attribute overage.
    const d1TopWriteQueriesP = offMain<Awaited<ReturnType<typeof fetchD1TopQueries>>>("d1_top_write_queries", (error) => ({ queries: [], error }),
      () => fetchD1TopQueries(env, 20, "writes"));
    // PR-X: billing-cycle (18th-17th) reads summed across all D1 DBs
    // on the account. Replaces the rolling-24h × 30 projection in the
    // monthly meter — see lib/d1-budget.ts header for why.
    const d1BillingCycleP = offMain<Awaited<ReturnType<typeof fetchBillingCycleMetrics>> | null>(
      "d1_billing_cycle", null, () => fetchBillingCycleMetrics(env));
    // PR-AM: recent-window per-DB metrics (default 12h). Used to monitor
    // post-fix activity without waiting for cycle aggregates. The `hours`
    // query param on the endpoint controls the window — falls back to
    // 12h when missing.
    const d1RecentP = offMain<Awaited<ReturnType<typeof fetchRecentWindowMetrics>> | null>(
      "d1_recent_window", null, () => fetchRecentWindowMetrics(env, hoursBack));
    // Per-hour account-wide rows read/written (unsampled, database-level)
    // + the matching per-job AE breakdown — the pair that attributes a
    // spike hour to a job. Window = `hours`, capped at 48.
    const hourlyWindow = clampHourlyWindow(hoursBack);
    const d1HourlyP = offMain<Awaited<ReturnType<typeof fetchD1HourlyMetrics>>>("d1_hourly", (error) => ({
      hours: [],
      window_hours: hourlyWindow, setup_required: false, error,
    }), () => fetchD1HourlyMetrics(env, hourlyWindow));
    const d1HourlyAttributionP = offMain<Awaited<ReturnType<typeof fetchD1HourlyAttribution>>>("d1_attribution_hourly", (error) => ({
      hours: [], setup_required: false, error,
    }), () => fetchD1HourlyAttribution(env, hourlyWindow));
    const cachedCountStatsP = offMain<Awaited<ReturnType<typeof getCachedCountStats>> | null>(
      "cached_count", null, () => getCachedCountStats(env));
    const nrdRetentionP = offMain<NrdRetentionDiag | null>("nrd_retention", null, () => buildNrdRetentionDiag(env));
    // dnsQueueSizeP / domainGeoDrainableP (DNS_QUEUE_DB, above) are
    // already running and already swallow their own errors.

    // ─── 9. Module entitlements (v3 Phase A) ────────────────────────
    // Per-module count of orgs in each status. With 7 modules and a
    // small number of orgs this is a tiny scan; revisit when org
    // count > 1000 (we'd materialize into a daily snapshot).
    const moduleEntitlementsT = soft("modules", noRows<{
      module_key: string;
      active_orgs: number;
      trial_orgs: number;
      suspended_orgs: number;
    }>, async () => rows(await env.DB.prepare(`
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
    }>()));

    // Wave 3 signals — cloaking blind-spot rate (rec 4) + weaponization
    // velocity distribution (rec 5). page_analysis is cachedValue-wrapped
    // (KV-cached, single-flight, bounded per TTL); velocity is read from KV
    // only — Navigator computes it twice a day in rowid chunks
    // (lib/velocity-diag.ts), never this request.
    const pageAnalysisT = soft<PageAnalysisDiag | null>("page_analysis", null, () => buildPageAnalysisDiag(env));
    const velocityT = soft<VelocityDiag | null>("velocity", null, () => buildVelocityDiag(env));
    const pausedAgentsT = () => fetchPausedAgentsSafe(env.DB, Date.now(), env);
    const dmarcIngestT = soft<DmarcIngestDiag | null>("dmarc_ingest", null, () => buildDmarcIngestDiag(env));

    // ── Main-DB reads, one at a time ────────────────────────────────
    // Order: cheap live reads first, the cached full-scan sections last,
    // so a cold-cache call front-loads the small windowed reads.
    const [
      clock,
      feedHealth, feedStatus, feedErrors,
      agentMesh, workflowAgentMesh, stalled, pausedAgents, cronHealth, backlog,
      aiSpend, aiLedgerLast, aiCallHealth,
      moduleEntitlements, geoCoverage, dnsQueueStability,
      cartoQueue, cartoQueueRaw, cartoExhausted, cartoExhaustedByFeed,
      enrichment, totals, alertsByTier, dnsCandidatesInThreats,
      pageAnalysis, velocity, dmarcIngest,
    ] = await runSequential([
      clockT,
      feedHealthT, feedStatusT, feedErrorsT,
      agentMeshT, workflowAgentMeshT, stalledT, pausedAgentsT, cronHealthT, backlogT,
      aiSpendT, aiLedgerLastT, aiCallHealthT,
      moduleEntitlementsT, geoCoverageT, dnsQueueStabilityT,
      cartoQueueT, cartoQueueRawT, cartoExhaustedT, cartoExhaustedByFeedT,
      enrichmentT, totalsT, alertsByTierT, dnsCandidatesInThreatsT,
      pageAnalysisT, velocityT, dmarcIngestT,
    ]);

    const [
      d1Metrics, d1Attribution, d1BudgetState, d1TopQueries, d1TopWriteQueries,
      d1BillingCycle, d1Recent, d1Hourly, d1HourlyAttribution,
      cachedCountStats, nrdRetention, dnsQueueSize, domainGeoDrainable,
      databases,
    ] = await Promise.all([
      d1MetricsP, d1AttributionP, d1BudgetStateP, d1TopQueriesP, d1TopWriteQueriesP,
      d1BillingCycleP, d1RecentP, d1HourlyP, d1HourlyAttributionP,
      cachedCountStatsP, nrdRetentionP, dnsQueueSizeP, domainGeoDrainableP,
      // Databases page payload (lib/db-health.ts, 24h window) — KV-cached
      // 10 min, fail-soft per section, so usually a KV read. Started only
      // after the sequential main-DB reads: a cold build may fall back to
      // PRAGMA size reads on the main DB, which must not overlap them.
      offMain<DatabasesPayload | null>("databases", null, () => getDatabasesPayload(env, "24h")),
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
      run_failed?: number;
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
        // Counter arithmetic lives in deriveWorkflowRunTotals so the
        // disjointness rules are stated (and tested) in one place. A
        // workflow that started and threw is FAILED, not running —
        // counting only dispatch_failed as failed is what let nexus
        // report running=6 / failed=0 / last_error=null for ~7 weeks
        // (NEXUS_DARK_2026-09).
        const totals = deriveWorkflowRunTotals(wf);
        byAgent[wf.agent_id] = {
          agent_id: wf.agent_id,
          total_runs: totals.total_runs,
          success: wf.completed,
          partial: 0,
          killed_runs: 0,
          failed: totals.failed,
          running: totals.running,
          last_completed_at: wf.last_completed_at,
          last_error: wf.last_error,
          total_records_processed: 0, // workflows don't write records_processed
          avg_duration_ms: null,
          dispatch_source: 'workflow',
          cooldown_skipped: wf.cooldown_skipped,
          run_failed: wf.run_failed,
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
      const [threatsIdx, outputsIdx, ledgerIdx, statusCube, explainPlan] = await runSequential([
        () => env.DB.prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='threats' ORDER BY name`
        ).all<IndexInfo>(),
        () => env.DB.prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='agent_outputs' ORDER BY name`
        ).all<IndexInfo>(),
        () => env.DB.prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='budget_ledger' ORDER BY name`
        ).all<IndexInfo>(),
        () => env.DB.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='threat_cube_status' LIMIT 1`
        ).first<{ name: string }>(),
        () => env.DB.prepare(
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
    // `type LIKE 'platform_%'` alone can't seek (LIKE is case-insensitive),
    // so it walked all of idx_notifications_dedup. `>= 'platform_' AND
    // < 'platforma'` covers every 'platform_…' type ('a' sorts after '_')
    // as a range on (type, group_key, created_at); the LIKE stays as the
    // exact filter.
    const recentPlatformAlerts = await soft("recent_platform_alerts", noRows<{
      created_at: string; type: string; severity: string;
      title: string; message: string; group_key: string | null;
      occurrences: number;
    }>, async () => rows(await env.DB.prepare(
      `SELECT MAX(created_at) AS created_at, type, severity, title, message, group_key, COUNT(*) AS occurrences
         FROM notifications
        WHERE type >= 'platform_' AND type < 'platforma'
          AND type LIKE 'platform_%'
          AND created_at >= datetime('now', '-' || ? || ' hours')
        GROUP BY type, group_key
        ORDER BY created_at DESC
        LIMIT 50`,
    ).bind(hoursBack).all<{
      created_at: string; type: string; severity: string;
      title: string; message: string; group_key: string | null;
      occurrences: number;
    }>()))();

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
          // 10: additive `velocity.coverage` block (VELOCITY_DARK_2026-09) —
          // splits the NULL-derived `not_computable` bucket into
          // never-computed vs inherently-not-computable. No field removed.
          // 11: additive `page_analysis.ai_build` / `.exfil` / `.generator`
          // (Lane 3 Phase 1 shadow telemetry), plus `page_analysis.truncated`
          // and `ai_build.persisted_delta_drift`. No field removed. The
          // block's cachedValue key carries a matching `.v2` suffix so a
          // deploy does not serve the old shape out of KV for a TTL.
          // 12: additive `nrd_retention` block (KV last-result stamp of the
          // nrd_domains 90-day purge). No field removed.
          // 13: additive `nrd_retention.phantom_hold_clamped` (tiered
          // retention: 30d hot, brand_matched kept, R2 archive). No field
          // removed.
          // 14: additive `agent_mesh.paused[]` + `agent_mesh.summary.paused_count`
          // (circuit-broken / manually paused agents from agent_configs,
          // which never appear in per_agent); on a failed read paused=[],
          // paused_count=null + agent_mesh.paused_error. No field removed.
          // 15: additive `d1_top_queries_note` (top-N per-query numbers are
          // sampled estimates). No field removed.
          // 16: additive `d1_hourly` / `d1_hourly_error` (per-UTC-hour
          // account-wide rows read/written, summed across DBs + per-DB
          // split, window = `hours` capped at 48) and `d1_attribution_hourly`
          // (per-hour top AE `agent:` / `cron:` / `workflow:` endpoints from
          // lib/d1-meter.ts). `d1_attribution_24h` now weights by AE
          // `_sample_interval` and returns top 40 (was 20). No field removed.
          // 17: additive top-level `<section>_error` keys (fail-soft
          // sections: a failed read keeps its section at an empty/zero/null
          // fallback instead of 500-ing the endpoint). Main-DB reads run
          // sequentially; enrichment_pipeline (10 min), platform_totals and
          // alerts.by_tier (15 min) are KV-cached. No field removed.
          // 18: additive `dmarc_ingest` block (hosted DMARC aggregate
          // reporting: reports_24h, verified_reports_24h,
          // incomplete_reports_24h, last_report_at, enrolled_brands,
          // rollup_pending, dropped_unenrolled_24h, dropped_no_brand_24h,
          // dropped_24h by reason incl. ineligible_brand / rate_limited /
          // error). No field removed.
          // 19: additive `databases` block (the Databases page payload,
          // lib/db-health.ts, 24h window) + the AE readers count records
          // (double6-weighted) now that a run writes one point per store;
          // d1_attribution_hourly also lists `feed:` rows. No field removed.
          endpoint_version: 19,
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

        // DNS-queue parity. Compares the dns_queue row total against the
        // threats-side DNS candidate count (countDnsCandidatesInThreats —
        // the same predicate FC's platform_dns_queue_drift alert gates on
        // and the reconciler/reaper converge to). The count is daily
        // (drainable_computed_at / drainable_age_hours give its age), so
        // |delta| ≈ 0 holds shortly after the recount in a healthy steady
        // state and otherwise also includes queue movement since then.
        // Persistent positive delta = stale rows the reaper hasn't
        // dequeued; persistent negative delta = reconciler enqueue lagging
        // behind threats.
        //
        // S0.2 fix: `drainable_in_threats` previously read the
        // COOLDOWN-FILTERED dns_queue count (domain_geo_drainable), a
        // different concept — most rows sit mid-6h-cooldown, so the delta
        // always looked like a huge phantom drift (the mislabeled "R3
        // 9,091-row drift" was this artifact, not a real backlog). It now
        // reads the true threats-side candidate count, so delta tracks the
        // reaper's observed parity (~0). The cooldown metric is unchanged
        // and still exposed under enrichment_pipeline.domain_geo_drainable.
        dns_queue_parity: buildDnsQueueParity({
          bound: dnsQueueSize.bound,
          queueSize: dnsQueueSize.n,
          candidatesInThreats: dnsCandidatesInThreats?.n ?? 0,
          candidatesComputedAtMs: dnsCandidatesInThreats?.t ?? null,
        }),

        // PR-3 → PR-4 gate: aggregated stability signals over the
        // requested window. Consumed by `scripts/dns-queue-stability-
        // check.sh` to print a single green/red verdict before
        // merging the cleanup PR. Each signal is documented in
        // `docs/PLATFORM_DATA_DEPENDENCIES.md` and the script's
        // header comment.
        dns_queue_stability: dnsQueueStability,

        // Cloaking blind-spot rate (Wave 3, rec 4). walls_observed /
        // fetched_ok over the analyzed lookalike population, plus the
        // per-family breakdown. A rising wall_rate_pct means more
        // lookalikes are hiding their payload behind an anti-bot wall
        // that the plain-HTTP fetcher can't see through. cachedValue-
        // wrapped (diag.page_analysis.cloaking, 600s); the full scan is
        // safe only because lookalike_domains is a small bounded table.
        //
        // Also carries the Lane 3 shadow-mode telemetry (migration 0264):
        // `by_fetch_outcome[]` (the denominator breakdown `fetched_ok`
        // never had), `ai_build.*` (Class A/B/C firing rates, Class A cap
        // hits, and the counterfactual escalations Class A would have
        // caused), `exfil.*` (sink host mix + distinct bot/webhook ids —
        // the kit-clustering pivot) and `generator.by_token[]` (builder
        // mix, weight 0). ai_build and exfil are STRUCTURALLY SEPARATE on
        // purpose: different evidence classes, different authority.
        // Every percentage carries its raw `n`; no rate is actionable
        // below n = 30.
        page_analysis: pageAnalysis,

        // Weaponization velocity distribution (Wave 3, rec 5). Counts of
        // threats per registration→first-live band from the STORED
        // threats.weaponization_flag column (migration 0259), NULL mapped
        // to `not_computable` (kept distinct from `normal`). Computed by
        // Navigator twice a day (UTC 05/17) in bounded rowid chunks and
        // stored in KV (lib/velocity-diag.ts); this request only reads it,
        // so the block can lag by up to ~12h.
        //
        // `velocity.coverage` (VELOCITY_DARK_2026-09) splits the NULL bucket
        // into "no registration date" (inherently not computable — the
        // permanent floor) vs `unstamped_candidates` (rows that DO carry a
        // registration date but the admin-dispatched writer hasn't swept).
        // `stamped_pct_of_candidates === 0` means the backfill has never run
        // — the signal that was invisible while `by_flag` alone conflated
        // the two states. Same single scan; no extra COUNT(*) passes.
        velocity: velocity,

        // nrd_domains tiered retention (lib/nrd-retention.ts: 30 days hot,
        // brand_matched rows kept, every row archived to the NRD_ARCHIVE R2
        // bucket by the feed), read ONLY from its KV last-result stamp — no
        // D1 reads. The phantom matcher's cursor is clamped AT the 30-day age
        // cutoff (it never extends retention): `phantom_hold_clamped: true` =
        // the manual matcher has not run incrementally within 30 days (or
        // ever), so the rows being purged were never scanned by it (in R2
        // unless ingested before 2026-10-05). Only a stuck lookalike matcher
        // can extend retention (to ≤ 37 days, `held_by_lookalike_matcher`).
        nrd_retention: nrdRetention,

        // Hosted DMARC aggregate reporting (lib/dmarc-enrollment.ts).
        // reports_24h = stored reports (verified_reports_24h of them from a
        // known, authenticated reporter); dropped_* = never stored, never
        // notified; dropped_24h splits every reason incl. ineligible_brand,
        // rate_limited, duplicate, unparseable and error (receiver threw).
        // rollup_pending = stored reports whose source rollup has not landed
        // (Navigator catches up ≤3 per tick).
        dmarc_ingest: dmarcIngest,

        // Per-store database health (sizes, growth, reads/writes, overloads,
        // top tables / jobs) — same payload as GET /api/internal/databases
        // with window=24h. null (+ databases_error) if it failed outright.
        databases,

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
            // null (not 0) when the paused read failed — see paused_error.
            paused_count: pausedAgents.paused_error === null ? pausedAgents.paused.length : null,
          },
          per_agent: agentMeshMerged,
          stalled: stalled.results,
          // agent_configs.enabled = 0 — tripped breakers
          // (paused_reason 'auto:consecutive_failures') and manual pauses.
          // A paused agent writes no agent_runs rows, so it is absent from
          // per_agent; this is the only place it shows up.
          paused: pausedAgents.paused,
          ...(pausedAgents.paused_error !== null ? { paused_error: pausedAgents.paused_error } : {}),
        },

        cron_health: cronHealth.results,

        backlog_trends: backlogTrends,

        ai_spend_24h: {
          total_cost_usd: aiSpend.results.reduce((s, a) => s + (a.cost_usd ?? 0), 0),
          total_calls: aiSpend.results.reduce((s, a) => s + a.calls, 0),
          by_agent: aiSpend.results,
        },

        // Is AI actually WORKING — distinct from ai_spend_24h, which only
        // says what it cost. Read these three together:
        //
        //   hours_since_last_call  hours since the newest budget_ledger
        //                          row, i.e. the last SUCCESSFUL call.
        //                          null = the ledger is empty.
        //   per_agent[].attempted  real Anthropic round-trips. Excludes
        //                          deliberate skips (budget throttle /
        //                          per-agent cap), which land in
        //                          `skipped` instead.
        //   per_agent[].succeeded  of those, how many came back usable.
        //
        // attempted = 0 across the board + a silent ledger = a quiet
        // platform, which is fine. attempted > 0 with succeeded = 0 is an
        // OUTAGE — agents are falling through to rule-based paths while
        // reporting work done. `agents_all_failing` is that set
        // pre-computed; non-empty means Flight Control should also have
        // raised platform_ai_calls_failing. `first_error` carries the
        // HTTP status (400 = unpaid Anthropic balance, 401 = bad key,
        // 429 = rate limit).
        //
        // Only agents instrumented with the strictly-API counters appear
        // in per_agent (analyst, sentinel today). An absent agent means
        // "not instrumented", NOT "healthy".
        ai_health: {
          last_ledger_row_at: aiLedgerLast?.last_at ?? null,
          hours_since_last_call: aiLedgerLast?.last_at
            ? Math.round(
                ((Date.now() - Date.parse(aiLedgerLast.last_at.replace(' ', 'T') + 'Z')) / 3_600_000) * 10,
              ) / 10
            : null,
          window_hours: hoursBack,
          per_agent: aiCallHealth.results.map((r) => {
            const { newest_failure: _packed, ...rest } = r;
            const f = parseNewestFailure(r.newest_failure);
            return { ...rest, first_failure_kind: f.kind, first_error: f.error };
          }),
          agents_all_failing: aiCallHealth.results
            .filter((r) => r.attempted > 0 && r.succeeded === 0)
            .map((r) => r.agent_id),
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
        geoip_db: await soft<Awaited<ReturnType<typeof import('../lib/geoip-mmdb').getGeoMmdbStatus>> | null>(
          "geoip_db", null, async () => {
            const { getGeoMmdbStatus } = await import('../lib/geoip-mmdb');
            return getGeoMmdbStatus(env);
          })(),

        // FC tick phase timings — pulled from the most recent
        // flight_control diagnostic snapshot. Used to investigate
        // which step dominates the FC duration (currently ~4 min
        // post-#948; target <60s).
        fc_tick_timings: await getFcTickTimings(env),

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
        // per_database rows carry additive `name` / `store` labels
        // (lib/db-registry.ts storeForDatabaseId; null = not a bound DB).
        d1_billing_cycle: d1BillingCycle
          ? { ...d1BillingCycle, per_database: labelPerDatabase(d1BillingCycle.per_database) }
          : d1BillingCycle,

        // PR-AM: per-database read/write activity over the requested
        // window (defaults to 6h, capped at 168h via `hours` query
        // param). Lets the operator see whether a recent fix to a
        // specific worker has actually reduced its load, without
        // waiting for the cycle aggregate to update.
        d1_recent_window: d1Recent
          ? { ...d1Recent, per_database: labelPerDatabase(d1Recent.per_database) }
          : d1Recent,

        // Per-endpoint D1 read attribution from Workers Analytics Engine.
        // Reads from the trust_radar_d1_reads dataset that opt-in handlers
        // populate via lib/analytics.ts.
        d1_attribution_24h: d1Attribution,

        // Per-UTC-hour account-wide D1 rows read/written (unsampled
        // d1AnalyticsAdaptiveGroups, summed across every database, with a
        // per_database split), oldest hour first, current partial hour
        // included. Window = the `hours` param, capped at 48.
        d1_hourly: d1Hourly.hours.map((h) => ({ ...h, per_database: labelPerDatabase(h.per_database) })),
        d1_hourly_error: d1Hourly.error ?? (d1Hourly.setup_required ? "CF_API_TOKEN / CF_ACCOUNT_ID not set" : null),

        // Same hours (same labels, same buckets), top per-job AE endpoints
        // (lib/d1-meter.ts): which `agent:` / `cron:` / `workflow:` owns each
        // hour's reads. Meter layers are exclusive, so the rows are disjoint
        // and summable; `cron:` / `cron:…:bg` is non-agent work only.
        d1_attribution_hourly: d1HourlyAttribution,

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
        // Read this before trusting a single row (and the write view below).
        d1_top_queries_note: D1_TOP_QUERIES_SAMPLING_NOTE,

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

        // `<section>_error` for every section whose read failed (endpoint
        // version 17). The section itself is still present, at its empty /
        // zero / null fallback, so one bad read no longer 500s the whole
        // response. Absent keys = that section read cleanly.
        ...sectionErrors,
      },
    }, 200, origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ success: false, error: message }, 500, origin);
  }
}
