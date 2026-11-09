/**
 * Flight Control `scaleAgents`. (1) Inside the :07 cron (execCtx present)
 * Cartographer is deferred to its dedicated :09 cron, never dispatched via
 * waitUntil; a manual run (no execCtx) still awaits it. (2) The AI-budget gate applies to AI agents
 * only. Cartographer runs on rules since AI_STRATEGY_2026-10 Phase 1, so
 * `pause_all_ai` must NOT stop it draining the enrichment backlog, while
 * Analyst stays gated.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentContext } from "../src/lib/agentRunner";
import type { AgentBudgetLimits, BudgetStatus } from "../src/lib/budgetManager";
import type { Backlog } from "../src/agents/flightControl";

const { executeAgentSpy } = vi.hoisted(() => ({ executeAgentSpy: vi.fn() }));

vi.mock("../src/agents/index", () => ({
  agentModules: {
    cartographer: { name: "cartographer" },
    analyst: { name: "analyst" },
  },
}));
vi.mock("../src/lib/agentRunner", () => ({ executeAgent: executeAgentSpy }));

const { scaleAgents } = await import("../src/agents/flightControl");

function fakeDb() {
  const logged: Array<{ params: unknown[] }> = [];
  const db = {
    prepare: () => ({
      bind: (...params: unknown[]) => ({
        run: async () => {
          logged.push({ params });
          return { meta: {} };
        },
      }),
    }),
  };
  return { db: db as unknown as D1Database, logged };
}

function backlog(over: Partial<Backlog>): Backlog {
  return {
    cartographer: 0, analyst: 0, totalUnlinked: 0, totalNoGeo: 0,
    surblUnchecked: 0, vtUnchecked: 0, gsbUnchecked: 0, dblUnchecked: 0,
    abuseipdbUnchecked: 0, pdnsUnchecked: 0, greynoiseUnchecked: 0,
    seclookupUnchecked: 0, watchdog: 0, domainGeoBacklog: 0,
    domainGeoDrainable: 0, brandEnrichBacklog: 0, lookalikeDnsDue: 0,
    lookalikeParked: 0,
    ...over,
  };
}

const limits = (pause: boolean): AgentBudgetLimits => ({
  analyst_batch: 10, cartographer_batch: 10, skip_observer: pause,
  skip_curator: pause, pause_all_ai: pause,
});

const budget = {
  throttle_level: "emergency", spent_this_month: 50,
  config: { monthly_limit_usd: 50 },
} as unknown as BudgetStatus;

function ctx(execCtx?: ExecutionContext): AgentContext {
  return {
    env: {} as AgentContext["env"], runId: "r", agentName: "flight_control",
    input: execCtx ? { _executionCtx: execCtx } : {}, triggeredBy: null,
  };
}

function fakeExecCtx() {
  const waited: Array<Promise<unknown>> = [];
  const execCtx = {
    waitUntil: (p: Promise<unknown>) => { waited.push(p); },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { execCtx, waited };
}

const dispatched = (): string[] =>
  executeAgentSpy.mock.calls.map((c) => (c[1] as { name: string }).name);

beforeEach(() => {
  executeAgentSpy.mockReset();
  executeAgentSpy.mockResolvedValue(undefined);
});

describe("scaleAgents under pause_all_ai", () => {
  it("still scales Cartographer (no AI on its path)", async () => {
    const { db, logged } = fakeDb();
    const c = ctx();
    const actions = await scaleAgents(db, c.env, c, backlog({ cartographer: 100 }), budget, limits(true));

    expect(actions).toBe(1);
    expect(dispatched()).toEqual(["cartographer"]);
    // And no "skipped — AI budget" trail entry.
    expect(JSON.stringify(logged)).not.toMatch(/budget_pause_all_ai|scaling skipped/i);
  });

  it("keeps Analyst paused", async () => {
    const { db } = fakeDb();
    const c = ctx();
    await scaleAgents(db, c.env, c, backlog({ cartographer: 100, analyst: 50 }), budget, limits(true));
    expect(dispatched()).toEqual(["cartographer"]);
  });

  it("scales both when the budget is healthy", async () => {
    const { db } = fakeDb();
    const c = ctx();
    await scaleAgents(db, c.env, c, backlog({ cartographer: 100, analyst: 5 }), budget, limits(false));
    expect(dispatched()).toEqual(["cartographer", "analyst"]);
  });
});

describe("scaleAgents inside the :07 cron (execCtx present)", () => {
  it("does not dispatch Cartographer and logs the deferral to :09", async () => {
    const { db, logged } = fakeDb();
    const { execCtx, waited } = fakeExecCtx();
    const c = ctx(execCtx);
    const actions = await scaleAgents(db, c.env, c, backlog({ cartographer: 6000 }), budget, limits(false));

    expect(actions).toBe(0);
    expect(dispatched()).toEqual([]);
    expect(waited).toHaveLength(0);
    const trail = JSON.stringify(logged);
    expect(trail).toMatch(/scaling_deferred/);
    expect(trail).toMatch(/Cartographer backlog 6000 — deferred to the dedicated :09 cron/);
  });

  it("does not dispatch the geo_backlog variant either", async () => {
    const { db, logged } = fakeDb();
    const { execCtx } = fakeExecCtx();
    const c = ctx(execCtx);
    const actions = await scaleAgents(db, c.env, c, backlog({ totalNoGeo: 9000 }), budget, limits(false));

    expect(actions).toBe(0);
    expect(dispatched()).toEqual([]);
    expect(JSON.stringify(logged)).toMatch(/scaling_deferred.*geo_backlog|geo_backlog.*scaling_deferred/);
  });

  it("logs nothing for Cartographer when there is no backlog", async () => {
    const { db, logged } = fakeDb();
    const { execCtx } = fakeExecCtx();
    const c = ctx(execCtx);
    await scaleAgents(db, c.env, c, backlog({}), budget, limits(false));
    expect(logged).toHaveLength(0);
  });

  it("still fires Analyst via waitUntil", async () => {
    const { db } = fakeDb();
    const { execCtx, waited } = fakeExecCtx();
    const c = ctx(execCtx);
    const actions = await scaleAgents(db, c.env, c, backlog({ cartographer: 100, analyst: 5 }), budget, limits(false));

    expect(dispatched()).toEqual(["analyst"]);
    expect(waited).toHaveLength(1);
    expect(actions).toBe(1);
  });
});

describe("scaleAgents on a manual run (no execCtx)", () => {
  it("awaits 3 Cartographer instances at the 2,500 offset stride for a high backlog", async () => {
    const { db } = fakeDb();
    const c = ctx();
    const actions = await scaleAgents(db, c.env, c, backlog({ cartographer: 6000 }), budget, limits(false));

    expect(actions).toBe(3);
    expect(dispatched()).toEqual(["cartographer", "cartographer", "cartographer"]);
    const offsets = executeAgentSpy.mock.calls.map((call) => (call[2] as { offset: number }).offset);
    expect(offsets).toEqual([0, 2500, 5000]);
  });

  it("runs the geo_backlog variant when only the no-geo backlog is large", async () => {
    const { db } = fakeDb();
    const c = ctx();
    const actions = await scaleAgents(db, c.env, c, backlog({ totalNoGeo: 9000 }), budget, limits(false));

    expect(actions).toBe(1);
    expect(dispatched()).toEqual(["cartographer"]);
    expect((executeAgentSpy.mock.calls[0][2] as { mode: string }).mode).toBe("geo_backlog");
  });
});
