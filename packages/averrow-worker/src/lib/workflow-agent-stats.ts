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

import type { Env } from "../types";
import { applySplit, historyParts } from "./telemetry-read";

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
  /** Count of workflow_failed events — the workflow body STARTED and
   *  then threw (NEXUS_DARK_2026-09). Distinct from dispatch_failed,
   *  which is a platform-side failure to start it at all. Without this
   *  a run that starts and dies is indistinguishable from one still in
   *  flight, forever — which is how NEXUS sat at 0 completions for
   *  ~7 weeks while the UI showed it active. */
  run_failed:         number;
  /** ISO timestamp of the most recent batch_complete event. */
  last_completed_at:  string | null;
  /** ISO timestamp of the most recent failure of either kind
   *  (workflow_dispatch_failed or workflow_failed). */
  last_failure_at:    string | null;
  /** The failure message belonging to `last_failure_at` — for
   *  last_run_error. Correlated, NOT `MAX(message)`: with two failure
   *  classes now folded in (workflow_dispatch_failed = platform, and
   *  workflow_failed = body), the lexicographic max routinely belongs to
   *  a different event than the timestamp beside it, so an operator can
   *  be shown a dispatch error while `last_failure_at` points at a body
   *  failure — exactly the confusion this rollup exists to end. */
  last_error:         string | null;
  /** Most recent event of any kind in the 24h window — for staleness
   *  / status-derivation. */
  last_event_at:      string | null;
}

/**
 * `db` is the core DB (or read session). With `env`, agent_activity_log is
 * read across telemetry ∪ core during the cut-over (Track B1c) and the
 * per-part rollups are merged: counts summed, timestamps MAX'd, and
 * `last_error` taken from the part holding the newest failure.
 */
export async function getWorkflowAgentStats(
  db: D1Database | D1DatabaseSession,
  windowHours: number = 24,
  env?: Env,
): Promise<Map<string, WorkflowAgentStats>> {
  try {
    const parts = await historyParts(env, "agent_activity_log", { core: db, alias: "a" });
    const lists = await Promise.all(parts.map(async (part) => {
      const q = applySplit(part, { sql: `SELECT agent_id,
              SUM(CASE WHEN event_type = 'workflow_dispatched' THEN 1 ELSE 0 END) AS dispatched,
              SUM(CASE WHEN event_type = 'batch_complete' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN event_type = 'workflow_dispatch_failed' THEN 1 ELSE 0 END) AS dispatch_failed,
              SUM(CASE WHEN event_type = 'workflow_cooldown_skip' THEN 1 ELSE 0 END) AS cooldown_skipped,
              SUM(CASE WHEN event_type = 'workflow_failed' THEN 1 ELSE 0 END) AS run_failed,
              MAX(CASE WHEN event_type = 'batch_complete' THEN created_at END) AS last_completed_at,
              MAX(CASE WHEN event_type IN ('workflow_dispatch_failed','workflow_failed') THEN created_at END) AS last_failure_at,
              -- Correlated, not MAX(message): see the last_error doc
              -- comment. Costs one indexed point-lookup per agent group
              -- (idx_activity_agent is (agent_id, created_at DESC)), and
              -- the group count here is 1-2 agents.
              (SELECT f.message
                 FROM agent_activity_log f
                WHERE f.agent_id = a.agent_id
                  AND f.created_at >= datetime('now', '-' || ? || ' hours')
                  AND f.event_type IN ('workflow_dispatch_failed','workflow_failed')
                ORDER BY f.created_at DESC, f.id DESC
                LIMIT 1) AS last_error,
              MAX(created_at) AS last_event_at
       FROM agent_activity_log a
       WHERE created_at >= datetime('now', '-' || ? || ' hours')
         AND event_type IN ('workflow_dispatched','batch_complete','workflow_dispatch_failed','workflow_cooldown_skip','workflow_failed')/*split*/
       GROUP BY agent_id`, binds: [windowHours, windowHours] });
      return (await part.db.prepare(q.sql).bind(...q.binds).all<WorkflowAgentStats>()).results ?? [];
    }));
    if (lists.length === 1) return new Map((lists[0] ?? []).map((r) => [r.agent_id, r]));
    const merged = new Map<string, WorkflowAgentStats>();
    for (const list of lists) {
      for (const r of list) {
        const cur = merged.get(r.agent_id);
        if (!cur) { merged.set(r.agent_id, { ...r }); continue; }
        const maxTs = (x: string | null, y: string | null): string | null => (x === null ? y : y === null ? x : (y > x ? y : x));
        const newerFailure = r.last_failure_at !== null && (cur.last_failure_at === null || r.last_failure_at > cur.last_failure_at);
        merged.set(r.agent_id, {
          agent_id: r.agent_id,
          dispatched: Number(cur.dispatched ?? 0) + Number(r.dispatched ?? 0),
          completed: Number(cur.completed ?? 0) + Number(r.completed ?? 0),
          dispatch_failed: Number(cur.dispatch_failed ?? 0) + Number(r.dispatch_failed ?? 0),
          cooldown_skipped: Number(cur.cooldown_skipped ?? 0) + Number(r.cooldown_skipped ?? 0),
          run_failed: Number(cur.run_failed ?? 0) + Number(r.run_failed ?? 0),
          last_completed_at: maxTs(cur.last_completed_at, r.last_completed_at),
          last_failure_at: maxTs(cur.last_failure_at, r.last_failure_at),
          last_error: newerFailure ? r.last_error : cur.last_error,
          last_event_at: maxTs(cur.last_event_at, r.last_event_at),
        });
      }
    }
    return merged;
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
