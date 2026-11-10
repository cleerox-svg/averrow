/**
 * Data access layer — agent_runs table.
 *
 * Replaces 6+ inline INSERT/UPDATE statements duplicated across individual agents.
 * All agent lifecycle management goes through these typed functions.
 */

import type { AgentRun, CompleteRunStats, Env } from "../types";
import { withTimeout } from "../lib/run-sequential";

// Re-export for consumers that import from db/agent-runs
export type { AgentRun, CompleteRunStats };

// ─── Lifecycle ────────────────────────────────────────────────────

/**
 * Create a new agent run record and return its ID.
 */
export async function createAgentRun(env: Env, agentId: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO agent_runs (id, agent_id, status, records_processed, outputs_generated, started_at) VALUES (?, ?, 'running', 0, 0, datetime('now'))"
  ).bind(id, agentId).run();
  return id;
}

/**
 * Mark a run as complete. Replaces 6+ inline UPDATE statements across agents.
 */
export async function completeAgentRun(
  env: Env,
  runId: string,
  stats: CompleteRunStats,
): Promise<void> {
  const status = stats.status ?? 'success';
  await env.DB.prepare(`
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
    runId,
  ).run();
}

export async function failAgentRun(
  env: Env,
  runId: string,
  errorMessage: string,
): Promise<void> {
  await env.DB.prepare(`
    UPDATE agent_runs SET
      status = 'failed',
      error_message = ?,
      completed_at = datetime('now'),
      duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
    WHERE id = ?
  `).bind(errorMessage, runId).run();
}

/**
 * Record mid-run progress on a still-open run (best-effort heartbeat for
 * long handler-dispatched writers). Guarded on `completed_at IS NULL` so a
 * late heartbeat can never reopen or overwrite a finalized row.
 */
export async function updateAgentRunProgress(
  env: Env,
  runId: string,
  recordsProcessed: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE agent_runs SET records_processed = ? WHERE id = ? AND completed_at IS NULL"
  ).bind(recordsProcessed, runId).run();
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
  runId: string,
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
        ? failAgentRun(env, runId, outcome.error_message)
        : completeAgentRun(env, runId, outcome.stats);
      await withTimeout(write, opts.attemptTimeoutMs ?? 0, "agent_runs finalize");
      return { ok: true };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: lastError };
}

// ─── Lookups ──────────────────────────────────────────────────────

export async function getLatestRun(env: Env, agentId: string): Promise<AgentRun | null> {
  return env.DB.prepare(
    "SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1"
  ).bind(agentId).first<AgentRun>();
}

export async function getRunById(env: Env, runId: string): Promise<AgentRun | null> {
  return env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?")
    .bind(runId)
    .first<AgentRun>();
}

export async function listRunsForAgent(
  env: Env,
  agentId: string,
  limit = 10,
): Promise<AgentRun[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?"
  ).bind(agentId, limit).all<AgentRun>();
  return rows.results ?? [];
}

// ─── Batch operations ────────────────────────────────────────────

/**
 * Insert multiple agent outputs in a single D1 batch.
 * Replaces per-output INSERT patterns in agents (sentinel, analyst, strategist).
 */
export async function batchInsertOutputs(
  env: Env,
  outputs: Array<{
    agent_id: string;
    run_id: string;
    output_type: string;
    content_json: string;
    brand_id?: string;
    threat_id?: string;
    campaign_id?: string;
  }>
): Promise<void> {
  if (outputs.length === 0) return;

  const stmts = outputs.map(o =>
    env.DB.prepare(
      `INSERT INTO agent_outputs (id, agent_id, run_id, output_type, content_json, brand_id, threat_id, campaign_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(
      crypto.randomUUID(),
      o.agent_id,
      o.run_id,
      o.output_type,
      o.content_json,
      o.brand_id ?? null,
      o.threat_id ?? null,
      o.campaign_id ?? null,
    )
  );

  await env.DB.batch(stmts);
}
