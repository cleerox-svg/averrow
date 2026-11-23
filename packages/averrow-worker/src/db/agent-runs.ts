/**
 * Data access layer — agent_runs table.
 *
 * Replaces 6+ inline INSERT/UPDATE statements duplicated across individual agents.
 * All agent lifecycle management goes through these typed functions.
 */

import type { AgentRun, CompleteRunStats, Env } from "../types";
import { withTimeout } from "../lib/run-sequential";
import { resolveTelemetry, telemetryDbFor, type TelemetryRoute } from "../lib/db-route";
import { byDesc, historyParts, preferFinalizedRun, unionFirst, unionRows } from "../lib/telemetry-read";

// Re-export for consumers that import from db/agent-runs
export type { AgentRun, CompleteRunStats };

// ─── Lifecycle ────────────────────────────────────────────────────

/**
 * A run row plus the telemetry route it was inserted under (Track B1c). The
 * route is resolved ONCE in createAgentRun and every later write of the run
 * (heartbeat, finalize) goes to that same DB, so a `db_route:telemetry`
 * flip mid-run can never strand the row on the other database.
 */
export interface AgentRunHandle {
  id: string;
  route: TelemetryRoute;
}

function runDb(env: Env, run: AgentRunHandle): D1Database {
  return telemetryDbFor(env, run.route);
}

/**
 * The telemetry DB for a write that belongs to a run (its completion
 * agent_events / agent_activity_log row): the run's own route when there is
 * a handle, else the route resolved now (run bookkeeping failed to start).
 */
export async function telemetryDbForRun(env: Env, run: AgentRunHandle | null): Promise<D1Database> {
  return run ? telemetryDbFor(env, run.route) : (await resolveTelemetry(env)).db;
}

/**
 * Create a new agent run record (on the routed telemetry DB) and return its
 * handle. Pass the handle — not just the id — to every later write.
 */
export async function createAgentRun(env: Env, agentId: string): Promise<AgentRunHandle> {
  const id = crypto.randomUUID();
  const { route, db } = await resolveTelemetry(env);
  await db.prepare(
    "INSERT INTO agent_runs (id, agent_id, status, records_processed, outputs_generated, started_at) VALUES (?, ?, 'running', 0, 0, datetime('now'))"
  ).bind(id, agentId).run();
  return { id, route };
}

/**
 * Mark a run as complete. Replaces 6+ inline UPDATE statements across agents.
 */
export async function completeAgentRun(
  env: Env,
  run: AgentRunHandle,
  stats: CompleteRunStats,
): Promise<void> {
  const status = stats.status ?? 'success';
  await runDb(env, run).prepare(`
    UPDATE agent_runs SET
      status = ?,
      records_processed = ?,
      outputs_generated = ?,
      tokens_used = ?,
      error_message = ?,
      completed_at = datetime('now'),
      duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
    WHERE id = ?
  `).bind(
    status,
    stats.records_processed,
    stats.outputs_generated,
    stats.tokens_used ?? null,
    stats.error_message ?? null,
    run.id,
  ).run();
}

export async function failAgentRun(
  env: Env,
  run: AgentRunHandle,
  errorMessage: string,
): Promise<void> {
  await runDb(env, run).prepare(`
    UPDATE agent_runs SET
      status = 'failed',
      error_message = ?,
      completed_at = datetime('now'),
      duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
    WHERE id = ?
  `).bind(errorMessage, run.id).run();
}

/**
 * Record mid-run progress on a still-open run (best-effort heartbeat for
 * long handler-dispatched writers). Guarded on `completed_at IS NULL` so a
 * late heartbeat can never reopen or overwrite a finalized row.
 */
export async function updateAgentRunProgress(
  env: Env,
  run: AgentRunHandle,
  recordsProcessed: number,
): Promise<void> {
  await runDb(env, run).prepare(
    "UPDATE agent_runs SET records_processed = ? WHERE id = ? AND completed_at IS NULL"
  ).bind(recordsProcessed, run.id).run();
}

export type AgentRunFinalOutcome =
  | { kind: "complete"; stats: CompleteRunStats }
  | { kind: "failed"; error_message: string };

export interface FinalizeRetryOptions {
  /** Total attempts (default 3). */
  attempts?: number;
  /** Delay before each retry, ms (default [250, 1000]); last value repeats. */
  backoffMs?: readonly number[];
  /** Ceiling per attempt, ms (default none). A hung write counts as a failed attempt. */
  attemptTimeoutMs?: number;
}

/**
 * Finalize a run (complete or fail) with bounded retries. Handler-dispatched
 * writers (daily_snapshots, daily_briefing) used to make ONE finalize
 * attempt and only log a failure, so a transient D1 error right after a
 * heavy statement left the row 'running' forever — nothing else closes
 * those rows promptly. Returns true when a finalize write succeeded; never
 * throws (the last error is returned for the caller to log).
 */
export async function finalizeAgentRun(
  env: Env,
  run: AgentRunHandle,
  outcome: AgentRunFinalOutcome,
  opts: FinalizeRetryOptions = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoff = opts.backoffMs ?? [250, 1000];
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const delay = backoff[Math.min(i - 1, backoff.length - 1)] ?? 0;
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    try {
      const write = () => outcome.kind === "failed"
        ? failAgentRun(env, run, outcome.error_message)
        : completeAgentRun(env, run, outcome.stats);
      await withTimeout(write, opts.attemptTimeoutMs ?? 0, "agent_runs finalize");
      return { ok: true };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: lastError };
}

// ─── Lookups (union across telemetry + core during the cut-over) ──

export async function getLatestRun(env: Env, agentId: string): Promise<AgentRun | null> {
  const parts = await historyParts(env, "agent_runs");
  return unionFirst<AgentRun>(parts, (p) => ({
    sql: `SELECT * FROM agent_runs WHERE agent_id = ?/*split*/ ORDER BY started_at DESC LIMIT 1`,
    binds: [agentId],
  }), { key: (r) => r.id, prefer: preferFinalizedRun, sort: byDesc<AgentRun>("started_at") });
}

export async function getRunById(env: Env, runId: string): Promise<AgentRun | null> {
  const parts = await historyParts(env, "agent_runs");
  return unionFirst<AgentRun>(parts, () => ({
    sql: "SELECT * FROM agent_runs WHERE id = ?",
    binds: [runId],
  }), { key: (r) => r.id, prefer: preferFinalizedRun });
}

export async function listRunsForAgent(
  env: Env,
  agentId: string,
  limit = 10,
): Promise<AgentRun[]> {
  const parts = await historyParts(env, "agent_runs");
  return unionRows<AgentRun>(parts, (p) => ({
    sql: `SELECT * FROM agent_runs WHERE agent_id = ?/*split*/ ORDER BY started_at DESC LIMIT ?`,
    binds: [agentId, p.limit],
  }), { key: (r) => r.id, prefer: preferFinalizedRun, sort: byDesc<AgentRun>("started_at"), limit });
}
