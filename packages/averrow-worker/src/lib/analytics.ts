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
 * Record a request's D1 attribution to Analytics Engine.
 * Endpoint should be a stable label (e.g. "darkweb_overview", not the
 * full URL) so aggregation keys stay tight.
 */
export function recordD1Reads(env: Env, endpoint: string, tally: D1Tally): void {
  writeD1Attribution(env.AE, endpoint, tally);
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
 * inline phase and post-return waitUntil tail), and `workflow:<name>`
 * (src/workflows/*, one point per step; not geoip_refresh). The meter
 * layers are exclusive (lib/d1-meter.ts), so these per-job rows are
 * disjoint and can be summed.
 */
export function writeD1Attribution(
  ae: AnalyticsEngineDataset | undefined,
  endpoint: string,
  tally: D1Tally,
): void {
  if (!ae) return;
  try {
    ae.writeDataPoint({
      blobs: [endpoint],
      doubles: [tally.rowsRead, tally.rowsWritten, tally.queries],
      indexes: [endpoint],
    });
  } catch {
    /* AE failures are non-fatal — the response is the priority */
  }
}
