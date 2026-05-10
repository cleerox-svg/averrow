// agent_runs Orphan Reaper
//
// `agentRunner.executeAgent` inserts an `agent_runs` row with
// `status='partial'` before invoking the agent's execute(), then
// flips it to 'success' or 'failed' inside a try/catch. If the worker
// is killed mid-run — CPU ceiling, subrequest ceiling, wall-clock
// timeout — the JS try/catch never resolves, the row stays at
// `partial` with `completed_at IS NULL` forever.
//
// The diagnostic endpoint already SURFACES these as `killed_runs`
// (status='partial' AND completed_at IS NULL after the stall window)
// but doesn't act on them. Without a reaper, dead rows never receive
// a final status and the agent's circuit-breaker counter doesn't
// advance — so a chronically-killed agent can stay invisible to the
// stall recovery path.
//
// Mirrors `feed-pull-reaper.ts` line for line — same architectural
// pattern: navigator runs every 5 min, owns the sweep, never throws,
// returns row count for diagnostic surfaces.
//
// Threshold: 90 min. NOT 15 min like feed-pull-reaper — agents
// declare longer legitimate runtimes than feed pulls do:
//   - sentinel.stallThresholdMinutes:  75
//   - enricher.stallThresholdMinutes:  60   (12-min domain_geo loop
//                                            + brand_logo_hq +
//                                            brand_sector_rdap +
//                                            brand_firmographic)
//   - curator: ~7 min observed legit
// 90 min sits 15 min above the longest declared stall threshold,
// so anything still 'partial' past it is unambiguously dead.
//
// (The first cut at this reaper used 15 min and started reaping
// legitimate enricher / sentinel / curator runs the moment it
// shipped — the dashboard saw a sudden spike of "failed" runs
// across ~5 agents within an hour of deploy. This is the correction.)
//
// Tested via `test/agent-runs-reaper.test.ts`.

import type { Env } from "../types";

/** Minimum age for a partial agent_runs row to be considered orphaned. */
export const REAP_AGE_MINUTES = 90;

/** Returns the number of rows reaped. Never throws. */
export async function reapOrphanAgentRuns(env: Env): Promise<number> {
  try {
    // Both sides of the comparison MUST go through `datetime()` so
    // the engine compares parsed timestamps, not raw strings.
    // agentRunner inserts started_at via SQLite's `datetime('now')`
    // ("YYYY-MM-DD HH:MM:SS") today, but the reaper still wraps the
    // LHS in datetime() to stay safe against any future ISO-format
    // writer (the equivalent bug bit feed-pull-reaper in production
    // — see the comment in feed-pull-reaper.ts for the receipts).
    //
    // We also stamp `duration_ms` on the way out so downstream
    // metrics (avg_duration_ms in the diagnostic) don't keep
    // dragging on the agent's reputation as if it were still
    // running. julianday() returns days since the Julian epoch as a
    // REAL; multiplying by 86400000 converts to milliseconds.
    const result = await env.DB.prepare(
      `UPDATE agent_runs
          SET status = 'failed',
              completed_at = datetime('now'),
              error_message = COALESCE(
                error_message,
                'reaped by navigator: agent run stuck partial > ${REAP_AGE_MINUTES}min — worker likely terminated mid-run'
              ),
              duration_ms = COALESCE(
                duration_ms,
                CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
              )
        WHERE status = 'partial'
          AND completed_at IS NULL
          AND datetime(started_at) <= datetime('now', '-${REAP_AGE_MINUTES} minutes')`,
    ).run();
    return result.meta?.changes ?? 0;
  } catch (err) {
    console.error("[agent-runs-reaper] orphan reap failed:", err);
    return 0;
  }
}
