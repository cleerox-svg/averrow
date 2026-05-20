// Daily D1 read-budget soft-cap + billing-cycle tracker.
//
// Cloudflare's free-plan ceiling is 25B rows_read/month. Spread evenly
// that's ~833M/day. We keep 5% headroom and start skipping non-essential
// pre-warms once the rolling-24h read total crosses the SKIP threshold.
//
// Two orthogonal surfaces:
//   1. Daily soft-cap (this is the original purpose): rolling 24h reads
//      vs DAILY_BUDGET — drives Navigator's skip-non-essential decision.
//   2. Billing-cycle tracker (PR-X): cycle-to-date reads vs the 25B
//      monthly cap, where the cycle runs day 18 → day 17 of the next
//      month (Cloudflare's invoice window). Drives the "Billing-cycle
//      projection" meter on /admin/metrics and the platform-diagnostics
//      `billing_cycle` block. Sums across ALL D1 databases the account
//      bills against — not just the primary `DB` binding — because the
//      under-count we observed (778M/24h reported vs 4.98B/day actual
//      from the CF invoice) traced to the diagnostics fetcher filtering
//      on a single databaseId.
//
// The number that drives the decision comes from CF GraphQL's
// d1AnalyticsAdaptiveGroups (same endpoint platform-diagnostics uses).
// We poll it at most once an hour and stash the value in KV so the
// every-5-min Navigator ticks don't each pay a CF GraphQL round-trip.
//
// Failure modes:
//   - No CF token configured: we don't know — assume under budget (no
//     skip). The platform-diagnostics dashboard will still flag the
//     setup gap.
//   - GraphQL error / rate-limit: keep the previous KV value if any,
//     otherwise treat as unknown (no skip).
//   - KV miss: refresh on this tick.

import type { Env } from "../types";

/** Plan ceiling: 25B reads/month. */
const PLAN_CEILING_PER_MONTH = 25_000_000_000;

/**
 * D1 database id — same literal used in `handlers/diagnostics.ts`
 * and matches `database_id` in `wrangler.toml`. Hardcoded here too
 * because there's no `D1_DATABASE_ID` env var configured on the
 * worker (the binding is named `DB`); we need the literal to query
 * CF GraphQL by databaseId.
 */
const D1_DATABASE_ID = "a3776a5f-c07c-4e20-9f3b-8d7f8c7f90c6";

/** Daily budget (1/30 of the monthly ceiling). */
export const DAILY_BUDGET = Math.round(PLAN_CEILING_PER_MONTH / 30);

/** Pre-warm anything below 85% of daily budget. Above is the warning zone. */
export const WARN_THRESHOLD = Math.round(DAILY_BUDGET * 0.85);

/** Skip non-essential pre-warms above 95% of daily budget. */
export const SKIP_THRESHOLD = Math.round(DAILY_BUDGET * 0.95);

const KV_KEY = "d1_budget:rows_read_24h";
const KV_KEY_LAST_SKIP = "d1_budget:last_skip_at";
const KV_KEY_SKIP_COUNT_24H = "d1_budget:skip_count_24h";
/** Cached for 65 min so a single-tick failure doesn't blow the cache. */
const KV_TTL_SECONDS = 65 * 60;

interface BudgetState {
  /** Total D1 rows read in the last 24h. */
  rowsRead24h: number;
  /** When this value was fetched (epoch ms). */
  fetchedAtMs: number;
  /** True if we couldn't reach CF GraphQL — value comes from a previous tick. */
  stale: boolean;
}

interface CachedBudget {
  rowsRead24h: number;
  fetchedAtMs: number;
}

/**
 * Get the current 24h rows-read total. Re-fetches from CF GraphQL once
 * per hour; otherwise returns the cached value.
 */
export async function getBudgetState(env: Env): Promise<BudgetState | null> {
  const token = (env as unknown as Record<string, string | undefined>).CF_API_TOKEN;
  const accountId = (env as unknown as Record<string, string | undefined>).CF_ACCOUNT_ID;
  if (!token || !accountId) return null;
  const databaseId = D1_DATABASE_ID;

  const cachedRaw = await env.CACHE.get(KV_KEY);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as CachedBudget;
      // Refresh if older than 60 min — we don't want to drift more than
      // an hour behind reality, even if KV TTL hasn't expired yet.
      if (Date.now() - cached.fetchedAtMs < 60 * 60 * 1000) {
        return { rowsRead24h: cached.rowsRead24h, fetchedAtMs: cached.fetchedAtMs, stale: false };
      }
    } catch {
      // fall through and refresh
    }
  }

  const fresh = await fetchRowsRead24h(token, accountId, databaseId);
  if (fresh == null) {
    // CF GraphQL failed — fall back to the (stale) cached value if any.
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw) as CachedBudget;
        return { rowsRead24h: cached.rowsRead24h, fetchedAtMs: cached.fetchedAtMs, stale: true };
      } catch {
        return null;
      }
    }
    return null;
  }

  const state: CachedBudget = { rowsRead24h: fresh, fetchedAtMs: Date.now() };
  await env.CACHE.put(KV_KEY, JSON.stringify(state), { expirationTtl: KV_TTL_SECONDS });
  return { ...state, stale: false };
}

/** Returns true if non-essential pre-warms should be skipped this tick. */
export function shouldSkipNonEssentialWarms(state: BudgetState | null): boolean {
  if (!state) return false;
  return state.rowsRead24h >= SKIP_THRESHOLD;
}

/**
 * Record that Navigator just skipped a non-essential pre-warm tick.
 * Increments a 24h-windowed counter + bumps `last_skip_at` so the
 * diagnostics endpoint can prove the soft-cap is actually firing.
 *
 * Counter expires on a 24h KV TTL, so it self-resets after a day
 * of no skips. We don't try to atomically increment — KV doesn't
 * support that — so under heavy contention the count is approximate
 * (off by a few). Acceptable for a "is the cap working" signal.
 */
export async function recordNavigatorSkip(env: Env): Promise<void> {
  const now = Date.now();
  try {
    await env.CACHE.put(KV_KEY_LAST_SKIP, String(now), { expirationTtl: 7 * 24 * 60 * 60 });

    const prev = await env.CACHE.get(KV_KEY_SKIP_COUNT_24H);
    const prevCount = prev ? parseInt(prev, 10) || 0 : 0;
    await env.CACHE.put(KV_KEY_SKIP_COUNT_24H, String(prevCount + 1), {
      expirationTtl: 24 * 60 * 60,
    });
  } catch {
    // KV failure shouldn't kill the cron tick.
  }
}

/**
 * Diagnostics surface for the soft-cap. Returns everything the operator
 * needs to answer "is the cap working and how aggressively?"
 */
export interface BudgetDiagnostics {
  /** CF-reported rows_read in the last 24h. */
  rows_read_24h: number | null;
  /** When that value was fetched (ISO). */
  fetched_at: string | null;
  /** True when KV had a value but CF GraphQL is currently failing. */
  stale: boolean;
  /** Plain-language thresholds for the operator's mental model. */
  daily_budget: number;
  warn_threshold: number;
  skip_threshold: number;
  /** Where we sit relative to the budget. */
  pct_of_daily_budget: number | null;
  threshold_state: 'ok' | 'warn' | 'skip' | 'unknown';
  /** When Navigator last skipped a pre-warm (ISO), if ever. */
  last_skip_at: string | null;
  /** Approximate count of skipped ticks in the last 24h. */
  skip_count_24h: number;
}

export async function getBudgetDiagnostics(env: Env): Promise<BudgetDiagnostics> {
  const state = await getBudgetState(env);
  const lastSkipRaw = await env.CACHE.get(KV_KEY_LAST_SKIP).catch(() => null);
  const skipCountRaw = await env.CACHE.get(KV_KEY_SKIP_COUNT_24H).catch(() => null);

  const rowsRead = state?.rowsRead24h ?? null;
  const pct = rowsRead != null
    ? Math.round((rowsRead / DAILY_BUDGET) * 1000) / 10
    : null;

  let thresholdState: BudgetDiagnostics['threshold_state'] = 'unknown';
  if (rowsRead != null) {
    if (rowsRead >= SKIP_THRESHOLD) thresholdState = 'skip';
    else if (rowsRead >= WARN_THRESHOLD) thresholdState = 'warn';
    else thresholdState = 'ok';
  }

  return {
    rows_read_24h: rowsRead,
    fetched_at: state ? new Date(state.fetchedAtMs).toISOString() : null,
    stale: state?.stale ?? false,
    daily_budget: DAILY_BUDGET,
    warn_threshold: WARN_THRESHOLD,
    skip_threshold: SKIP_THRESHOLD,
    pct_of_daily_budget: pct,
    threshold_state: thresholdState,
    last_skip_at: lastSkipRaw ? new Date(parseInt(lastSkipRaw, 10)).toISOString() : null,
    skip_count_24h: skipCountRaw ? parseInt(skipCountRaw, 10) || 0 : 0,
  };
}

/** Per-query stat from CF d1QueriesAdaptiveGroups. */
export interface D1QueryStat {
  /** Stable hash CF assigns to the SQL text (after parameter normalization). */
  query_hash: string;
  /** Truncated sample of the SQL text. May be null when CF doesn't surface it. */
  query_sample: string | null;
  /** Database the query ran against. PR-Y added the dimension; queries
   *  predating the change carry `null`. UI maps known IDs to friendly
   *  names (trust-radar-v2 / AUDIT_DB / GEOIP_DB) and falls back to a
   *  truncated id for any other accounts-on-this-platform databases. */
  database_id: string | null;
  rows_read: number;
  rows_written: number;
  query_count: number;
  avg_rows_per_query: number;
}

/**
 * Top-N queries by rows_read in the last 24h. Hits CF's per-query
 * analytics endpoint (d1QueriesAdaptiveGroups) so we get visibility
 * even on uninstrumented endpoints. Complements our AE-based
 * recordD1Reads attribution which only covers handlers we've wired.
 */
export interface TopQueriesResult {
  /** Stats array; empty when no data (or when error is set). */
  queries: D1QueryStat[];
  /** Diagnostic message — surfaces what blocked the fetch when
   *  `queries` is empty, so the operator can debug from
   *  /api/internal/platform-diagnostics output without grepping logs. */
  error: string | null;
}

export async function fetchD1TopQueries(
  env: Env,
  limit = 20,
  sortBy: "reads" | "writes" = "reads",
): Promise<TopQueriesResult> {
  const token = (env as unknown as Record<string, string | undefined>).CF_API_TOKEN;
  const accountId = (env as unknown as Record<string, string | undefined>).CF_ACCOUNT_ID;
  if (!token || !accountId) {
    return { queries: [], error: "CF_API_TOKEN or CF_ACCOUNT_ID not configured" };
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // Cloudflare's per-query analytics dataset.
  //
  // PR-Y: dropped the `databaseId` filter so top queries reflect spend
  // across ALL D1 databases on the account, not just the primary
  // `DB` binding. Added `databaseId` to dimensions so each row tells
  // the operator which DB it came from. The previous single-DB filter
  // hid the dominant spender — one account-level DB outside this
  // worker's bindings was running ~70% of total cycle reads with no
  // visibility in the metrics UI.
  //
  // `sum.queries` from PR #864 doesn't exist — CF rejects with
  // `unknown field "queries"`. The query count is on the top-level
  // `count` field (number of analytics samples in the group).
  //
  // sortBy lets the operator pull either the read-spenders (default,
  // matches the existing d1_top_queries_24h consumer) or the
  // write-spenders (used by d1_top_write_queries_24h to drive the
  // write-budget audit alongside the existing read view).
  const orderField = sortBy === "writes" ? "sum_rowsWritten_DESC" : "sum_rowsRead_DESC";
  const query = `
    query {
      viewer {
        accounts(filter: { accountTag: "${accountId}" }) {
          d1QueriesAdaptiveGroups(
            filter: { datetimeHour_geq: "${since}" }
            orderBy: [${orderField}]
            limit: ${limit}
          ) {
            count
            sum {
              rowsRead
              rowsWritten
            }
            dimensions {
              query
              databaseId
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
      const body = await res.text().catch(() => "");
      return { queries: [], error: `CF GraphQL HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const json = (await res.json()) as {
      data?: {
        viewer?: {
          accounts?: Array<{
            d1QueriesAdaptiveGroups?: Array<{
              count: number;
              sum: { rowsRead: number; rowsWritten: number };
              dimensions: { query: string; databaseId?: string };
            }>;
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (json.errors?.length) {
      return {
        queries: [],
        error: json.errors.map((e) => e.message).slice(0, 3).join("; "),
      };
    }

    const groups = json.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? [];
    if (groups.length === 0) {
      return { queries: [], error: "CF returned 0 query groups (no d1QueriesAdaptiveGroups data?)" };
    }

    // avg_rows_per_query reflects the metric we sorted by so the
    // top-N view is internally consistent — writers see avg writes,
    // readers see avg reads.
    const queries = groups.map((g) => {
      const total = sortBy === "writes" ? g.sum.rowsWritten : g.sum.rowsRead;
      return {
        query_hash: g.dimensions.query,
        query_sample: g.dimensions.query,
        database_id: g.dimensions.databaseId ?? null,
        rows_read: g.sum.rowsRead,
        rows_written: g.sum.rowsWritten,
        query_count: g.count,
        avg_rows_per_query: g.count > 0 ? Math.round(total / g.count) : 0,
      };
    });
    return { queries, error: null };
  } catch (err) {
    return {
      queries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchRowsRead24h(token: string, accountId: string, databaseId: string): Promise<number | null> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const query = `
    query {
      viewer {
        accounts(filter: { accountTag: "${accountId}" }) {
          d1AnalyticsAdaptiveGroups(
            filter: { datetimeHour_geq: "${since}", databaseId: "${databaseId}" }
            limit: 1000
          ) {
            sum { rowsRead }
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
    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: {
        viewer?: {
          accounts?: Array<{
            d1AnalyticsAdaptiveGroups?: Array<{ sum: { rowsRead: number } }>;
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (json.errors?.length) return null;

    const groups = json.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
    return groups.reduce((acc, g) => acc + (g.sum?.rowsRead ?? 0), 0);
  } catch {
    return null;
  }
}

// ─── Billing-cycle tracker (PR-X) ────────────────────────────────────
//
// Cloudflare bills D1 reads on a monthly cycle that runs from the 18th
// of one month through the 17th of the next. The "Monthly projection"
// surface previously used a rolling-24h × 30 extrapolation against the
// 25B plan ceiling — which under-reported by ~6x because:
//   1. It filtered on a single databaseId (the primary `DB` binding)
//      and excluded `AUDIT_DB`, `GEOIP_DB` etc. that bill against the
//      same account ceiling.
//   2. The 24h × 30 projection lost intra-cycle context — operators
//      couldn't tell "are we ahead of pace or behind?" at day 27 of
//      the cycle vs day 3 of the next cycle.
// The billing-cycle helpers below replace that with the actual cycle
// window + actual cycle-to-date reads summed across all account
// databases.

/** Day of month that the Cloudflare billing cycle starts on. */
export const BILLING_CYCLE_START_DAY = 18;

export interface BillingCycleWindow {
  /** ISO timestamp at the start of the current cycle (00:00 UTC). */
  start: string;
  /** ISO timestamp at the end of the current cycle (23:59:59.999 UTC). */
  end: string;
  /** Whole days elapsed in the cycle as of `now` (0..days_total). */
  days_elapsed: number;
  /** Total days in the current cycle (typically 28-31 depending on month length). */
  days_total: number;
  /** `days_elapsed / days_total * 100`, rounded to 1dp. */
  pct_elapsed: number;
}

/**
 * Compute the current Cloudflare billing-cycle window relative to `now`.
 *
 * Cycle definition: starts at 00:00 UTC on day {@link BILLING_CYCLE_START_DAY}
 * of some month, ends at 23:59:59.999 UTC on day {BILLING_CYCLE_START_DAY-1}
 * of the next month. If today is on or after the 18th, the cycle started
 * this month; otherwise it started last month.
 */
export function computeBillingCycle(now: Date = new Date()): BillingCycleWindow {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  // Start of the current cycle.
  let startY = y;
  let startM = m;
  if (d < BILLING_CYCLE_START_DAY) {
    // We're before this month's anchor day — cycle started last month.
    startM = m - 1;
    if (startM < 0) {
      startM = 11;
      startY = y - 1;
    }
  }
  const start = new Date(Date.UTC(startY, startM, BILLING_CYCLE_START_DAY, 0, 0, 0, 0));

  // End: the day before the next anchor, 23:59:59.999.
  const end = new Date(Date.UTC(startY, startM + 1, BILLING_CYCLE_START_DAY, 0, 0, 0, 0));
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysTotal = Math.round((end.getTime() - start.getTime() + 1) / msPerDay);
  const daysElapsed = Math.min(
    daysTotal,
    Math.max(1, Math.floor((now.getTime() - start.getTime()) / msPerDay) + 1),
  );
  const pctElapsed = Math.round((daysElapsed / daysTotal) * 1000) / 10;

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    days_elapsed: daysElapsed,
    days_total: daysTotal,
    pct_elapsed: pctElapsed,
  };
}

/** Per-database usage in the current billing cycle. */
export interface D1DatabaseUsageRow {
  database_id: string;
  rows_read: number;
  rows_written: number;
  read_queries: number;
  write_queries: number;
}

export interface BillingCycleMetrics {
  cycle: BillingCycleWindow;
  /** Total rows_read across all D1 databases in the cycle so far. */
  rows_read_cycle: number;
  rows_written_cycle: number;
  read_queries_cycle: number;
  write_queries_cycle: number;
  /** Linear extrapolation of cycle reads to full cycle (assumes pace holds). */
  cycle_projection_rows_read: number;
  /** projection ÷ 25B × 100, rounded to 1dp. */
  pct_of_25b_plan_ceiling: number;
  /** Linear extrapolation of cycle writes to full cycle (assumes pace holds).
   *  Symmetric with cycle_projection_rows_read — added 2026-05-20 so the
   *  Phase 2 D1-write-budget review reminder (and any future write-spend
   *  callers) don't have to re-derive it from rows_written_cycle. */
  cycle_projection_rows_written: number;
  /** projection ÷ 50M × 100, rounded to 1dp. The Workers Paid plan
   *  includes 50M writes/month; anything over goes to $1/M overage. */
  pct_of_50m_write_quota: number;
  /** Per-database breakdown, ordered desc by rows_read. */
  per_database: D1DatabaseUsageRow[];
  setup_required: boolean;
  setup_instructions?: string;
  error?: string;
}

/** Plan ceiling: 25B rows_read/month. Re-exported for the diagnostics layer. */
export const BILLING_CYCLE_PLAN_CEILING = 25_000_000_000;

/** Workers Paid plan included write quota: 50M rows_written/month.
 *  Above this, writes are billed at $1/million. Used by the Phase 2
 *  D1-write-budget review reminder + any future write-spend callers. */
export const WRITES_INCLUDED_QUOTA = 50_000_000;

/**
 * Fetch billing-cycle D1 metrics summed across ALL D1 databases on the
 * account. Returns a setup_required stub if CF credentials are missing.
 *
 * Queries `d1AnalyticsAdaptiveGroups` with `dimensions { databaseId }`
 * so we get a per-database breakdown in one round-trip. The previous
 * implementation filtered on a single databaseId and missed account
 * databases like `AUDIT_DB` and `GEOIP_DB` — see header comment.
 */
export async function fetchBillingCycleMetrics(env: Env, now: Date = new Date()): Promise<BillingCycleMetrics> {
  const cycle = computeBillingCycle(now);
  const empty = (): BillingCycleMetrics => ({
    cycle,
    rows_read_cycle: 0,
    rows_written_cycle: 0,
    read_queries_cycle: 0,
    write_queries_cycle: 0,
    cycle_projection_rows_read: 0,
    pct_of_25b_plan_ceiling: 0,
    cycle_projection_rows_written: 0,
    pct_of_50m_write_quota: 0,
    per_database: [],
    setup_required: true,
  });

  const token = (env as unknown as Record<string, string | undefined>).CF_API_TOKEN;
  const accountId = (env as unknown as Record<string, string | undefined>).CF_ACCOUNT_ID;
  if (!token || !accountId) {
    return {
      ...empty(),
      setup_instructions:
        "Set CF_API_TOKEN (Account Analytics: Read) and CF_ACCOUNT_ID via " +
        "`wrangler secret put` to enable billing-cycle D1 tracking.",
    };
  }

  const query = `
    query {
      viewer {
        accounts(filter: { accountTag: "${accountId}" }) {
          d1AnalyticsAdaptiveGroups(
            filter: { datetimeHour_geq: "${cycle.start}", datetimeHour_lt: "${cycle.end}" }
            limit: 10000
          ) {
            sum {
              rowsRead
              rowsWritten
              readQueries
              writeQueries
            }
            dimensions {
              databaseId
            }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ...empty(), setup_required: false, error: `CF GraphQL HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const parsed = (await res.json()) as {
      data?: {
        viewer?: {
          accounts?: Array<{
            d1AnalyticsAdaptiveGroups?: Array<{
              sum: { rowsRead: number; rowsWritten: number; readQueries: number; writeQueries: number };
              dimensions: { databaseId: string };
            }>;
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (parsed.errors?.length) {
      return { ...empty(), setup_required: false, error: parsed.errors.map((e) => e.message).slice(0, 3).join("; ") };
    }
    const groups = parsed.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];

    // Aggregate per databaseId — the adaptive groups roll up by hour AND
    // by databaseId, so multiple hourly rows can share a databaseId.
    const perDb = new Map<string, D1DatabaseUsageRow>();
    for (const g of groups) {
      const dbId = g.dimensions.databaseId;
      const cur = perDb.get(dbId) ?? {
        database_id: dbId,
        rows_read: 0,
        rows_written: 0,
        read_queries: 0,
        write_queries: 0,
      };
      cur.rows_read += g.sum.rowsRead ?? 0;
      cur.rows_written += g.sum.rowsWritten ?? 0;
      cur.read_queries += g.sum.readQueries ?? 0;
      cur.write_queries += g.sum.writeQueries ?? 0;
      perDb.set(dbId, cur);
    }
    const perDatabase = Array.from(perDb.values()).sort((a, b) => b.rows_read - a.rows_read);

    const rowsReadCycle = perDatabase.reduce((s, d) => s + d.rows_read, 0);
    const rowsWrittenCycle = perDatabase.reduce((s, d) => s + d.rows_written, 0);
    const readQueriesCycle = perDatabase.reduce((s, d) => s + d.read_queries, 0);
    const writeQueriesCycle = perDatabase.reduce((s, d) => s + d.write_queries, 0);

    const pctElapsedFraction = cycle.days_elapsed / cycle.days_total;
    const cycleProjection = pctElapsedFraction > 0
      ? Math.round(rowsReadCycle / pctElapsedFraction)
      : rowsReadCycle;
    const pctOfCeiling = Math.round((cycleProjection / BILLING_CYCLE_PLAN_CEILING) * 1000) / 10;

    // Same linear-extrapolation pattern for writes. Symmetric with
    // reads — needed for the Phase 2 D1-write-budget review reminder
    // and any future write-spend callers.
    const cycleProjectionWrites = pctElapsedFraction > 0
      ? Math.round(rowsWrittenCycle / pctElapsedFraction)
      : rowsWrittenCycle;
    const pctOfWriteQuota = Math.round((cycleProjectionWrites / WRITES_INCLUDED_QUOTA) * 1000) / 10;

    return {
      cycle,
      rows_read_cycle: rowsReadCycle,
      rows_written_cycle: rowsWrittenCycle,
      read_queries_cycle: readQueriesCycle,
      write_queries_cycle: writeQueriesCycle,
      cycle_projection_rows_read: cycleProjection,
      pct_of_25b_plan_ceiling: pctOfCeiling,
      cycle_projection_rows_written: cycleProjectionWrites,
      pct_of_50m_write_quota: pctOfWriteQuota,
      per_database: perDatabase,
      setup_required: false,
    };
  } catch (err) {
    return { ...empty(), setup_required: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Arbitrary-window per-DB metrics (PR-AM) ─────────────────────
//
// Same shape as fetchBillingCycleMetrics but over a caller-specified
// hours window. Used to expose recent (e.g. 12h or 24h) per-database
// activity in the platform-diagnostics endpoint, so operators can see
// whether a recent change to a specific worker's spend has taken
// effect without waiting for the cycle aggregate to update.

export interface RecentWindowMetrics {
  window_hours:     number;
  start:            string;
  end:              string;
  rows_read:        number;
  rows_written:     number;
  read_queries:     number;
  write_queries:    number;
  per_database:     D1DatabaseUsageRow[];
  setup_required:   boolean;
  setup_instructions?: string;
  error?:           string;
}

export async function fetchRecentWindowMetrics(
  env: Env,
  hoursBack: number = 12,
  now: Date = new Date(),
): Promise<RecentWindowMetrics> {
  const start = new Date(now.getTime() - hoursBack * 60 * 60 * 1000).toISOString();
  const end = now.toISOString();
  const empty = (): RecentWindowMetrics => ({
    window_hours: hoursBack,
    start,
    end,
    rows_read: 0,
    rows_written: 0,
    read_queries: 0,
    write_queries: 0,
    per_database: [],
    setup_required: true,
  });

  const token = (env as unknown as Record<string, string | undefined>).CF_API_TOKEN;
  const accountId = (env as unknown as Record<string, string | undefined>).CF_ACCOUNT_ID;
  if (!token || !accountId) {
    return {
      ...empty(),
      setup_instructions: "Set CF_API_TOKEN + CF_ACCOUNT_ID to enable.",
    };
  }

  const query = `
    query {
      viewer {
        accounts(filter: { accountTag: "${accountId}" }) {
          d1AnalyticsAdaptiveGroups(
            filter: { datetimeHour_geq: "${start}", datetimeHour_lt: "${end}" }
            limit: 10000
          ) {
            sum { rowsRead rowsWritten readQueries writeQueries }
            dimensions { databaseId }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ...empty(), setup_required: false, error: `CF GraphQL HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const parsed = (await res.json()) as {
      data?: {
        viewer?: {
          accounts?: Array<{
            d1AnalyticsAdaptiveGroups?: Array<{
              sum: { rowsRead: number; rowsWritten: number; readQueries: number; writeQueries: number };
              dimensions: { databaseId: string };
            }>;
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (parsed.errors?.length) {
      return { ...empty(), setup_required: false, error: parsed.errors.map((e) => e.message).slice(0, 3).join("; ") };
    }
    const groups = parsed.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];

    const perDb = new Map<string, D1DatabaseUsageRow>();
    for (const g of groups) {
      const dbId = g.dimensions.databaseId;
      const cur = perDb.get(dbId) ?? { database_id: dbId, rows_read: 0, rows_written: 0, read_queries: 0, write_queries: 0 };
      cur.rows_read += g.sum.rowsRead ?? 0;
      cur.rows_written += g.sum.rowsWritten ?? 0;
      cur.read_queries += g.sum.readQueries ?? 0;
      cur.write_queries += g.sum.writeQueries ?? 0;
      perDb.set(dbId, cur);
    }
    const perDatabase = Array.from(perDb.values()).sort((a, b) => b.rows_read - a.rows_read);

    return {
      window_hours: hoursBack,
      start,
      end,
      rows_read:     perDatabase.reduce((s, d) => s + d.rows_read, 0),
      rows_written:  perDatabase.reduce((s, d) => s + d.rows_written, 0),
      read_queries:  perDatabase.reduce((s, d) => s + d.read_queries, 0),
      write_queries: perDatabase.reduce((s, d) => s + d.write_queries, 0),
      per_database:  perDatabase,
      setup_required: false,
    };
  } catch (err) {
    return { ...empty(), setup_required: false, error: err instanceof Error ? err.message : String(err) };
  }
}
