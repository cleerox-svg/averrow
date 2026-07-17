/**
 * Data access layer — agent_runs table.
 *
 * Replaces 6+ inline INSERT/UPDATE statements duplicated across individual agents.
 * All agent lifecycle management goes through these typed functions.
 */

import type { AgentRun, CompleteRunStats, Env } from "../types";

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
