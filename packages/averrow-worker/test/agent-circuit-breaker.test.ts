/**
 * Phase 4 Step 4 — agent circuit breaker regression tests.
 *
 * Covers the counter + threshold + gate contract from agentRunner.executeAgent():
 *   1. Successful run resets consecutive_failures to 0.
 *   2. Partial run resets consecutive_failures to 0.
 *   3. Failed run increments consecutive_failures by 1 and does NOT
 *      auto-trip while still below the threshold.
 *   4. Hitting the threshold flips enabled=0 and writes
 *      paused_reason='auto:consecutive_failures'.
 *   5. Hitting the threshold fires exactly ONE critical notification.
 *   6. flight_control and architect do NOT auto-trip even at 100
 *      consecutive failures.
 *   7. Manual Reset clears all five fields in one transaction.
 *   8. executeAgent() silent-skips with circuit_open status when
 *      enabled=0 (no agent_runs row written).
 *
 * These tests drive executeAgent() through a hand-rolled mock D1 that
 * records every prepare(...).bind(...).run()/first() call so we can
 * assert on the exact SQL shape that lands.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeAgent, PROTECTED_FROM_CIRCUIT_BREAKER } from "../src/lib/agentRunner";
import type { AgentModule, AgentResult, AgentContext } from "../src/lib/agentRunner";

// ─── Mock notifications module ───────────────────────────────────

const createNotificationMock = vi.fn().mockResolvedValue(1);
vi.mock("../src/lib/notifications", () => ({
  createNotification: (...args: unknown[]) => createNotificationMock(...args),
}));

// ─── Mock D1 ─────────────────────────────────────────────────────

interface StmtCall {
  sql: string;
  bindArgs: unknown[];
  op: "run" | "first" | "all" | "batch";
}

interface AgentConfigState {
  enabled: number;
  paused_reason: string | null;
  consecutive_failures: number;
  consecutive_failure_threshold: number | null;
  paused_at: string | null;
  paused_after_n_failures: number | null;
}

interface MockState {
  agent_configs: Record<string, AgentConfigState>;
  system_config: Record<string, string>;
  /** Track whether an agent_runs INSERT happened */
  agent_runs_inserted: boolean;
}

function makeMockDb(state: MockState) {
  const calls: StmtCall[] = [];

  const prepare = (sql: string) => {
    const bind = (...bindArgs: unknown[]) => {
      const runOp = async () => {
        calls.push({ sql, bindArgs, op: "run" });
        applySideEffect(state, sql, bindArgs);
        return { success: true };
      };
      const firstOp = async () => {
        calls.push({ sql, bindArgs, op: "first" });
        return readFirst(state, sql, bindArgs);
      };
      const allOp = async () => {
        calls.push({ sql, bindArgs, op: "all" });
        return { results: [] };
      };
      return { run: runOp, first: firstOp, all: allOp };
    };
    const firstNoBind = async () => {
      calls.push({ sql, bindArgs: [], op: "first" });
      return readFirst(state, sql, []);
    };
    return { bind, first: firstNoBind, run: async () => { calls.push({ sql, bindArgs: [], op: "run" }); return { success: true }; }, all: async () => ({ results: [] }) };
  };

  const batch = async (stmts: unknown[]) => {
    calls.push({ sql: "BATCH", bindArgs: [], op: "batch" });
    // Execute each statement in the batch
    for (const stmt of stmts) {
      if (stmt && typeof stmt === 'object' && 'run' in stmt) {
        await (stmt as { run: () => Promise<unknown> }).run();
      }
    }
    return [];
  };

  return { db: { prepare, batch } as unknown as D1Database, calls };
}

function applySideEffect(state: MockState, sql: string, args: unknown[]): void {
  // INSERT OR IGNORE agent_configs — create the row if it doesn't exist
  if (/INSERT OR IGNORE INTO agent_configs/i.test(sql)) {
    const agentId = String(args[0]);
    if (!state.agent_configs[agentId]) {
      state.agent_configs[agentId] = {
        enabled: 1,
        paused_reason: null,
        consecutive_failures: 0,
        consecutive_failure_threshold: null,
        paused_at: null,
        paused_after_n_failures: null,
      };
    }
    return;
  }

  // INSERT INTO agent_runs — track that it happened
  if (/INSERT INTO agent_runs/i.test(sql)) {
    state.agent_runs_inserted = true;
    return;
  }

  // UPDATE agent_configs SET consecutive_failures = 0
  if (/UPDATE agent_configs SET consecutive_failures = 0/i.test(sql)) {
    const agentId = String(args[args.length - 1]);
    if (state.agent_configs[agentId]) {
      state.agent_configs[agentId]!.consecutive_failures = 0;
    }
    return;
  }

  // UPDATE agent_configs SET consecutive_failures = ? (increment)
  if (/UPDATE agent_configs SET consecutive_failures = \?/i.test(sql) && typeof args[0] === 'number') {
    const agentId = String(args[args.length - 1]);
    if (state.agent_configs[agentId]) {
      state.agent_configs[agentId]!.consecutive_failures = args[0] as number;
    }
    return;
  }

  // UPDATE agent_configs SET enabled = 0 (trip)
  if (/UPDATE agent_configs SET\s+enabled = 0/i.test(sql)) {
    const agentId = String(args[args.length - 1]);
    if (state.agent_configs[agentId]) {
      state.agent_configs[agentId]!.enabled = 0;
      state.agent_configs[agentId]!.paused_reason = 'auto:consecutive_failures';
      state.agent_configs[agentId]!.paused_after_n_failures = typeof args[0] === 'number' ? args[0] as number : null;
    }
    return;
  }

  // UPDATE agent_configs SET enabled = 1 (reset) — used by the reset handler
  if (/UPDATE agent_configs SET\s+enabled = 1/i.test(sql)) {
    const agentId = String(args[args.length - 1]);
    if (state.agent_configs[agentId]) {
      state.agent_configs[agentId]!.enabled = 1;
      state.agent_configs[agentId]!.paused_reason = null;
      state.agent_configs[agentId]!.consecutive_failures = 0;
      state.agent_configs[agentId]!.paused_at = null;
      state.agent_configs[agentId]!.paused_after_n_failures = null;
    }
    return;
  }
}

function readFirst(state: MockState, sql: string, args: unknown[]): unknown {
  // SELECT enabled, paused_reason FROM agent_configs
  if (/SELECT enabled, paused_reason FROM agent_configs/i.test(sql)) {
    const agentId = String(args[0]);
    const cfg = state.agent_configs[agentId];
    return cfg ? { enabled: cfg.enabled, paused_reason: cfg.paused_reason } : null;
  }

  // SELECT consecutive_failures FROM agent_configs
  if (/SELECT consecutive_failures FROM agent_configs/i.test(sql)) {
    const agentId = String(args[0]);
    const cfg = state.agent_configs[agentId];
    return cfg ? { consecutive_failures: cfg.consecutive_failures } : null;
  }

  // SELECT consecutive_failure_threshold FROM agent_configs
  if (/SELECT consecutive_failure_threshold FROM agent_configs/i.test(sql)) {
    const agentId = String(args[0]);
    const cfg = state.agent_configs[agentId];
    return cfg ? { consecutive_failure_threshold: cfg.consecutive_failure_threshold } : null;
  }

  // SELECT enabled FROM agent_configs (for trip guard)
  if (/SELECT enabled FROM agent_configs/i.test(sql)) {
    const agentId = String(args[0]);
    const cfg = state.agent_configs[agentId];
    return cfg ? { enabled: cfg.enabled } : null;
  }

  // SELECT value FROM system_config
  if (/SELECT value FROM system_config/i.test(sql)) {
    return { value: state.system_config["agent_consecutive_failure_threshold"] ?? "3" };
  }

  // Phase 5.4b deployment-approval gate: every test agent is treated
  // as approved (matches the migration 0126 grandfather backfill so
  // these tests focus on circuit-breaker semantics, not approval).
  if (/FROM agent_approvals\s+WHERE agent_id =/i.test(sql)) {
    const agentId = String(args[0]);
    return {
      agent_id: agentId,
      state: "approved",
      requested_at: "2026-04-29T00:00:00Z",
      reviewed_at: "2026-04-29T00:00:00Z",
      reviewed_by: "system_grandfather",
      reviewer_notes: null,
      source_pr: null,
      created_at: "2026-04-29T00:00:00Z",
      updated_at: "2026-04-29T00:00:00Z",
    };
  }

  return null;
}

// ─── Fixtures ────────────────────────────────────────────────────

function makeSuccessAgent(name = "curator"): AgentModule {
  return {
    name: name as AgentModule["name"],
    displayName: "Test Agent",
    description: "Test",
    color: "#fff",
    trigger: "scheduled",
    execute: async (): Promise<AgentResult> => ({
      itemsProcessed: 10,
      itemsCreated: 0,
      itemsUpdated: 0,
      output: {},
    }),
  };
}

function makePartialAgent(name = "curator"): AgentModule {
  return {
    name: name as AgentModule["name"],
    displayName: "Test Agent",
    description: "Test",
    color: "#fff",
    trigger: "scheduled",
    execute: async (): Promise<AgentResult> => ({
      itemsProcessed: 5,
      itemsCreated: 0,
      itemsUpdated: 0,
      output: {},
      approvals: [{ actionType: "test", description: "test", details: {} }],
    }),
  };
}

function makeFailingAgent(name = "curator", msg = "boom"): AgentModule {
  return {
    name: name as AgentModule["name"],
    displayName: "Test Agent",
    description: "Test",
    color: "#fff",
    trigger: "scheduled",
    execute: async () => {
      throw new Error(msg);
    },
  };
}

function makeDefaultState(
  overrides: Partial<AgentConfigState> = {},
  agentId = "curator",
): MockState {
  return {
    agent_configs: {
      [agentId]: {
        enabled: 1,
        paused_reason: null,
        consecutive_failures: 0,
        consecutive_failure_threshold: null,
        paused_at: null,
        paused_after_n_failures: null,
        ...overrides,
      },
    },
    system_config: { agent_consecutive_failure_threshold: "3" },
    agent_runs_inserted: false,
  };
}

function makeEnv(db: D1Database) {
  return { DB: db, CACHE: { get: async () => null, put: async () => undefined } } as unknown as Parameters<typeof executeAgent>[0];
}

// ─── Tests ───────────────────────────────────────────────────────

describe("agent circuit breaker", () => {
  beforeEach(() => {
    createNotificationMock.mockClear();
  });

  it("resets consecutive_failures to 0 on successful run", async () => {
    const state = makeDefaultState({ consecutive_failures: 2 });
    const { db } = makeMockDb(state);

    const result = await executeAgent(makeEnv(db), makeSuccessAgent(), {}, null, "manual");

    expect(result.status).toBe("success");
    expect(state.agent_configs["curator"]!.consecutive_failures).toBe(0);
  });

  it("resets consecutive_failures to 0 on partial run", async () => {
    const state = makeDefaultState({ consecutive_failures: 2 });
    const { db } = makeMockDb(state);

    const result = await executeAgent(makeEnv(db), makePartialAgent(), {}, null, "manual");

    expect(result.status).toBe("partial");
    expect(state.agent_configs["curator"]!.consecutive_failures).toBe(0);
  });

  it("increments consecutive_failures on failed run and does NOT trip below threshold", async () => {
    const state = makeDefaultState({ consecutive_failures: 1 });
    const { db } = makeMockDb(state);

    const result = await executeAgent(makeEnv(db), makeFailingAgent(), {}, null, "manual");

    expect(result.status).toBe("failed");
    expect(state.agent_configs["curator"]!.consecutive_failures).toBe(2);
    // Still enabled — below threshold of 3
    expect(state.agent_configs["curator"]!.enabled).toBe(1);
    expect(state.agent_configs["curator"]!.paused_reason).toBeNull();
  });

  it("flips enabled=0 and sets paused_reason when hitting threshold", async () => {
    const state = makeDefaultState({ consecutive_failures: 2 });
    const { db } = makeMockDb(state);

    const result = await executeAgent(makeEnv(db), makeFailingAgent("curator", "D1 timeout"), {}, null, "manual");

    expect(result.status).toBe("failed");
    expect(state.agent_configs["curator"]!.consecutive_failures).toBe(3);
    expect(state.agent_configs["curator"]!.enabled).toBe(0);
    expect(state.agent_configs["curator"]!.paused_reason).toBe("auto:consecutive_failures");
    expect(state.agent_configs["curator"]!.paused_after_n_failures).toBe(3);
  });

  it("fires exactly one critical notification on circuit trip", async () => {
    const state = makeDefaultState({ consecutive_failures: 2 });
    const { db } = makeMockDb(state);

    await executeAgent(makeEnv(db), makeFailingAgent("curator", "D1 timeout"), {}, null, "manual");

    const criticalCalls = createNotificationMock.mock.calls.filter(
      (c) => (c[1] as { severity: string }).severity === "critical"
    );
    expect(criticalCalls).toHaveLength(1);
    const notif = criticalCalls[0]![1] as {
      type: string;
      severity: string;
      title: string;
      message: string;
      metadata: Record<string, unknown>;
    };
    expect(notif.type).toBe("circuit_breaker_tripped");
    expect(notif.severity).toBe("critical");
    expect(notif.title).toContain("curator");
    expect(notif.message).toContain("3");
    expect(notif.message).toContain("D1 timeout");
    expect(notif.metadata.auto_paused).toBe(true);
    expect(notif.metadata.consecutive_failures).toBe(3);
    expect(notif.metadata.threshold).toBe(3);
  });

  it("does NOT auto-trip flight_control even at 100 consecutive failures", async () => {
    const state = makeDefaultState({ consecutive_failures: 99 }, "flight_control");
    const { db } = makeMockDb(state);

    await executeAgent(makeEnv(db), makeFailingAgent("flight_control"), {}, null, "manual");

    expect(state.agent_configs["flight_control"]!.consecutive_failures).toBe(100);
    expect(state.agent_configs["flight_control"]!.enabled).toBe(1);
    expect(state.agent_configs["flight_control"]!.paused_reason).toBeNull();
    // No critical notification for protected agents
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("does NOT auto-trip architect even at 100 consecutive failures", async () => {
    const state = makeDefaultState({ consecutive_failures: 99 }, "architect");
    const { db } = makeMockDb(state);

    await executeAgent(makeEnv(db), makeFailingAgent("architect"), {}, null, "manual");

    expect(state.agent_configs["architect"]!.consecutive_failures).toBe(100);
    expect(state.agent_configs["architect"]!.enabled).toBe(1);
    expect(state.agent_configs["architect"]!.paused_reason).toBeNull();
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("silent-skips with circuit_open status when enabled=0 (no agent_runs row)", async () => {
    const state = makeDefaultState({
      enabled: 0,
      paused_reason: "auto:consecutive_failures",
      consecutive_failures: 3,
    });
    const { db, calls } = makeMockDb(state);

    const result = await executeAgent(makeEnv(db), makeSuccessAgent(), {}, null, "manual");

    expect(result.status).toBe("circuit_open");
    expect(result.reason).toBe("auto:consecutive_failures");
    expect(result.runId).toBe("");
    // No agent_runs INSERT should have happened
    expect(state.agent_runs_inserted).toBe(false);
    // Verify no agent_runs SQL was issued
    const agentRunsCalls = calls.filter(c => /INSERT INTO agent_runs/i.test(c.sql));
    expect(agentRunsCalls).toHaveLength(0);
  });

  it("respects per-agent threshold override from agent_configs", async () => {
    // Per-agent threshold is 2, global is 3
    const state = makeDefaultState({
      consecutive_failures: 1,
      consecutive_failure_threshold: 2,
    });
    const { db } = makeMockDb(state);

    await executeAgent(makeEnv(db), makeFailingAgent(), {}, null, "manual");

    expect(state.agent_configs["curator"]!.consecutive_failures).toBe(2);
    expect(state.agent_configs["curator"]!.enabled).toBe(0);
    expect(state.agent_configs["curator"]!.paused_reason).toBe("auto:consecutive_failures");
  });

  it("uses global threshold when per-agent threshold is null", async () => {
    // Per-agent is null, global is 3. At 1 failure, next failure → 2, still below 3
    const state = makeDefaultState({ consecutive_failures: 1 });
    const { db } = makeMockDb(state);

    await executeAgent(makeEnv(db), makeFailingAgent(), {}, null, "manual");

    expect(state.agent_configs["curator"]!.consecutive_failures).toBe(2);
    expect(state.agent_configs["curator"]!.enabled).toBe(1); // still below threshold of 3
  });

  it("does not re-fire notification if agent is already tripped", async () => {
    // Already tripped — concurrent run hit threshold first
    const state = makeDefaultState({
      enabled: 0,
      paused_reason: "auto:consecutive_failures",
      consecutive_failures: 3,
    });
    const { db } = makeMockDb(state);

    // This will return circuit_open — no execution at all
    await executeAgent(makeEnv(db), makeFailingAgent(), {}, null, "manual");

    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("creates agent_configs row lazily for new agents", async () => {
    const state: MockState = {
      agent_configs: {}, // no pre-existing config
      system_config: { agent_consecutive_failure_threshold: "3" },
      agent_runs_inserted: false,
    };
    const { db } = makeMockDb(state);

    const result = await executeAgent(makeEnv(db), makeSuccessAgent("curator"), {}, null, "manual");

    expect(result.status).toBe("success");
    // INSERT OR IGNORE should have created the row
    expect(state.agent_configs["curator"]).toBeDefined();
    expect(state.agent_configs["curator"]!.enabled).toBe(1);
    expect(state.agent_configs["curator"]!.consecutive_failures).toBe(0);
  });
});

describe("PROTECTED_FROM_CIRCUIT_BREAKER", () => {
  it("contains flight_control and architect", () => {
    expect(PROTECTED_FROM_CIRCUIT_BREAKER.has("flight_control")).toBe(true);
    expect(PROTECTED_FROM_CIRCUIT_BREAKER.has("architect")).toBe(true);
  });

  it("does not contain regular agents", () => {
    expect(PROTECTED_FROM_CIRCUIT_BREAKER.has("curator")).toBe(false);
    expect(PROTECTED_FROM_CIRCUIT_BREAKER.has("sentinel")).toBe(false);
    expect(PROTECTED_FROM_CIRCUIT_BREAKER.has("analyst")).toBe(false);
  });
});
