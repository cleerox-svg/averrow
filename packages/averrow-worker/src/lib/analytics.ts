// Workers Analytics Engine helper for per-endpoint D1 read attribution.
//
// Cheap high-cardinality counter — each instrumented handler calls
// recordD1Reads at the end of a request with the total rows_read it
// observed across its D1 calls. Aggregates surface in
// platform-diagnostics's d1_metrics_24h block (queried via the AE SQL
// API) so we can see which endpoints are eating the rows-read budget.
//
// AE writeDataPoint shape:
//   blobs:   string dimensions (queryable, capped at ~96 chars)
//   doubles: numeric facts (rows_read, query_count, duration_ms)
//   indexes: a single high-cardinality dimension for sampling
//
// Failures are non-fatal — if AE isn't bound or write throws, the
// caller's response is unaffected.

import type { Env } from "../types";

export interface D1Tally {
  rowsRead: number;
  rowsWritten: number;
  queries: number;
}

/** Create an empty tally to accumulate per-request D1 stats. */
export function newTally(): D1Tally {
  return { rowsRead: 0, rowsWritten: 0, queries: 0 };
}

/** Add a D1 result's meta into the tally. Safe to call with undefined meta. */
export function addToTally(
  tally: D1Tally,
  meta: { rows_read?: number; rows_written?: number } | undefined,
): void {
  tally.queries += 1;
  tally.rowsRead += meta?.rows_read ?? 0;
  tally.rowsWritten += meta?.rows_written ?? 0;
}

/**
 * One store's share of a metered tally (lib/d1-meter.ts). `overloads` =
 * statements D1 rejected with its 10 s-window overload error
 * (lib/d1-retry.ts isD1OverloadError); `errors` = every other rejection.
 * Both are also counted in `queries` (a query is counted when issued).
 */
export interface StoreTally {
  rowsRead: number;
  rowsWritten: number;
  queries: number;
  overloads: number;
  errors: number;
}

/** Per-store breakdown, keyed by registry StoreId (lib/db-registry.ts). */
export type StoreBreakdown = Record<string, StoreTally>;

export function newStoreTally(): StoreTally {
  return { rowsRead: 0, rowsWritten: 0, queries: 0, overloads: 0, errors: 0 };
}

/**
 * Record a request's D1 attribution to Analytics Engine.
 * Endpoint should be a stable label (e.g. "darkweb_overview", not the
 * full URL) so aggregation keys stay tight.
 */
export function recordD1Reads(env: Env, endpoint: string, tally: D1Tally, stores?: StoreBreakdown): void {
  writeD1Attribution(env.AE, endpoint, tally, stores);
}

/**
 * Dataset-level form of recordD1Reads for callers whose env is not the
 * main `Env` (Workflow entrypoints with a narrower env type). Same point
 * shape, same non-fatal contract.
 *
 * Endpoint label conventions: handler labels (`observatory_nodes`, …),
 * `agent:<agent_id>` + `agent:<agent_id>:bg` (lib/agentRunner.ts
 * executeAgent / runSyncAgent — the run, and its post-return waitUntil tail
 * when it was given `_executionCtx`), `cron:<cron expression>` and
 * `cron:<expr>:bg` (cron/orchestrator.ts handleScheduled — non-agent work,
 * inline phase and post-return waitUntil tail), `feed:<feed_name>`
 * (lib/feedRunner.ts runFeed — one pull), and `workflow:<name>`
 * (src/workflows/*, one point per step; not geoip_refresh). The meter
 * layers are exclusive (lib/d1-meter.ts), so these per-job rows are
 * disjoint and can be summed.
 *
 * Point shape (v2, 2026-11 — per-store split):
 *   blob1   endpoint label (unchanged; index1 too)
 *   blob2   store id (`core` / `audit` / `geo` / `dnsq`), '' = not attributed
 *           (a record's ONLY point: handler tallies, or pre-v2 points), '-' =
 *           the unattributed remainder written AFTER store points (weight 0,
 *           so the '' → 1 reader rule can never count a record twice)
 *           to a store (handler tallies, or pre-v2 points)
 *   double1 rows_read, double2 rows_written, double3 queries (unchanged
 *           meaning — summed per endpoint over the store points they equal
 *           the old single point, so `SUM(...) GROUP BY blob1` is unchanged)
 *   double4 overloads, double5 other D1 errors (0 on pre-v2 points)
 *   double6 record weight: 1 on the FIRST point of a record, 0 on the extra
 *           store points. A "request/run count" is SUM(_sample_interval) on
 *           blob2 '' points (always a record's only point; pre-v2 points have
 *           blob2 '' and no double6) plus SUM(_sample_interval * double6) on
 *           every other store, never a bare point count — a run touching two
 *           stores writes two points. Group by blob2 and fold in code
 *           (handlers/diagnostics.ts foldAeRecordCount): AE SQL answered 422
 *           to the `if(blob2 = '', 1, double6)` form.
 *
 * With a store breakdown, one point is written per store with queries > 0,
 * plus a '-' point for any remainder of the total not covered by a store
 * (only possible for a hand-built tally). With nothing to write (no
 * queries at all) a single '' point keeps the record count.
 */
export function writeD1Attribution(
  ae: AnalyticsEngineDataset | undefined,
  endpoint: string,
  tally: D1Tally,
  stores?: StoreBreakdown,
): void {
  if (!ae) return;
  try {
    for (const p of d1AttributionPoints(endpoint, tally, stores)) ae.writeDataPoint(p);
  } catch {
    /* AE failures are non-fatal — the response is the priority */
  }
}

/** blob2 of an unattributed remainder point that follows store points. */
export const D1_UNATTRIBUTED_REMAINDER = "-";

/** The AE points writeD1Attribution writes (pure; exported for tests). */
export function d1AttributionPoints(
  endpoint: string,
  tally: D1Tally,
  stores?: StoreBreakdown,
): AnalyticsEngineDataPoint[] {
  const points: AnalyticsEngineDataPoint[] = [];
  const rest = { ...tally };
  const push = (store: string, t: StoreTally): void => {
    points.push({
      blobs: [endpoint, store],
      doubles: [t.rowsRead, t.rowsWritten, t.queries, t.overloads, t.errors, points.length === 0 ? 1 : 0],
      indexes: [endpoint],
    });
  };
  for (const [store, t] of Object.entries(stores ?? {})) {
    if (!store || t.queries <= 0) continue;
    push(store, t);
    rest.rowsRead -= t.rowsRead;
    rest.rowsWritten -= t.rowsWritten;
    rest.queries -= t.queries;
  }
  const unattributed = stores?.[""];
  if (rest.queries > 0 || points.length === 0) {
    // '' only when it is the record's sole point; otherwise the sentinel '-'.
    push(points.length === 0 ? "" : D1_UNATTRIBUTED_REMAINDER, {
      rowsRead: Math.max(0, rest.rowsRead),
      rowsWritten: Math.max(0, rest.rowsWritten),
      queries: Math.max(0, rest.queries),
      overloads: unattributed?.overloads ?? 0,
      errors: unattributed?.errors ?? 0,
    });
  }
  return points;
}
