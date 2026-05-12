// agent_runs Orphan Reaper — per-agent thresholds.
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
// a final status, downstream metrics (avg_duration_ms,
// last_completed_at) drift, and a chronically-killed agent stays
// invisible to FC's stall-recovery path.
//
// Threshold policy: per-agent. Earlier versions used a flat 90-min
// constant — fine for sentinel (75) / enricher (60) / curator (~7)
// but disastrous for NEXUS (declares stallThresholdMinutes=360 to
// support the 6-hour ASN-correlation Workflow) and auto-seeder /
// geoip-refresh (12,100 min). Live diagnostics 2026-05-12 03:10 UTC
// showed NEXUS with 4 runs, 0 success, 2 failed + 2 killed, all
// stamped by the 90-min reaper.
//
// Threshold is derived from each agent module's declared
// `stallThresholdMinutes` PLUS a 30-min buffer to absorb legitimate
// slow ticks without false-positive reaps. Agents not in the module
// registry (or with no declared threshold) fall back to
// DEFAULT_REAP_AGE_MINUTES = 90 — matches the prior behavior.
//
// Implementation: SELECT candidate rows (status='partial' AND
// completed_at IS NULL AND older than the GLOBAL minimum threshold
// = 15 min as a coarse pre-filter), then in JS compute the
// per-agent ceiling and UPDATE only the rows that exceed their
// agent's own threshold. The pre-filter keeps the SELECT cheap
// (anything younger than 15 min is alive by definition); the
// per-row UPDATE only fires for true zombies (typically 0-3 rows
// at a time).
//
// Tested via `test/agent-runs-reaper.test.ts`.

import type { Env } from "../types";

/** Default reap age when an agent isn't in the module registry. */
export const DEFAULT_REAP_AGE_MINUTES = 90;

/** Buffer added to each agent's declared stallThresholdMinutes. */
export const REAP_BUFFER_MINUTES = 30;

/**
 * Coarse pre-filter — any row younger than this is definitely alive
 * (faster than the shortest-declared stallThresholdMinutes + buffer)
 * and we skip it in SQL without a per-row check. 15 min sits below
 * the shortest agent threshold (5 min + 30 buffer = 35), so this
 * never under-reaps.
 */
const PRE_FILTER_MINUTES = 15;

interface CandidateRow {
  id: string;
  agent_id: string;
  started_at: string;
  age_minutes: number;
}

/** Build the per-agent threshold map from the agent module registry. */
async function loadAgentThresholds(): Promise<Record<string, number>> {
  // Lazy import — keeps lib/ free of any top-level dependency on
  // agents/ (which transitively imports a lot). The reaper only
  // fires every navigator tick (5 min), so the import cost is
  // amortized to near-zero.
  try {
    const { agentModules } = await import("../agents");
    const out: Record<string, number> = {};
    for (const [agentId, mod] of Object.entries(agentModules)) {
      const t = (mod as { stallThresholdMinutes?: number }).stallThresholdMinutes;
      if (typeof t === "number" && t > 0) out[agentId] = t;
    }
    return out;
  } catch {
    // Module registry failed to load — fall back to flat default
    // for every row. Keeps the reaper functional even if the
    // registry has a syntax/import problem at deploy time.
    return {};
  }
}

/** Compute the reap age (in minutes) for a given agent. */
function reapAgeFor(agentId: string, thresholds: Record<string, number>): number {
  const declared = thresholds[agentId];
  if (typeof declared === "number") {
    return declared + REAP_BUFFER_MINUTES;
  }
  return DEFAULT_REAP_AGE_MINUTES;
}

/** Returns the number of rows reaped. Never throws. */
export async function reapOrphanAgentRuns(env: Env): Promise<number> {
  try {
    const thresholds = await loadAgentThresholds();

    // Pre-filter in SQL — anything younger than PRE_FILTER_MINUTES
    // is alive by definition (shortest declared agent threshold is
    // 5 min, plus the 30-min buffer = 35 min, which is > 15). The
    // datetime() wrapper on both sides defends against the
    // ISO-vs-sqlite-format string-comparison footgun (see
    // feed-pull-reaper.ts for the bug receipts).
    const candidates = await env.DB.prepare(
      `SELECT id, agent_id, started_at,
              CAST((julianday('now') - julianday(started_at)) * 1440 AS INTEGER) AS age_minutes
         FROM agent_runs
        WHERE status = 'partial'
          AND completed_at IS NULL
          AND datetime(started_at) <= datetime('now', '-${PRE_FILTER_MINUTES} minutes')`,
    ).all<CandidateRow>();

    if (candidates.results.length === 0) return 0;

    let reaped = 0;
    for (const row of candidates.results) {
      const ceiling = reapAgeFor(row.agent_id, thresholds);
      if (row.age_minutes < ceiling) continue;

      try {
        // Stamp `duration_ms` from started_at so downstream metrics
        // (avg_duration_ms in the diagnostic) don't keep treating
        // this row as still-running. julianday() returns days since
        // the Julian epoch as a REAL; ×86400000 converts to ms.
        const result = await env.DB.prepare(
          `UPDATE agent_runs
              SET status = 'failed',
                  completed_at = datetime('now'),
                  error_message = COALESCE(
                    error_message,
                    'reaped by navigator: agent run stuck partial > ' || ? || 'min (per-agent ceiling) — worker likely terminated mid-run'
                  ),
                  duration_ms = COALESCE(
                    duration_ms,
                    CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
                  )
            WHERE id = ?
              AND status = 'partial'
              AND completed_at IS NULL`,
        ).bind(ceiling, row.id).run();
        if ((result.meta?.changes ?? 0) > 0) reaped++;
      } catch (err) {
        // Per-row failure shouldn't abort the whole sweep. Log and
        // continue — the next navigator tick will retry.
        console.error("[agent-runs-reaper] per-row update failed:", row.id, err);
      }
    }

    return reaped;
  } catch (err) {
    console.error("[agent-runs-reaper] orphan reap failed:", err);
    return 0;
  }
}
