/**
 * Workflow-agent stats reconciliation.
 *
 * Workflow-dispatched agents (currently nexus, future cartographer post
 * the PR-O cron cutover) write their lifecycle events to
 * `agent_activity_log` not `agent_runs`. Any UI / API surface that
 * reads agent_runs to determine an agent's health gets the wrong
 * answer for these agents — see PR-J for the original diagnosis and
 * the diagnostics-endpoint fix.
 *
 * This helper centralizes the workflow-event rollup so every consumer
 * can apply the same reconciliation:
 *
 *   handlers/agents.ts handleListAgents          (Agents grid)
 *   handlers/agents.ts handleGetAgent             (Agent detail)
 *   handlers/agents.ts handleAgentHealth          (Health endpoint)
 *   handlers/agents.ts handleAgentRuns            (Runs feed)
 *   agents/flightControl.ts getAgentHealth        (stall detection +
 *                                                  platform_agent_stalled
 *                                                  notification gate)
 *   handlers/diagnostics.ts agent_mesh.per_agent  (already done in PR-J;
 *                                                  inlines the same shape)
 *
 * Usage: call once per request and pass the resulting Map down to
 * row-builders / status-derivers. The query is bounded by the 24h
 * window so it stays cheap (agent_activity_log is small + indexed
 * on (agent_id, created_at DESC)).
 */

export interface WorkflowAgentStats {
  agent_id:           string;
  /** Count of workflow_dispatched events (each ≈ one logical run). */
  dispatched:         number;
  /** Count of batch_complete events (the workflow body's success
   *  marker). Lags `dispatched` by the workflow's wall time. */
  completed:          number;
  /** Count of workflow_dispatch_failed events — Workflows-platform
   *  failures (CF outage, binding misconfig, WorkflowInternalError). */
  dispatch_failed:    number;
  /** Count of workflow_cooldown_skip events — PR-A's cooldown
   *  short-circuiting due to a recent platform error. */
  cooldown_skipped:   number;
  /** ISO timestamp of the most recent batch_complete event. */
  last_completed_at:  string | null;
  /** ISO timestamp of the most recent workflow_dispatch_failed. */
  last_failure_at:    string | null;
  /** Most recent failure message (truncated) — for last_run_error. */
  last_error:         string | null;
  /** Most recent event of any kind in the 24h window — for staleness
   *  / status-derivation. */
  last_event_at:      string | null;
}

export async function getWorkflowAgentStats(
  db: D1Database,
  windowHours: number = 24,
): Promise<Map<string, WorkflowAgentStats>> {
  try {
    const rows = await db.prepare(
      `SELECT agent_id,
              SUM(CASE WHEN event_type = 'workflow_dispatched' THEN 1 ELSE 0 END) AS dispatched,
              SUM(CASE WHEN event_type = 'batch_complete' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN event_type = 'workflow_dispatch_failed' THEN 1 ELSE 0 END) AS dispatch_failed,
              SUM(CASE WHEN event_type = 'workflow_cooldown_skip' THEN 1 ELSE 0 END) AS cooldown_skipped,
              MAX(CASE WHEN event_type = 'batch_complete' THEN created_at END) AS last_completed_at,
              MAX(CASE WHEN event_type = 'workflow_dispatch_failed' THEN created_at END) AS last_failure_at,
              MAX(CASE WHEN event_type = 'workflow_dispatch_failed' THEN message END) AS last_error,
              MAX(created_at) AS last_event_at
       FROM agent_activity_log
       WHERE created_at >= datetime('now', '-' || ? || ' hours')
         AND event_type IN ('workflow_dispatched','batch_complete','workflow_dispatch_failed','workflow_cooldown_skip')
       GROUP BY agent_id`,
    ).bind(windowHours).all<WorkflowAgentStats>();
    return new Map(rows.results.map((r) => [r.agent_id, r]));
  } catch {
    // Failing the helper must not break the caller — return empty
    // map and the caller falls back to its agent_runs-only path.
    return new Map();
  }
}

/**
 * Decide whether an agent should be treated as workflow-dispatched
 * for status purposes. Used by the row-builders to know when to
 * prefer workflow stats over agent_runs.
 *
 * Rule: presence of any workflow event in the rollup window means
 * this agent has a live workflow path. Today only nexus matches.
 * Cartographer will match once PR-O cuts the `9 * * * *` cron over.
 */
export function isWorkflowAgent(agentId: string, stats: Map<string, WorkflowAgentStats>): boolean {
  const s = stats.get(agentId);
  return s !== undefined && s.last_event_at !== null;
}
