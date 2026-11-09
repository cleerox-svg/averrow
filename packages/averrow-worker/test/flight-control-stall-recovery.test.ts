/**
 * FC recovery-loop regression tests — completed_at-aware stall detection.
 *
 * Background: before this fix, `getAgentHealth`'s is_stalled predicate
 * treated ANY 'partial' run older than 45 minutes as stalled, and
 * `recoverStalledAgents`'s orphan-clear force-failed any 'status=running'
 * row. Neither distinguished a legitimately-finished 'partial' run (the
 * approvals-driven finalize path stamps completed_at and status='partial')
 * from a killed orphan (worker died after the INSERT but before the
 * finalize UPDATE, leaving completed_at NULL). That produced a false-
 * recovery loop for strategist/cartographer: FC kept re-dispatching agents
 * that had actually finished.
 *
 * The fix makes both the stall predicate and the recovery force-fail
 * completed_at-aware:
 *   - is_stalled's 45-min partial clause only fires when completed_at IS NULL.
 *   - The recovery orphan-clear force-fails 'running' rows (unchanged) AND
 *     'partial' rows with completed_at IS NULL (new), but never a finished
 *     'partial' with completed_at SET.
 *
 * computeIsStalled / isOrphanedRun are pure decision helpers extracted from
 * (respectively) getAgentHealth and recoverStalledAgents in
 * src/agents/flightControl.ts specifically for this test — both functions
 * pull in dynamic agent-module imports, joined D1 queries, and
 * ctx.waitUntil/executeAgent dispatch that aren't worth mocking just to
 * exercise these predicates, and the test suite has no existing D1-mock
 * harness that reaches this deep. The extraction is behavior-preserving:
 * getAgentHealth/recoverStalledAgents call the exported helpers with the
 * exact same inputs the inline expressions used.
 */

import { describe, it, expect } from "vitest";
import {
  computeIsStalled,
  isOrphanedRun,
  decideStallRecovery,
  stallRecoveryCooldownMs,
  parseStallRecoveryRecord,
  isStallRecoveryCoolingDown,
  MAX_STALL_RECOVERIES_PER_TICK,
  SCHEDULE_OWNED_AGENTS,
  STALL_RECOVERY_COOLDOWN_BASE_MS,
  STALL_RECOVERY_COOLDOWN_MAX_MS,
  STALL_RECOVERY_KV_PREFIX,
  ORPHAN_FORCE_FAIL_MESSAGE,
  effectiveStallRecoveryRecord,
  planStallRecoveries,
  type AgentHealth,
} from "../src/agents/flightControl";
import { agentModules } from "../src/agents/index";

const FORTY_FIVE_MIN_MS = 45 * 60 * 1000;
const THRESHOLD_MS = 60 * 60 * 1000; // typical agent stallThresholdMinutes=60

describe("computeIsStalled — truth table over {status} x {age}", () => {
  // ─── status='running' ───────────────────────────────────────────
  it("running, young (< threshold) → not stalled", () => {
    expect(computeIsStalled({
      lastRunAgeMs: 5 * 60 * 1000,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'running',
      lastRunCompletedAt: null,
    })).toBe(false);
  });

  it("running, > 45min but < threshold → not stalled (45-min clause is partial-only)", () => {
    expect(computeIsStalled({
      lastRunAgeMs: 50 * 60 * 1000,
      thresholdMs: 90 * 60 * 1000,
      isWorkflowAgent: false,
      lastRunStatus: 'running',
      lastRunCompletedAt: null,
    })).toBe(false);
  });

  it("running, > threshold → stalled (hard ceiling)", () => {
    expect(computeIsStalled({
      lastRunAgeMs: THRESHOLD_MS + 1,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'running',
      lastRunCompletedAt: null,
    })).toBe(true);
  });

  // ─── status='partial', completed_at SET (legitimately finished) ──
  it("partial+completed, young → not stalled", () => {
    expect(computeIsStalled({
      lastRunAgeMs: 5 * 60 * 1000,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'partial',
      lastRunCompletedAt: '2026-07-24T10:00:00',
    })).toBe(false);
  });

  it("partial+completed, > 45min but < threshold → not stalled", () => {
    expect(computeIsStalled({
      lastRunAgeMs: FORTY_FIVE_MIN_MS + 1,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'partial',
      lastRunCompletedAt: '2026-07-24T10:00:00',
    })).toBe(false);
  });

  it("partial+completed, > threshold → still NOT stalled via the 45-min clause, but the hard ceiling stands", () => {
    // A finished partial with completed_at set never trips the partial-orphan
    // clause, but the hard age ceiling still applies (e.g. a stale row that
    // was never re-run) — same as any other finished status.
    expect(computeIsStalled({
      lastRunAgeMs: THRESHOLD_MS + 1,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'partial',
      lastRunCompletedAt: '2026-07-24T10:00:00',
    })).toBe(true);
  });

  it("partial+completed, just under threshold and > 45min → not stalled (the false-recovery-loop regression case)", () => {
    // This is the exact case that produced the strategist/cartographer
    // false-recovery loop pre-fix: a finished partial sitting ~50-59 min old,
    // under a 60-min threshold. Old code: (partial && age>45min) → stalled.
    // Fixed code: completed_at is set → not an orphan → not stalled.
    expect(computeIsStalled({
      lastRunAgeMs: 55 * 60 * 1000,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'partial',
      lastRunCompletedAt: '2026-07-24T10:00:00',
    })).toBe(false);
  });

  // ─── status='partial', completed_at NULL (killed orphan) ──────────
  it("partial+null, young → not stalled", () => {
    expect(computeIsStalled({
      lastRunAgeMs: 5 * 60 * 1000,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'partial',
      lastRunCompletedAt: null,
    })).toBe(false);
  });

  it("partial+null, > 45min (even under threshold) → stalled (killed orphan)", () => {
    expect(computeIsStalled({
      lastRunAgeMs: FORTY_FIVE_MIN_MS + 1,
      thresholdMs: THRESHOLD_MS, // 60min threshold, well above 45min age
      isWorkflowAgent: false,
      lastRunStatus: 'partial',
      lastRunCompletedAt: null,
    })).toBe(true);
  });

  it("partial+null, right at the 45-min boundary (not exceeded) → not stalled", () => {
    expect(computeIsStalled({
      lastRunAgeMs: FORTY_FIVE_MIN_MS,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'partial',
      lastRunCompletedAt: null,
    })).toBe(false);
  });

  it("partial+null, > threshold → stalled (hard ceiling too)", () => {
    expect(computeIsStalled({
      lastRunAgeMs: THRESHOLD_MS + 1,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'partial',
      lastRunCompletedAt: null,
    })).toBe(true);
  });

  // ─── status='success' ──────────────────────────────────────────
  it("success, young → not stalled", () => {
    expect(computeIsStalled({
      lastRunAgeMs: 5 * 60 * 1000,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'success',
      lastRunCompletedAt: '2026-07-24T10:00:00',
    })).toBe(false);
  });

  it("success, > 45min but < threshold → not stalled (45-min clause is partial-only)", () => {
    expect(computeIsStalled({
      lastRunAgeMs: FORTY_FIVE_MIN_MS + 1,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'success',
      lastRunCompletedAt: '2026-07-24T10:00:00',
    })).toBe(false);
  });

  it("success, > threshold → stalled (hard ceiling)", () => {
    expect(computeIsStalled({
      lastRunAgeMs: THRESHOLD_MS + 1,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'success',
      lastRunCompletedAt: '2026-07-24T10:00:00',
    })).toBe(true);
  });

  // ─── failed status, for completeness ───────────────────────────
  it("failed, > 45min but < threshold → not stalled (45-min clause is partial-only)", () => {
    expect(computeIsStalled({
      lastRunAgeMs: FORTY_FIVE_MIN_MS + 1,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'failed',
      lastRunCompletedAt: '2026-07-24T10:00:00',
    })).toBe(false);
  });

  // ─── workflow-agent exclusion (nexus etc.) ─────────────────────
  it("workflow agent, partial+null, > 45min under threshold → NOT stalled (wf path skips the partial-orphan clause entirely)", () => {
    expect(computeIsStalled({
      lastRunAgeMs: FORTY_FIVE_MIN_MS + 1,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: true,
      lastRunStatus: 'partial',
      lastRunCompletedAt: null,
    })).toBe(false);
  });

  it("workflow agent, > threshold → stalled (hard ceiling still applies)", () => {
    expect(computeIsStalled({
      lastRunAgeMs: THRESHOLD_MS + 1,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: true,
      lastRunStatus: 'partial',
      lastRunCompletedAt: null,
    })).toBe(true);
  });

  // ─── null status (no runs yet) ─────────────────────────────────
  it("null status, Infinity age (never run) → stalled via hard ceiling", () => {
    expect(computeIsStalled({
      lastRunAgeMs: Infinity,
      thresholdMs: THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: null,
      lastRunCompletedAt: null,
    })).toBe(true);
  });
});

describe("isOrphanedRun — recovery force-fail predicate", () => {
  it("status='running' → orphaned regardless of completed_at", () => {
    expect(isOrphanedRun({ status: 'running', completedAt: null })).toBe(true);
  });

  it("status='running' with completed_at set (shouldn't happen, but defensive) → still orphaned", () => {
    // agentRunner never sets completed_at while status stays 'running', but
    // the predicate is status-driven for the running branch, matching the
    // pre-fix behavior for that status exactly.
    expect(isOrphanedRun({ status: 'running', completedAt: '2026-07-24T10:00:00' })).toBe(true);
  });

  it("status='partial' + completed_at NULL → orphaned (killed mid-execution)", () => {
    expect(isOrphanedRun({ status: 'partial', completedAt: null })).toBe(true);
  });

  it("status='partial' + completed_at SET → NOT orphaned (legitimately finished)", () => {
    expect(isOrphanedRun({ status: 'partial', completedAt: '2026-07-24T10:00:00' })).toBe(false);
  });

  it("status='success' → never orphaned", () => {
    expect(isOrphanedRun({ status: 'success', completedAt: '2026-07-24T10:00:00' })).toBe(false);
    expect(isOrphanedRun({ status: 'success', completedAt: null })).toBe(false);
  });

  it("status='failed' → never orphaned (already terminal, not re-recovered)", () => {
    expect(isOrphanedRun({ status: 'failed', completedAt: '2026-07-24T10:00:00' })).toBe(false);
    expect(isOrphanedRun({ status: 'failed', completedAt: null })).toBe(false);
  });

  it("status=null → never orphaned", () => {
    expect(isOrphanedRun({ status: null, completedAt: null })).toBe(false);
  });
});

// ─── Recovery-storm fix (2026-11-09) ──────────────────────────────
//
// FC used to re-dispatch every stalled agent inline in the hourly
// orchestrator invocation; the recoveries starved feed ingestion, died as
// partial orphans, and were re-recovered on the next tick. These pin the
// dispatch decision, which is separate from (and does not change)
// computeIsStalled.

const HOUR_MS = 60 * 60 * 1000;
const NOT_OWNED = new Set<string>();
/** Daily/weekly hour-gated mesh agents — FC is their only catch-up path. */
const GATED_RECOVERABLE = [
  'observer', 'seed_strategist', 'narrator', 'notification_narrator', 'auto_seeder', 'geoip_refresh',
] as const;

describe("SCHEDULE_OWNED_AGENTS excludes the hour-gated daily/weekly agents", () => {
  it.each(GATED_RECOVERABLE)("%s is FC-recoverable (not schedule-owned)", (id) => {
    expect(SCHEDULE_OWNED_AGENTS.has(id)).toBe(false);
  });
});

describe("decideStallRecovery — schedule-owned skip", () => {
  it.each([
    'sentinel', 'analyst', 'attributor', 'news_watcher', 'enricher', 'cartographer',
  ])("%s (re-run by its own schedule) is never re-dispatched", (agentId) => {
    expect(decideStallRecovery({
      agentId,
      lastRunAgeMs: 48 * HOUR_MS,
      thresholdMs: HOUR_MS,
      inCooldown: false,
      dispatchedThisTick: 0,
    })).toBe('skip_schedule_owned');
  });

  it("schedule-owned wins over every other gate", () => {
    expect(decideStallRecovery({
      agentId: 'analyst',
      lastRunAgeMs: 48 * HOUR_MS,
      thresholdMs: HOUR_MS,
      inCooldown: true,
      dispatchedThisTick: 99,
    })).toBe('skip_schedule_owned');
  });

  it("every SCHEDULE_OWNED_AGENTS entry is a registered agent (no typos / stale ids)", () => {
    for (const id of SCHEDULE_OWNED_AGENTS) {
      expect(agentModules[id], `unknown agent id in SCHEDULE_OWNED_AGENTS: ${id}`).toBeDefined();
    }
  });

  it("every schedulable agent is classified (schedule-owned, or nexus with its own workflow guard)", () => {
    // Drift guard: an agent added to the registry with a scheduled/event
    // trigger must be consciously placed. If it really has no schedule and
    // FC recovery is its only re-run path, add it to FC_RECOVERABLE below.
    const FC_RECOVERABLE = new Set<string>(GATED_RECOVERABLE);
    const unclassified = Object.entries(agentModules)
      .filter(([, mod]) => mod.trigger !== 'manual' && mod.trigger !== 'api')
      .map(([id]) => id)
      .filter((id) => id !== 'nexus' && !SCHEDULE_OWNED_AGENTS.has(id) && !FC_RECOVERABLE.has(id));
    expect(unclassified).toEqual([]);
  });
});

describe("decideStallRecovery — daily-agent orphan is not re-dispatched", () => {
  const DAILY_THRESHOLD_MS = 1500 * 60 * 1000; // observer / seed_strategist / narrator

  it("partial orphan 70 min old on a 1500-min agent → stalled, but only cleared, not re-run", () => {
    // computeIsStalled still flags it (the notification path is unchanged)...
    expect(computeIsStalled({
      lastRunAgeMs: 70 * 60 * 1000,
      thresholdMs: DAILY_THRESHOLD_MS,
      isWorkflowAgent: false,
      lastRunStatus: 'partial',
      lastRunCompletedAt: null,
    })).toBe(true);
    // ...but recovery does not re-dispatch it (tested without the
    // schedule-owned set so the orphan-only gate itself is exercised).
    expect(decideStallRecovery({
      agentId: 'observer',
      lastRunAgeMs: 70 * 60 * 1000,
      thresholdMs: DAILY_THRESHOLD_MS,
      inCooldown: false,
      dispatchedThisTick: 0,
      scheduleOwned: NOT_OWNED,
    })).toBe('skip_orphan_only');
  });

  it("age exactly at the threshold is still orphan-only (strict >)", () => {
    expect(decideStallRecovery({
      agentId: 'x', lastRunAgeMs: HOUR_MS, thresholdMs: HOUR_MS,
      inCooldown: false, dispatchedThisTick: 0, scheduleOwned: NOT_OWNED,
    })).toBe('skip_orphan_only');
  });

  it("NaN age (unparseable timestamp) is treated as not overdue", () => {
    expect(decideStallRecovery({
      agentId: 'x', lastRunAgeMs: Number.NaN, thresholdMs: HOUR_MS,
      inCooldown: false, dispatchedThisTick: 0, scheduleOwned: NOT_OWNED,
    })).toBe('skip_orphan_only');
  });

  it("past its own threshold (genuinely overdue) → dispatch", () => {
    expect(decideStallRecovery({
      agentId: 'x', lastRunAgeMs: 26 * HOUR_MS, thresholdMs: DAILY_THRESHOLD_MS,
      inCooldown: false, dispatchedThisTick: 0, scheduleOwned: NOT_OWNED,
    })).toBe('dispatch');
  });

  it("never-run agent (Infinity age) → dispatch", () => {
    expect(decideStallRecovery({
      agentId: 'x', lastRunAgeMs: Infinity, thresholdMs: HOUR_MS,
      inCooldown: false, dispatchedThisTick: 0, scheduleOwned: NOT_OWNED,
    })).toBe('dispatch');
  });
});

describe("decideStallRecovery — per-tick budget cap", () => {
  it("MAX_STALL_RECOVERIES_PER_TICK is a small fixed number (1 or 2)", () => {
    expect([1, 2]).toContain(MAX_STALL_RECOVERIES_PER_TICK);
  });

  it("8 overdue unowned agents in one tick → exactly MAX dispatched, rest deferred", () => {
    let dispatched = 0;
    const decisions = Array.from({ length: 8 }, (_, i) => {
      const d = decideStallRecovery({
        agentId: `agent_${i}`, lastRunAgeMs: 5 * HOUR_MS, thresholdMs: HOUR_MS,
        inCooldown: false, dispatchedThisTick: dispatched, scheduleOwned: NOT_OWNED,
      });
      if (d === 'dispatch') dispatched++;
      return d;
    });
    expect(dispatched).toBe(MAX_STALL_RECOVERIES_PER_TICK);
    expect(decisions.filter((d) => d === 'defer_budget')).toHaveLength(8 - MAX_STALL_RECOVERIES_PER_TICK);
  });

  it("respects an explicit maxPerTick override", () => {
    expect(decideStallRecovery({
      agentId: 'x', lastRunAgeMs: 5 * HOUR_MS, thresholdMs: HOUR_MS,
      inCooldown: false, dispatchedThisTick: 1, maxPerTick: 2, scheduleOwned: NOT_OWNED,
    })).toBe('dispatch');
    expect(decideStallRecovery({
      agentId: 'x', lastRunAgeMs: 5 * HOUR_MS, thresholdMs: HOUR_MS,
      inCooldown: false, dispatchedThisTick: 2, maxPerTick: 2, scheduleOwned: NOT_OWNED,
    })).toBe('defer_budget');
  });
});

describe("stall recovery cooldown / backoff", () => {
  it("in cooldown → skip_cooldown (budget left)", () => {
    expect(decideStallRecovery({
      agentId: 'x', lastRunAgeMs: 5 * HOUR_MS, thresholdMs: HOUR_MS,
      inCooldown: true, dispatchedThisTick: 0, scheduleOwned: NOT_OWNED,
    })).toBe('skip_cooldown');
  });

  it("budget is checked before cooldown (so the KV read is only paid when dispatch is possible)", () => {
    expect(decideStallRecovery({
      agentId: 'x', lastRunAgeMs: 5 * HOUR_MS, thresholdMs: HOUR_MS,
      inCooldown: true, dispatchedThisTick: MAX_STALL_RECOVERIES_PER_TICK, scheduleOwned: NOT_OWNED,
    })).toBe('defer_budget');
  });

  it("backoff doubles from the base and caps", () => {
    expect(stallRecoveryCooldownMs(1)).toBe(STALL_RECOVERY_COOLDOWN_BASE_MS);
    expect(stallRecoveryCooldownMs(2)).toBe(STALL_RECOVERY_COOLDOWN_BASE_MS * 2);
    expect(stallRecoveryCooldownMs(3)).toBe(STALL_RECOVERY_COOLDOWN_BASE_MS * 4);
    expect(stallRecoveryCooldownMs(50)).toBe(STALL_RECOVERY_COOLDOWN_MAX_MS);
    expect(stallRecoveryCooldownMs(0)).toBe(STALL_RECOVERY_COOLDOWN_BASE_MS);
  });

  it("an hourly re-check right after a recovery is inside the cooldown", () => {
    const now = Date.UTC(2026, 10, 9, 12, 7);
    const rec = { attempts: 1, last_at: now - HOUR_MS };
    expect(isStallRecoveryCoolingDown(rec, now)).toBe(true);
    expect(isStallRecoveryCoolingDown(rec, now + 2 * HOUR_MS)).toBe(false);
    expect(isStallRecoveryCoolingDown({ attempts: 3, last_at: now - 7 * HOUR_MS }, now)).toBe(true);
    expect(isStallRecoveryCoolingDown(null, now)).toBe(false);
  });

  it("parseStallRecoveryRecord tolerates missing / malformed KV values", () => {
    expect(parseStallRecoveryRecord(null)).toBeNull();
    expect(parseStallRecoveryRecord('')).toBeNull();
    expect(parseStallRecoveryRecord('not json')).toBeNull();
    expect(parseStallRecoveryRecord('42')).toBeNull();
    expect(parseStallRecoveryRecord('{"attempts":"1","last_at":5}')).toBeNull();
    expect(parseStallRecoveryRecord('{"attempts":2,"last_at":1700000000000}'))
      .toEqual({ attempts: 2, last_at: 1700000000000 });
  });
});

describe("effectiveStallRecoveryRecord — backoff resets after a finished run", () => {
  const rec = { attempts: 3, last_at: 1_700_000_000_000 };
  it("no record → null", () => {
    expect(effectiveStallRecoveryRecord(null, { status: 'failed', completedAt: 'x' })).toBeNull();
  });
  it("latest run finished successfully → reset", () => {
    expect(effectiveStallRecoveryRecord(rec, { status: 'success', completedAt: '2026-11-09 01:00:00' })).toBeNull();
  });
  it("latest run finished partial (completed_at set) → reset", () => {
    expect(effectiveStallRecoveryRecord(rec, { status: 'partial', completedAt: '2026-11-09 01:00:00' })).toBeNull();
  });
  it("latest run is an orphan or failed → record kept (backoff escalates)", () => {
    expect(effectiveStallRecoveryRecord(rec, { status: 'partial', completedAt: null })).toEqual(rec);
    expect(effectiveStallRecoveryRecord(rec, { status: 'running', completedAt: null })).toEqual(rec);
    expect(effectiveStallRecoveryRecord(rec, { status: 'failed', completedAt: '2026-11-09 01:00:00' })).toEqual(rec);
  });
});

// ─── planStallRecoveries — the recovery loop with mocked D1 + KV ──────

interface FakeStmt { sql: string; args: unknown[] }

function fakeDb(): D1Database {
  return {
    prepare(sql: string) {
      return { bind: (...args: unknown[]): FakeStmt => ({ sql, args }) };
    },
  } as unknown as D1Database;
}

function fakeKv(initial: Record<string, string> = {}, opts: { throwOnGet?: boolean; throwOnPut?: boolean } = {}) {
  const store = new Map(Object.entries(initial));
  const puts: Array<{ key: string; value: string; ttl?: number }> = [];
  const kv = {
    async get(key: string) {
      if (opts.throwOnGet) throw new Error('kv down');
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, o?: { expirationTtl?: number }) {
      if (opts.throwOnPut) throw new Error('kv down');
      puts.push({ key, value, ttl: o?.expirationTtl });
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, store, puts };
}

const NOW = Date.UTC(2026, 10, 9, 12, 7, 40);
/** agent_runs.started_at format, `hoursAgo` before NOW. */
function startedAt(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * HOUR_MS).toISOString().slice(0, 19).replace('T', ' ');
}
function stalled(agent_id: string, hoursAgo: number, status: string | null = 'partial', completed: string | null = null): AgentHealth {
  return {
    agent_id,
    last_run_at: startedAt(hoursAgo),
    last_run_status: status,
    last_run_completed_at: completed,
    avg_duration_ms: 0,
    is_stalled: true,
    circuit_state: 'closed',
    consecutive_failures: 0,
    paused_reason: null,
    paused_after_n_failures: null,
    paused_at: null,
  };
}
const thresholdsMinutes = new Map(Object.entries(agentModules).map(([id, m]) => [id, m.stallThresholdMinutes]));

async function plan(health: AgentHealth[], kv: KVNamespace) {
  const res = await planStallRecoveries(health, {
    db: fakeDb(), cache: kv, modules: agentModules, thresholdsMinutes, nowMs: NOW,
  });
  const stmts = res.statements as unknown as FakeStmt[];
  return { ...res, stmts };
}
const decisionOf = (r: { decisions: Array<{ agentId: string; decision: string }> }, id: string) =>
  r.decisions.find((d) => d.agentId === id)?.decision;

describe("planStallRecoveries", () => {
  it("the six hour-gated agents are dispatched only once overdue past their own threshold", async () => {
    for (const id of GATED_RECOVERABLE) {
      const thresholdH = (thresholdsMinutes.get(id) ?? 60) / 60;
      // Killed run, orphan-stalled but within its own threshold → cleared only.
      const young = await plan([stalled(id, 2)], fakeKv().kv);
      expect(decisionOf(young, id), id).toBe('skip_orphan_only');
      expect(young.toRecover).toHaveLength(0);
      // Overdue → dispatched.
      const old = await plan([stalled(id, thresholdH + 1)], fakeKv().kv);
      expect(decisionOf(old, id), id).toBe('dispatch');
      expect(old.toRecover.map((r) => r.agentId)).toEqual([id]);
    }
  });

  it("the incident's storm set produces zero dispatches", async () => {
    const health = ['sentinel', 'analyst', 'enricher', 'attributor', 'news_watcher', 'cartographer']
      .map((id) => stalled(id, 3))
      .concat([stalled('observer', 1.1), stalled('seed_strategist', 1.1)]);
    const r = await plan(health, fakeKv().kv);
    expect(r.toRecover).toHaveLength(0);
  });

  it("orphan is force-failed even when the decision is a skip", async () => {
    const r = await plan([stalled('analyst', 3, 'partial', null), stalled('observer', 2, 'running', null)], fakeKv().kv);
    expect(decisionOf(r, 'analyst')).toBe('skip_schedule_owned');
    expect(decisionOf(r, 'observer')).toBe('skip_orphan_only');
    const updates = r.stmts.filter((s) => s.sql.includes('UPDATE agent_runs'));
    expect(updates.map((u) => u.args[1])).toEqual(['analyst', 'observer']);
    for (const u of updates) expect(u.args[0]).toBe(ORPHAN_FORCE_FAIL_MESSAGE);
    // And each gets an activity row explaining the skip.
    const logs = r.stmts.filter((s) => s.sql.includes('agent_activity_log'));
    expect(logs.map((l) => l.args[2])).toEqual(['recovery_skipped', 'recovery_skipped']);
  });

  it("does not force-fail a finished run", async () => {
    const r = await plan([stalled('observer', 30, 'success', startedAt(29.9))], fakeKv().kv);
    expect(r.stmts.some((s) => s.sql.includes('UPDATE agent_runs'))).toBe(false);
  });

  it("a cooldown-skipped agent does not use up the per-tick slot", async () => {
    const { kv } = fakeKv({
      [STALL_RECOVERY_KV_PREFIX + 'observer']: JSON.stringify({ attempts: 1, last_at: NOW - HOUR_MS }),
    });
    const r = await plan([stalled('observer', 30), stalled('narrator', 30)], kv);
    expect(decisionOf(r, 'observer')).toBe('skip_cooldown');
    expect(decisionOf(r, 'narrator')).toBe('dispatch');
    expect(r.toRecover.map((x) => x.agentId)).toEqual(['narrator']);
  });

  it("only MAX_STALL_RECOVERIES_PER_TICK dispatch; the rest are deferred and logged", async () => {
    const r = await plan([stalled('observer', 30), stalled('narrator', 30), stalled('seed_strategist', 30)], fakeKv().kv);
    expect(r.toRecover).toHaveLength(MAX_STALL_RECOVERIES_PER_TICK);
    const deferred = r.stmts.filter((s) => s.sql.includes('agent_activity_log') && s.args[2] === 'recovery_deferred');
    expect(deferred).toHaveLength(3 - MAX_STALL_RECOVERIES_PER_TICK);
  });

  it("attempts increments across consecutive failed recoveries, with escalating TTL", async () => {
    const { kv, puts } = fakeKv({
      // Last recovery 3h ago (past the 2h attempt-1 cooldown) and it died.
      [STALL_RECOVERY_KV_PREFIX + 'observer']: JSON.stringify({ attempts: 1, last_at: NOW - 3 * HOUR_MS }),
    });
    const r = await plan([stalled('observer', 30, 'partial', null)], kv);
    expect(r.decisions[0]).toEqual({ agentId: 'observer', decision: 'dispatch', attempt: 2 });
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]!.value)).toEqual({ attempts: 2, last_at: NOW });
    expect(puts[0]!.ttl).toBe((2 * stallRecoveryCooldownMs(2)) / 1000);
  });

  it("attempts resets to 1 when the latest run finished (previous recovery worked)", async () => {
    const { kv, puts } = fakeKv({
      [STALL_RECOVERY_KV_PREFIX + 'observer']: JSON.stringify({ attempts: 4, last_at: NOW - HOUR_MS }),
    });
    // In cooldown by the record, but the latest run is a completed success
    // → record reset → no cooldown, attempt 1.
    const r = await plan([stalled('observer', 26, 'success', startedAt(25.9))], kv);
    expect(r.decisions[0]).toEqual({ agentId: 'observer', decision: 'dispatch', attempt: 1 });
    expect(JSON.parse(puts[0]!.value).attempts).toBe(1);
  });

  it("KV errors are best-effort: no throw, dispatch proceeds", async () => {
    const { kv } = fakeKv({}, { throwOnGet: true, throwOnPut: true });
    const r = await plan([stalled('observer', 30)], kv);
    expect(r.toRecover.map((x) => x.agentId)).toEqual(['observer']);
  });

  it("nexus and manual/api agents are untouched (no statements)", async () => {
    const r = await plan([stalled('nexus', 30), stalled('pathfinder', 30), stalled('brand_report', 30)], fakeKv().kv);
    expect(r.stmts).toHaveLength(0);
    expect(r.decisions).toHaveLength(0);
  });
});
