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
import { computeIsStalled, isOrphanedRun } from "../src/agents/flightControl";

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
