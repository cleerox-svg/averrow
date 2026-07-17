import { json } from "../lib/cors";
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import { executeAgent, resolveApproval, PROTECTED_FROM_CIRCUIT_BREAKER } from "../lib/agentRunner";
import type { AgentName, TriggerType } from "../lib/agentRunner";
import { agentModules, trustbotAgent } from "../agents";
import { BudgetManager } from "../lib/budgetManager";
import { handler, parsePagination, parseFilters, buildWhereClause, paginatedResponse, success, error, parseBody } from "../lib/handler-utils";
import { getWorkflowAgentStats, type WorkflowAgentStats } from "../lib/workflow-agent-stats";
import type { Env } from "../types";

// ─── Derive agent definitions from modules ──────────────────────
function getAgentDefinitions(): Array<{
  name: AgentName;
  displayName: string;
  description: string;
  color: string;
  trigger: TriggerType;
  requiresApproval: boolean;
}> {
  return Object.values(agentModules).map(mod => ({
    name: mod.name,
    displayName: mod.displayName,
    description: mod.description,
    color: mod.color,
    trigger: mod.trigger,
    requiresApproval: mod.requiresApproval ?? false,
  }));
}

// ─── Schedule labels for each agent ─────────────────────────────
const AGENT_SCHEDULES: Record<string, string> = {
  sentinel: "5m (event)",
  analyst: "every 15m",
  cartographer: "every 15m + Sentinel trigger",
  strategist: "every 6h",
  observer: "daily",
  pathfinder: "weekly",
  sparrow: "every 6h",
  nexus: "every 4h",
  architect: "manual",
  navigator: "5m (cron)",
};

// ─── Navigator — synthetic agent definition ─────────────────────
//
// Navigator runs on its own */5 cron and is NOT in agentModules (it's a
// cron handler, not an AgentModule instance — FC observes it but does
// not dispatch). We synthesize its /api/agents row here so the UI grid
// treats it like any other agent. Historical rows use agent_id='fast_tick';
// new rows use 'navigator' — both are aggregated below.
const NAVIGATOR_IDS = ['navigator', 'fast_tick'] as const;
const NAVIGATOR_DEF = {
  name: 'navigator',
  displayName: 'Navigator',
  description: 'DNS resolution and lightweight enrichment. Runs on an independent 5-minute cron.',
  color: '#38BDF8',
  trigger: 'scheduled' as const,
  requiresApproval: false,
};

// ─── List all agent definitions + their latest run ──────────────
export const handleListAgents = handler(async (_request, env, ctx) => {
  // KV cache: 8 parallel queries — cache for 5 minutes. v4 prefix
  // invalidates prior shapes:
  //   v1 — pre-recent_ticks (no new field at all)
  //   v2 — recent_ticks present but emitted with `trigger` GROUP BY
  //         on a column that doesn't exist on agent_runs, so the
  //         handler 500'd and the response was never cached.
  //   v3 — pre outputs_per_hour / errors_per_hour. Cards on /agents-v3
  //         could only render single-series sparklines.
  const cacheKey = 'agents_list:v4';
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    recordD1Reads(env, "agents_list", newTally());
    return json(JSON.parse(cached), 200, ctx.origin);
  }
  const tally = newTally();

  const [latestRuns, runStats24h, outputStats24h, hourlyActivity, hourlyOutputs, recentTickRows, lastOutputTimes, avgDurations, agentConfigs, workflowAgentStats] = await Promise.all([
    // Latest run per agent (of ANY age — deriveStatus depends on the
    // absolute most-recent run so a long-dormant agent whose last run
    // FAILED still reads as 'error', not a falsely-'idle' online agent).
    // The prior shape used a correlated subquery (WHERE id IN (SELECT ...
    // WHERE r2.agent_id = agent_runs.agent_id ORDER BY started_at DESC
    // LIMIT 1)) which EXPLAIN'd to a full unbounded SCAN of agent_runs
    // plus a per-row correlated subquery (~100ms / 117K rows). Replaced
    // with a single ROW_NUMBER pass — no time bound (must not hide an
    // agent's latest run) — which the idx_agent_runs_agent (agent_id,
    // started_at DESC) composite serves as an index-ordered scan
    // (EXPLAIN: SCAN agent_runs USING INDEX idx_agent_runs_agent), with
    // exactly one row per agent_id and no correlated per-row lookup.
    env.DB.prepare(
      `SELECT agent_id, status, started_at, completed_at, duration_ms, error_message
       FROM (
         SELECT agent_id, status, started_at, completed_at, duration_ms, error_message,
                ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY started_at DESC) AS rn
         FROM agent_runs
       )
       WHERE rn = 1`
    ).all<{ agent_id: string; status: string; started_at: string; completed_at: string | null; duration_ms: number | null; error_message: string | null }>(),

    env.DB.prepare(
      `SELECT agent_id,
              COUNT(*) as jobs_24h,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as error_count_24h
       FROM agent_runs
       WHERE started_at >= datetime('now', '-1 day')
       GROUP BY agent_id`
    ).all<{ agent_id: string; jobs_24h: number; error_count_24h: number }>(),

    env.DB.prepare(
      `SELECT agent_id,
              COUNT(*) as outputs_24h
       FROM agent_outputs
       WHERE created_at >= datetime('now', '-1 day')
       GROUP BY agent_id`
    ).all<{ agent_id: string; outputs_24h: number }>(),

    // hourlyActivity — runs + errors per (agent, hour) bucket. Used
    // by the cards' 24h area chart (multi-series). Errors are derived
    // here so cards don't have to fire a separate handleAgentHealth
    // call per agent (~40 D1 reads avoided per page load).
    env.DB.prepare(
      `SELECT agent_id,
              CAST(strftime('%H', started_at) AS INTEGER) AS hour,
              COUNT(*) AS cnt,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS errors
       FROM agent_runs
       WHERE started_at >= datetime('now', '-1 day')
       GROUP BY agent_id, hour`
    ).all<{ agent_id: string; hour: number; cnt: number; errors: number }>(),

    // hourlyOutputs — outputs per (agent, hour) bucket. Separate
    // table so it can't be folded into hourlyActivity. Same 24h
    // window + bounded-index pattern as the existing aggregation
    // against agent_outputs.
    env.DB.prepare(
      `SELECT agent_id,
              CAST(strftime('%H', created_at) AS INTEGER) AS hour,
              COUNT(*) AS cnt
       FROM agent_outputs
       WHERE created_at >= datetime('now', '-1 day')
       GROUP BY agent_id, hour`
    ).all<{ agent_id: string; hour: number; cnt: number }>(),

    // Recent ticks for the run-status-blocks 2D timeline. We bucket by
    // hour and group by status so a (bucket, status) tile is emitted
    // for every distinct outcome inside the hour. The earlier shape
    // tried to GROUP BY a `trigger` column — that column doesn't
    // exist on agent_runs (origin/scaler info is held only in
    // ctx.input, not persisted), so the query threw 'no such column'
    // and the entire handler 500'd. Without trigger info we recover
    // the parallelism signal a different way: COUNT(*) per
    // (agent_id, bucket, status) tells the frontend how many parallel
    // instances landed in that hour, capped to 3 stacked blocks at
    // render time. For non-scaling agents (Navigator at 12×/h) the
    // count is large but the visual is still intuitive.
    env.DB.prepare(
      `SELECT agent_id,
              strftime('%Y-%m-%d %H:00:00', started_at) AS bucket,
              status,
              COUNT(*) AS n,
              AVG(duration_ms) AS avg_duration_ms
         FROM agent_runs
        WHERE started_at >= datetime('now', '-5 hours')
        GROUP BY agent_id, bucket, status
        ORDER BY agent_id, bucket DESC,
                 CASE status
                   WHEN 'running' THEN 1
                   WHEN 'failed'  THEN 2
                   WHEN 'partial' THEN 3
                   WHEN 'success' THEN 4
                   ELSE                5
                 END`
    ).all<{
      agent_id: string;
      bucket: string;
      status: string;
      n: number;
      avg_duration_ms: number | null;
    }>(),

    // Bound to the last 30 days so the index range scan stays cheap
    // as agent_outputs grows. Operationally, an agent that hasn't
    // produced any output in 30 days is either disabled or broken —
    // showing a stale "last seen" timestamp from months ago doesn't
    // help triage. Phase 3 of the D1 spend-reduction track:
    // pre-bounded the query was reading ~143K rows/call (full table
    // scan); with the time filter idx_agent_outputs_agent
    // (agent_id, created_at DESC) becomes index-only over a bounded
    // window.
    env.DB.prepare(
      `SELECT agent_id, MAX(created_at) as last_output_at
       FROM agent_outputs
       WHERE created_at >= datetime('now', '-30 days')
       GROUP BY agent_id`
    ).all<{ agent_id: string; last_output_at: string }>(),

    // Scope to last 24h so this doesn't scan all-time agent_runs history —
    // the table grows unboundedly (~288 Navigator runs/day alone) and this
    // aggregation was reading ~107K rows per call as of Apr 2026. With the
    // 24h scope the existing idx_agent_runs_agent composite (agent_id,
    // started_at DESC) + idx_agent_runs_success_duration partial index
    // make this an index-only scan over a bounded window.
    env.DB.prepare(
      `SELECT agent_id, AVG(duration_ms) as avg_duration_ms
       FROM agent_runs
       WHERE status = 'success'
         AND started_at >= datetime('now', '-1 day')
       GROUP BY agent_id`
    ).all<{ agent_id: string; avg_duration_ms: number }>(),

    env.DB.prepare(
      `SELECT agent_id, enabled, paused_reason, consecutive_failures,
              consecutive_failure_threshold, paused_at, paused_after_n_failures
       FROM agent_configs`
    ).all<{
      agent_id: string; enabled: number; paused_reason: string | null;
      consecutive_failures: number; consecutive_failure_threshold: number | null;
      paused_at: string | null; paused_after_n_failures: number | null;
    }>(),

    // Workflow-dispatched agents (nexus + future) write to
    // agent_activity_log not agent_runs. PR-R adds the shared
    // getWorkflowAgentStats helper so every consumer applies the
    // same reconciliation. See lib/workflow-agent-stats.ts.
    getWorkflowAgentStats(env.DB),
  ]);

  const latestRunMap = new Map(latestRuns.results.map((r) => [r.agent_id, r]));
  const statsMap = new Map(runStats24h.results.map((r) => [r.agent_id, r]));
  const outputMap = new Map(outputStats24h.results.map((r) => [r.agent_id, r.outputs_24h]));
  const lastOutputMap = new Map(lastOutputTimes.results.map((r) => [r.agent_id, r.last_output_at]));
  const avgDurMap = new Map(avgDurations.results.map((r) => [r.agent_id, r.avg_duration_ms]));
  const configMap = new Map(agentConfigs.results.map((r) => [r.agent_id, r]));
  // workflowAgentStats is already a Map<agent_id, WorkflowAgentStats>
  // straight from the helper (PR-R).
  const workflowAgentMap = workflowAgentStats;

  const activityMap       = new Map<string, number[]>();
  const errorsPerHourMap  = new Map<string, number[]>();
  const outputsPerHourMap = new Map<string, number[]>();
  const currentHour = new Date().getUTCHours();
  for (const row of hourlyActivity.results) {
    if (!activityMap.has(row.agent_id))      activityMap.set(row.agent_id, new Array(24).fill(0));
    if (!errorsPerHourMap.has(row.agent_id)) errorsPerHourMap.set(row.agent_id, new Array(24).fill(0));
    const idx = (row.hour - currentHour + 24) % 24;
    activityMap.get(row.agent_id)![idx]      = row.cnt;
    errorsPerHourMap.get(row.agent_id)![idx] = row.errors ?? 0;
  }
  for (const row of hourlyOutputs.results) {
    if (!outputsPerHourMap.has(row.agent_id)) outputsPerHourMap.set(row.agent_id, new Array(24).fill(0));
    const idx = (row.hour - currentHour + 24) % 24;
    outputsPerHourMap.get(row.agent_id)![idx] = row.cnt;
  }

  // ─── Build recent_ticks per agent (last 5 hour buckets) ───────────
  //
  // Shape sent to the UI:
  //   recent_ticks: Array<{
  //     bucket: string;            // 'YYYY-MM-DD HH:00:00' UTC
  //     instances: Array<{
  //       status: 'success' | 'failed' | 'partial' | 'running' | 'idle';
  //       trigger: string;         // unused — agent_runs has no
  //                                // trigger column. Kept in the
  //                                // shape for forward compat with
  //                                // a future migration; populated
  //                                // as 'unknown' for now.
  //       count: number;           // runs collapsed at this (bucket,status)
  //       avg_duration_ms: number | null;
  //     }>;
  //   }>
  //
  // Rendering: one column per tick, one block per instance (capped
  // at 3). Cartographer/analyst FC scale-ups show up as multiple
  // 'success' rows in the same bucket because each parallel
  // instance writes its own agent_runs row — the count of those
  // rows IS the parallelism signal even without a trigger column.
  const STATUS_TO_NORMALIZED: Record<string, 'success' | 'failed' | 'partial' | 'running' | 'idle'> = {
    success: 'success',
    failed:  'failed',
    partial: 'partial',
    running: 'running',
  };
  const TICKS_PER_AGENT = 5;
  const MAX_INSTANCES_PER_TICK = 3;
  type TickInstance = {
    status: 'success' | 'failed' | 'partial' | 'running' | 'idle';
    trigger: string;
    count: number;
    avg_duration_ms: number | null;
  };
  type Tick = { bucket: string; instances: TickInstance[] };
  const ticksByAgent = new Map<string, Map<string, TickInstance[]>>();
  for (const row of recentTickRows.results) {
    let perAgent = ticksByAgent.get(row.agent_id);
    if (!perAgent) {
      perAgent = new Map<string, TickInstance[]>();
      ticksByAgent.set(row.agent_id, perAgent);
    }
    let arr = perAgent.get(row.bucket);
    if (!arr) {
      arr = [];
      perAgent.set(row.bucket, arr);
    }
    if (arr.length >= MAX_INSTANCES_PER_TICK) continue;
    arr.push({
      status: STATUS_TO_NORMALIZED[row.status] ?? 'idle',
      trigger: 'unknown',
      count: row.n,
      avg_duration_ms: row.avg_duration_ms,
    });
  }
  function recentTicksFor(agentId: string): Tick[] {
    const perAgent = ticksByAgent.get(agentId);
    if (!perAgent) return [];
    return [...perAgent.entries()]
      .map(([bucket, instances]) => ({ bucket, instances }))
      .sort((a, b) => (a.bucket < b.bucket ? 1 : -1))
      .slice(0, TICKS_PER_AGENT)
      .reverse(); // chronological left→right
  }

  function deriveStatus(agentName: string): string {
    // Workflow-dispatched agents (nexus + future): canonical status
    // lives in agent_activity_log. Use the most recent batch_complete
    // (success) or workflow_dispatch_failed (error) event over the
    // 24h window; fall back to agent_runs only when no workflow
    // events exist.
    const wf = workflowAgentMap.get(agentName);
    if (wf && wf.last_event_at) {
      // Most recent failure newer than most recent success → error
      const lastSuccess = wf.last_completed_at ? new Date(wf.last_completed_at).getTime() : 0;
      const lastFailure = wf.last_failure_at ? new Date(wf.last_failure_at).getTime() : 0;
      if (lastFailure > lastSuccess && wf.dispatch_failed > 0) return "error";
      const lastEvent = new Date(wf.last_event_at).getTime();
      const ageMs = Date.now() - lastEvent;
      const sixHours = 6 * 60 * 60 * 1000;
      // Workflow agents run on their own cadence (nexus = every 4h).
      // 6h freshness window is slightly longer than the slowest one
      // so a healthy nexus reads as 'active' between dispatches.
      return ageMs < sixHours ? "active" : "idle";
    }

    const latest = latestRunMap.get(agentName);
    if (!latest) return "idle";
    if (latest.status === "failed") return "error";
    if (latest.status === "partial") return "degraded";
    const lastRun = new Date(latest.started_at).getTime();
    const ageMs = Date.now() - lastRun;
    const twoHours = 2 * 60 * 60 * 1000;
    return ageMs < twoHours ? "active" : "idle";
  }

  const agents = getAgentDefinitions().map((def) => {
    const stats = statsMap.get(def.name);
    const latestRun = latestRunMap.get(def.name);
    const config = configMap.get(def.name);
    const wf = workflowAgentMap.get(def.name);
    const isTripped = config?.enabled === 0 && config.paused_reason === 'auto:consecutive_failures';

    // Workflow-dispatched agents (PR-R reconciliation): prefer
    // agent_activity_log workflow events over the stale agent_runs
    // rows. last_run_at + last_run_status are the key fields the UI
    // renders for the FAILING/ACTIVE pill.
    const lastWfFailureMs = wf?.last_failure_at ? new Date(wf.last_failure_at).getTime() : 0;
    const lastWfSuccessMs = wf?.last_completed_at ? new Date(wf.last_completed_at).getTime() : 0;
    const wfLastRunAt = wf?.last_event_at ?? null;
    const wfLastRunStatus = wf
      ? (lastWfFailureMs > lastWfSuccessMs && wf.dispatch_failed > 0 ? 'failed' :
         wf.completed > 0 ? 'success' :
         wf.dispatched > 0 ? 'partial' : null)
      : null;

    return {
      agent_id: def.name,
      name: def.name,
      display_name: def.displayName,
      description: def.description,
      color: def.color,
      trigger: def.trigger,
      requiresApproval: def.requiresApproval,
      status: deriveStatus(def.name),
      schedule: AGENT_SCHEDULES[def.name] ?? "-",
      jobs_24h: wf ? wf.dispatched + wf.dispatch_failed + wf.cooldown_skipped : (stats?.jobs_24h ?? 0),
      outputs_24h: outputMap.get(def.name) ?? 0,
      error_count_24h: wf ? wf.dispatch_failed : (stats?.error_count_24h ?? 0),
      activity:         activityMap.get(def.name)       ?? new Array(24).fill(0),
      // Hourly arrays for the multi-series card chart (mirrors
      // useAgentHealth's per-hour shape but rides this handler's
      // KV cache, so cards don't fan out 40 D1 reads).
      outputs_per_hour: outputsPerHourMap.get(def.name)  ?? new Array(24).fill(0),
      errors_per_hour:  errorsPerHourMap.get(def.name)   ?? new Array(24).fill(0),
      recent_ticks: recentTicksFor(def.name),
      last_run_at: wfLastRunAt ?? latestRun?.started_at ?? null,
      last_run_status: wfLastRunStatus ?? latestRun?.status ?? null,
      last_run_duration_ms: wf ? null : (latestRun?.duration_ms ?? null),
      last_run_error: (wf && wfLastRunStatus === 'failed') ? (wf.last_error ?? null) : (latestRun?.error_message ?? null),
      last_output_at: lastOutputMap.get(def.name) ?? null,
      avg_duration_ms: avgDurMap.get(def.name) ?? null,
      dispatch_source: wf ? ('workflow' as const) : ('agent_runs' as const),
      // Circuit breaker state
      circuit_enabled: config?.enabled ?? 1,
      circuit_state: isTripped ? 'tripped' : (config?.enabled === 0 ? 'manual_pause' : 'closed'),
      paused_reason: config?.paused_reason ?? null,
      consecutive_failures: config?.consecutive_failures ?? 0,
      consecutive_failure_threshold: config?.consecutive_failure_threshold ?? null,
      paused_at: config?.paused_at ?? null,
      paused_after_n_failures: config?.paused_after_n_failures ?? null,
    };
  });

  // Synthesize Navigator — aggregate rows from both the current and legacy
  // agent_ids. Latest-run picks whichever ID has the most recent started_at.
  // Navigator is not in agent_configs (no circuit breaker), so fields default
  // to an always-enabled 'closed' state. deriveStatus uses whichever ID had
  // the latest run.
  const navLatest = (() => {
    const candidates = NAVIGATOR_IDS.map(id => latestRunMap.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
    if (candidates.length === 0) return undefined;
    return candidates.sort((a, b) => (a.started_at > b.started_at ? -1 : 1))[0];
  })();
  const navJobs = NAVIGATOR_IDS.reduce((sum, id) => sum + (statsMap.get(id)?.jobs_24h ?? 0), 0);
  const navErrors = NAVIGATOR_IDS.reduce((sum, id) => sum + (statsMap.get(id)?.error_count_24h ?? 0), 0);
  const navOutputs = NAVIGATOR_IDS.reduce((sum, id) => sum + (outputMap.get(id) ?? 0), 0);
  const navActivity       = new Array(24).fill(0);
  const navOutputsPerHour = new Array(24).fill(0);
  const navErrorsPerHour  = new Array(24).fill(0);
  for (const id of NAVIGATOR_IDS) {
    const arr = activityMap.get(id);
    if (arr) for (let i = 0; i < 24; i++) navActivity[i] += arr[i] ?? 0;
    const outArr = outputsPerHourMap.get(id);
    if (outArr) for (let i = 0; i < 24; i++) navOutputsPerHour[i] += outArr[i] ?? 0;
    const errArr = errorsPerHourMap.get(id);
    if (errArr) for (let i = 0; i < 24; i++) navErrorsPerHour[i] += errArr[i] ?? 0;
  }
  const navLastOutput = NAVIGATOR_IDS
    .map(id => lastOutputMap.get(id))
    .filter((v): v is string => !!v)
    .sort()
    .pop() ?? null;
  const navAvgDurs = NAVIGATOR_IDS.map(id => avgDurMap.get(id)).filter((v): v is number => typeof v === 'number');
  const navAvgDur = navAvgDurs.length > 0 ? navAvgDurs.reduce((a, b) => a + b, 0) / navAvgDurs.length : null;
  const navStatus = (() => {
    if (!navLatest) return 'idle';
    if (navLatest.status === 'failed') return 'error';
    if (navLatest.status === 'partial') return 'degraded';
    const ageMs = Date.now() - new Date(navLatest.started_at + 'Z').getTime();
    // Navigator runs every 5 min — flag it degraded once it misses 2 cycles.
    if (ageMs > 10 * 60 * 1000) return 'degraded';
    return 'active';
  })();
  // Cast agent_id/name to AgentName: Navigator isn't in the canonical
  // AgentName union (it's a cron handler, not an AgentModule), but the
  // /api/agents response shape is decoupled from that union — downstream
  // consumers treat agent_id as a string.
  agents.push({
    agent_id: NAVIGATOR_DEF.name as AgentName,
    name: NAVIGATOR_DEF.name as AgentName,
    display_name: NAVIGATOR_DEF.displayName,
    description: NAVIGATOR_DEF.description,
    color: NAVIGATOR_DEF.color,
    trigger: NAVIGATOR_DEF.trigger,
    requiresApproval: NAVIGATOR_DEF.requiresApproval,
    status: navStatus,
    schedule: AGENT_SCHEDULES.navigator ?? '5m (cron)',
    jobs_24h: navJobs,
    outputs_24h: navOutputs,
    error_count_24h: navErrors,
    activity:         navActivity,
    outputs_per_hour: navOutputsPerHour,
    errors_per_hour:  navErrorsPerHour,
    // Navigator's recent_ticks merges both id histories. Per-bucket
    // instance lists from the two ids get concatenated; the natural
    // dedupe is that historical 'fast_tick' rows fall outside the
    // 5-hour window, so usually only 'navigator' contributes.
    recent_ticks: (() => {
      const merged = new Map<string, TickInstance[]>();
      for (const id of NAVIGATOR_IDS) {
        const perAgent = ticksByAgent.get(id);
        if (!perAgent) continue;
        for (const [bucket, instances] of perAgent) {
          const existing = merged.get(bucket) ?? [];
          for (const inst of instances) {
            if (existing.length >= MAX_INSTANCES_PER_TICK) break;
            existing.push(inst);
          }
          merged.set(bucket, existing);
        }
      }
      return [...merged.entries()]
        .map(([bucket, instances]) => ({ bucket, instances }))
        .sort((a, b) => (a.bucket < b.bucket ? 1 : -1))
        .slice(0, TICKS_PER_AGENT)
        .reverse();
    })(),
    last_run_at: navLatest?.started_at ?? null,
    last_run_status: navLatest?.status ?? null,
    last_run_duration_ms: navLatest?.duration_ms ?? null,
    last_run_error: navLatest?.error_message ?? null,
    last_output_at: navLastOutput,
    avg_duration_ms: navAvgDur,
    dispatch_source: 'agent_runs' as const,
    // Navigator has no circuit breaker — FC observes, does not manage.
    circuit_enabled: 1,
    circuit_state: 'closed',
    paused_reason: null,
    consecutive_failures: 0,
    consecutive_failure_threshold: null,
    paused_at: null,
    paused_after_n_failures: null,
  });

  // Attribute real rows_read from each of the 9 .all() queries via
  // their result.meta so this handler's D1 cost is visible in
  // d1_attribution_24h (was a hardcoded `tally.queries += 9` with no
  // rowsRead, making the cold-miss cost invisible). workflowAgentStats
  // returns a Map, not a D1 result — its internal reads are tallied
  // inside getWorkflowAgentStats, not here.
  addToTally(tally, latestRuns.meta);
  addToTally(tally, runStats24h.meta);
  addToTally(tally, outputStats24h.meta);
  addToTally(tally, hourlyActivity.meta);
  addToTally(tally, hourlyOutputs.meta);
  addToTally(tally, recentTickRows.meta);
  addToTally(tally, lastOutputTimes.meta);
  addToTally(tally, avgDurations.meta);
  addToTally(tally, agentConfigs.meta);

  const responseData = { success: true, data: agents };
  // 900s TTL comfortably outlives Navigator's 15-min Phase B warm
  // cadence (matches the observatory.ts precedent: 900s TTL / 10-min
  // warm). At 300s the cache was expired ~67% of the time between
  // warms, so real loads landed cold (~88% miss).
  await env.CACHE.put(cacheKey, JSON.stringify(responseData), { expirationTtl: 900 });
  recordD1Reads(env, "agents_list", tally);
  return json(responseData, 200, ctx.origin);
});

// ─── Get agent detail with run history ──────────────────────────
export async function handleGetAgent(request: Request, env: Env, agentName: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Navigator special case: synthesize a definition and span both the
    // current + legacy agent_ids so run history covers the rename transition.
    const isNavigator = agentName === NAVIGATOR_DEF.name;
    const def = isNavigator
      ? NAVIGATOR_DEF
      : getAgentDefinitions().find((d) => d.name === agentName);
    if (!def) return error("Agent not found", 404, origin);

    const ids = isNavigator ? NAVIGATOR_IDS : [agentName];
    const placeholders = ids.map(() => '?').join(',');

    const [runs, outputs, stats] = await Promise.all([
      env.DB.prepare(
        `SELECT id, agent_id, status, records_processed, outputs_generated,
                duration_ms, error_message, started_at, completed_at
         FROM agent_runs WHERE agent_id IN (${placeholders})
         ORDER BY started_at DESC LIMIT 50`
      ).bind(...ids).all(),
      env.DB.prepare(
        `SELECT id, type, summary, severity, details, related_brand_ids,
                related_campaign_id, related_provider_ids, created_at
         FROM agent_outputs WHERE agent_id IN (${placeholders})
         ORDER BY created_at DESC LIMIT 20`
      ).bind(...ids).all(),
      env.DB.prepare(
        `SELECT
           COUNT(*) as total_runs,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failures,
           SUM(records_processed) as total_processed,
           SUM(outputs_generated) as total_outputs,
           AVG(duration_ms) as avg_duration_ms
         FROM agent_runs WHERE agent_id IN (${placeholders})`
      ).bind(...ids).first(),
    ]);

    return success({ agent: def, runs: runs.results, outputs: outputs.results, stats }, origin);
  } catch (err) {
    return error(String(err), 500, origin);
  }
}

// ─── Trigger an agent manually ──────────────────────────────────
export async function handleTriggerAgent(
  request: Request, env: Env, agentName: string, userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const mod = agentModules[agentName];
    if (!mod) return error("Agent not found", 404, origin);

    const body = await request.json().catch(() => ({})) as { input?: Record<string, unknown> };
    const result = await executeAgent(env, mod, body.input ?? {}, userId, "manual");

    // A manual run changes the 24h counts / last-run — reflect immediately.
    await env.CACHE.delete('agents_list:v4');

    return success(result, origin);
  } catch (err) {
    console.error(`[triggerAgent] "${agentName}" threw:`, err);
    return error(String(err), 500, origin);
  }
}

// ─── Trigger all agents sequentially ────────────────────────────
export async function handleTriggerAllAgents(
  request: Request, env: Env, userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const results: Record<string, { status: string; runId: string; error?: string }> = {};
    for (const [name, mod] of Object.entries(agentModules)) {
      const result = await executeAgent(env, mod, {}, userId, "manual");
      results[name] = { status: result.status, runId: result.runId, error: result.error };
    }
    return success(results, origin);
  } catch (err) {
    console.error("[triggerAll] threw:", err);
    return error(String(err), 500, origin);
  }
}

// ─── Get run history across all agents ──────────────────────────
export const handleAgentRuns = handler(async (request, env, ctx) => {
  const { limit, offset } = parsePagination(request);
  const url = new URL(request.url);
  const agentFilter = url.searchParams.get("agent");
  const statusFilter = url.searchParams.get("status");
  const window = url.searchParams.get("window");

  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (agentFilter) {
    conditions.push("agent_id = ?");
    bindings.push(agentFilter);
  }
  if (statusFilter) {
    conditions.push("status = ?");
    bindings.push(statusFilter);
  }
  if (window) {
    const windowMap: Record<string, string> = {
      "24h": "-1 day", "7d": "-7 days", "30d": "-30 days",
    };
    const interval = windowMap[window];
    if (interval) {
      conditions.push("started_at >= datetime('now', ?)");
      bindings.push(interval);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(
      `SELECT id, agent_id, status, records_processed, outputs_generated,
              duration_ms, tokens_used, input_tokens, output_tokens,
              error_message, started_at, completed_at
       FROM agent_runs ${where}
       ORDER BY started_at DESC LIMIT ? OFFSET ?`
    ).bind(...bindings, limit, offset).all(),
    env.DB.prepare(
      `SELECT COUNT(*) as total FROM agent_runs ${where}`
    ).bind(...bindings).first<{ total: number }>(),
  ]);

  return paginatedResponse(rows.results, countRow?.total ?? 0, ctx.origin);
});

// ─── Token usage by agent (all time) ───────────────────────────
export const handleAgentTokenUsage = handler(async (_request, env, ctx) => {
  const rows = await env.DB.prepare(
    `SELECT agent_id,
            SUM(tokens_used) as total_tokens,
            SUM(input_tokens) as total_input_tokens,
            SUM(output_tokens) as total_output_tokens,
            COUNT(*) as runs_with_tokens
     FROM agent_runs
     WHERE tokens_used > 0
     GROUP BY agent_id
     ORDER BY total_tokens DESC`
  ).all<{ agent_id: string; total_tokens: number; total_input_tokens: number; total_output_tokens: number; runs_with_tokens: number }>();

  return success(rows.results, ctx.origin);
});

// ─── Get latest agent outputs (insights, classifications, etc.) ─
export const handleAgentOutputs = handler(async (request, env, ctx) => {
  const { limit } = parsePagination(request, { limit: 20 });
  const filters = parseFilters(request, ["type", "agent"]);
  const { clause, bindings } = buildWhereClause(filters, { type: "type", agent: "agent_id" });

  const where = clause !== "1=1" ? `WHERE ${clause}` : "";
  bindings.push(limit);

  const rows = await env.DB.prepare(
    `SELECT id, agent_id, type, summary, severity, details,
            related_brand_ids, related_campaign_id, related_provider_ids, created_at
     FROM agent_outputs ${where}
     ORDER BY created_at DESC LIMIT ?`
  ).bind(...bindings).all();

  return success(rows.results, ctx.origin);
});

// ─── Agent outputs by name ───────────────────────────────────────
export async function handleAgentOutputsByName(request: Request, env: Env, agentName: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const { limit } = parsePagination(request, { limit: 10, maxLimit: 50 });

    const ids = agentName === NAVIGATOR_DEF.name ? NAVIGATOR_IDS : [agentName];
    const placeholders = ids.map(() => '?').join(',');

    const rows = await env.DB.prepare(
      `SELECT id, agent_id, type, summary, severity, details,
              related_brand_ids, related_campaign_id, related_provider_ids, created_at
       FROM agent_outputs WHERE agent_id IN (${placeholders})
       ORDER BY created_at DESC LIMIT ?`
    ).bind(...ids, limit).all();

    return success(rows.results, origin);
  } catch (err) {
    return error(String(err), 500, origin);
  }
}

// ─── Agent health metrics (hourly breakdown) ─────────────────────
export async function handleAgentHealth(request: Request, env: Env, agentName: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const hoursBack = 24;
    const runs:        number[] = new Array(hoursBack).fill(0);
    const errors:      number[] = new Array(hoursBack).fill(0);
    const outputs:     number[] = new Array(hoursBack).fill(0);
    const duration_ms: number[] = new Array(hoursBack).fill(0);

    // Navigator spans both 'navigator' + legacy 'fast_tick' so recent history
    // stays intact across the rename transition.
    const ids = agentName === NAVIGATOR_DEF.name ? NAVIGATOR_IDS : [agentName];
    const placeholders = ids.map(() => '?').join(',');

    const rows = await env.DB.prepare(
      `SELECT
         CAST(strftime('%H', started_at) AS INTEGER) AS hour,
         duration_ms,
         status,
         outputs_generated
       FROM agent_runs
       WHERE agent_id IN (${placeholders}) AND started_at >= datetime('now', '-24 hours')
       ORDER BY started_at ASC`
    ).bind(...ids).all();

    const currentHour = new Date().getUTCHours();
    for (const row of rows.results as { hour: number; duration_ms: number; status: string; outputs_generated: number }[]) {
      const idx = (row.hour - currentHour + hoursBack + hoursBack) % hoursBack;
      // Bug fix: runs[] was previously `+ row.duration_ms` (a SUM of
      // durations, mislabelled as "runs"). Now runs[] is the true
      // per-hour run count. Total duration moved to its own array.
      runs[idx]        = (runs[idx]        || 0) + 1;
      duration_ms[idx] = (duration_ms[idx] || 0) + (row.duration_ms || 0);
      if (row.status === "failed") errors[idx] = (errors[idx] ?? 0) + 1;
      outputs[idx] = (outputs[idx] ?? 0) + (row.outputs_generated || 0);
    }

    return success({ runs, errors, outputs, duration_ms }, origin);
  } catch (err) {
    return error(String(err), 500, origin);
  }
}

// ─── HITL Approval Queue (legacy compat) ────────────────────────
export const handleListApprovals = handler(async (request, env, ctx) => {
  const status = new URL(request.url).searchParams.get("status") ?? "pending";

  try {
    const rows = await env.DB.prepare(
      `SELECT id, run_id, agent_name, action_type, description, details, status,
              decided_by, decision_note, expires_at, decided_at, created_at
       FROM radar_agent_approvals
       WHERE status = ?
       ORDER BY created_at DESC LIMIT 50`
    ).bind(status).all();

    return success(rows.results, ctx.origin);
  } catch {
    // Table may not exist in v2
    return success([], ctx.origin);
  }
});

export async function handleResolveApproval(
  request: Request, env: Env, approvalId: string, userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await parseBody<{ decision: "approved" | "rejected"; note?: string }>(request);
    if (!body.decision || !["approved", "rejected"].includes(body.decision)) {
      return error("Decision must be 'approved' or 'rejected'", 400, origin);
    }

    await resolveApproval(env, approvalId, body.decision, userId, body.note);
    return json({ success: true }, 200, origin);
  } catch (err) {
    return error(String(err), 500, origin);
  }
}

// ─── TrustBot chat endpoint ─────────────────────────────────────
export async function handleTrustBotChat(
  request: Request, env: Env, userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await parseBody<{ query: string }>(request);
    if (!body.query?.trim()) return error("Query is required", 400, origin);

    const result = await executeAgent(env, trustbotAgent, { query: body.query }, userId, "manual");

    return success({
      response: (result.result?.output as { response?: string; context?: unknown })?.response ?? "No response generated.",
      context: (result.result?.output as { response?: string; context?: unknown })?.context ?? {},
      runId: result.runId,
    }, origin);
  } catch (err) {
    return error(String(err), 500, origin);
  }
}

// ─── Anthropic API usage (token + cost rollup, ledger-backed) ───
//
// Reads from budget_ledger — the canonical source of truth for spend
// after the Phase 4 Step 2 wrapper refactor. The legacy KV
// haiku_usage_* keys are gone, so this endpoint windows the ledger
// directly via SQL aggregates.
export const handleAgentApiUsage = handler(async (_request, env, ctx) => {
  const window = async (days: number) => {
    const row = await env.DB.prepare(
      `SELECT
         COUNT(*)             as calls,
         COALESCE(SUM(input_tokens), 0)  as input_tokens,
         COALESCE(SUM(output_tokens), 0) as output_tokens,
         COALESCE(SUM(cost_usd), 0)      as cost_usd
       FROM budget_ledger
       WHERE created_at >= datetime('now', '-' || ? || ' days')`
    ).bind(days).first<{
      calls: number; input_tokens: number; output_tokens: number; cost_usd: number;
    }>();
    return row ?? { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  };

  const [d1, d7, d30, byAgent, status] = await Promise.all([
    window(1),
    window(7),
    window(30),
    new BudgetManager(env.DB).getSpendByAgent(),
    new BudgetManager(env.DB).getStatus(),
  ]);

  return success({
    tokens_24h: d1.input_tokens + d1.output_tokens,
    tokens_7d: d7.input_tokens + d7.output_tokens,
    tokens_30d: d30.input_tokens + d30.output_tokens,
    input_tokens_24h: d1.input_tokens,
    output_tokens_24h: d1.output_tokens,
    input_tokens_7d: d7.input_tokens,
    output_tokens_7d: d7.output_tokens,
    input_tokens_30d: d30.input_tokens,
    output_tokens_30d: d30.output_tokens,
    estimated_cost_24h: `$${d1.cost_usd.toFixed(4)}`,
    estimated_cost_7d: `$${d7.cost_usd.toFixed(4)}`,
    estimated_cost_30d: `$${d30.cost_usd.toFixed(4)}`,
    calls_today: d1.calls,
    calls_7d: d7.calls,
    calls_30d: d30.calls,
    monthly_spend: status.spent_this_month,
    monthly_limit: status.config.monthly_limit_usd,
    pct_used: status.pct_used,
    throttle_level: status.throttle_level,
    by_agent_30d: byAgent,
    api_key_configured: !!(env.ANTHROPIC_API_KEY || env.LRX_API_KEY),
  }, ctx.origin);
});

// ─── Agent config (schedule/settings per agent) ─────────────────
export const handleAgentConfig = handler(async (_request, _env, ctx) => {
  const configs: Record<string, { schedule_label: string; enabled: boolean }> = {};
  for (const [name, schedule] of Object.entries(AGENT_SCHEDULES)) {
    configs[name] = { schedule_label: schedule, enabled: true };
  }
  return success(configs, ctx.origin);
});

// ─── Agent overview stats ───────────────────────────────────────
export const handleAgentStats = handler(async (_request, env, ctx) => {
  const summary = await env.DB.prepare(
    `SELECT
       COUNT(*) as total_runs,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failures,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
       SUM(records_processed) as total_processed,
       SUM(outputs_generated) as total_outputs,
       AVG(duration_ms) as avg_duration_ms
     FROM agent_runs`
  ).first();

  const todayRuns = await env.DB.prepare(
    `SELECT agent_id, COUNT(*) as runs, SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes
     FROM agent_runs WHERE started_at >= datetime('now', 'start of day')
     GROUP BY agent_id`
  ).all();

  const latestOutputs = await env.DB.prepare(
    `SELECT id, agent_id, type, summary, severity, created_at
     FROM agent_outputs ORDER BY created_at DESC LIMIT 10`
  ).all();

  return success({
    summary,
    todayByAgent: todayRuns.results,
    latestOutputs: latestOutputs.results,
  }, ctx.origin);
});

// ─── Reset agent circuit breaker ────────────────────────────────
export async function handleResetAgentCircuit(
  request: Request, env: Env, agentId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Verify agent exists in agentModules
    if (!agentModules[agentId]) {
      return error("Agent not found", 404, origin);
    }

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE agent_configs SET
           enabled = 1,
           paused_reason = NULL,
           consecutive_failures = 0,
           paused_at = NULL,
           paused_after_n_failures = NULL,
           updated_at = datetime('now')
         WHERE agent_id = ?`
      ).bind(agentId),
    ]);

    // Reflect the cleared breaker immediately (list is KV-cached 5 min).
    await env.CACHE.delete('agents_list:v4');

    return json({ success: true, data: { agent_id: agentId } }, 200, origin);
  } catch (err) {
    console.error(`[resetAgentCircuit] "${agentId}" threw:`, err);
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Update agent circuit breaker threshold ─────────────────────
export async function handleUpdateAgentThreshold(
  request: Request, env: Env, agentId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    if (!agentModules[agentId]) {
      return error("Agent not found", 404, origin);
    }

    const body = await parseBody<{ threshold: number | null }>(request);
    // NULL clears the per-agent override, reverting to the global default.
    const threshold = body.threshold;
    if (threshold !== null && (typeof threshold !== 'number' || threshold < 1)) {
      return error("Threshold must be a positive integer or null", 400, origin);
    }

    await env.DB.prepare(
      `UPDATE agent_configs SET consecutive_failure_threshold = ?, updated_at = datetime('now') WHERE agent_id = ?`
    ).bind(threshold, agentId).run();

    return json({ success: true, data: { agent_id: agentId, consecutive_failure_threshold: threshold } }, 200, origin);
  } catch (err) {
    console.error(`[updateAgentThreshold] "${agentId}" threw:`, err);
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Manually disable/enable an agent ───────────────────────────
export async function handleToggleAgent(
  request: Request, env: Env, agentId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    if (!agentModules[agentId]) {
      return error("Agent not found", 404, origin);
    }

    const body = await parseBody<{ enabled: boolean }>(request);
    const enabled = body.enabled ? 1 : 0;
    const pausedReason = enabled ? null : 'manual';

    await env.DB.prepare(
      `UPDATE agent_configs SET
         enabled = ?,
         paused_reason = ?,
         consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures END,
         paused_at = CASE WHEN ? = 0 THEN datetime('now') ELSE NULL END,
         paused_after_n_failures = CASE WHEN ? = 1 THEN NULL ELSE paused_after_n_failures END,
         updated_at = datetime('now')
       WHERE agent_id = ?`
    ).bind(enabled, pausedReason, enabled, enabled, enabled, agentId).run();

    // Reflect the pause/resume immediately (list is KV-cached 5 min).
    await env.CACHE.delete('agents_list:v4');

    return json({ success: true, data: { agent_id: agentId, enabled: !!enabled } }, 200, origin);
  } catch (err) {
    console.error(`[toggleAgent] "${agentId}" threw:`, err);
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
