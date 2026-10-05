/**
 * executeAgent's alert.created drain is per-run and deadline-bounded
 * (lib/alert-events.ts, lib/agentRunner.ts).
 *
 *   - A delivery that never resolves (hung customer webhook) delays the
 *     run by at most the drain deadline — it can't hold agent_runs open
 *     toward the cron limit.
 *   - Run A never waits on run B's deliveries (AsyncLocalStorage scope),
 *     even though both sit in the isolate-wide set.
 *   - The entrypoint drain is a single snapshot.
 *
 * The deadline is lowered for the test by overriding the exported constant.
 */
import { describe, it, expect, vi } from "vitest";
import type { AgentModule, AgentResult } from "../src/lib/agentRunner";
import type { Env } from "../src/types";

const DEADLINE_MS = 300;
vi.mock("../src/lib/alert-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/alert-events")>();
  return { ...actual, ALERT_SCOPE_DRAIN_DEADLINE_MS: DEADLINE_MS };
});
vi.mock("../src/lib/notifications", () => ({ createNotification: vi.fn().mockResolvedValue(1) }));

const { executeAgent } = await import("../src/lib/agentRunner");
const { trackAlertEvent } = await import("../src/lib/alert-events");

/** Accepts every statement; reads return nothing (config row absent →
 *  enabled) except the deployment-approval gate, which reads approved. */
function fakeDb(): D1Database {
  const make = (sql: string) => {
    const stmt = {
      bind: () => stmt,
      run: async () => ({ success: true, meta: { changes: 1 } }),
      first: async () => (sql.includes("agent_approvals") ? { state: "approved", reviewer_notes: null } : null),
      all: async () => ({ results: [], success: true, meta: {} }),
      raw: async () => [],
    };
    return stmt;
  };
  return {
    prepare: (sql: string) => make(sql),
    batch: async (s: unknown[]) => s.map(() => ({ success: true, meta: {} })),
  } as unknown as D1Database;
}

const env = { DB: fakeDb(), CACHE: { get: async () => null, put: async () => {} } } as unknown as Env;

function agent(name: string, onExecute: () => void): AgentModule {
  return {
    name: name as AgentModule["name"],
    displayName: name,
    description: "test",
    color: "#fff",
    trigger: "manual",
    execute: async (): Promise<AgentResult> => {
      onExecute();
      return { itemsProcessed: 1, itemsCreated: 0, itemsUpdated: 0, output: {} };
    },
  } as unknown as AgentModule;
}

describe("executeAgent alert-delivery drain", () => {
  it("the entrypoint drain is a single snapshot (does not chase new work)", async () => {
    // Runs FIRST, before any test leaves a hung delivery in the isolate set.
    const m = await import("../src/lib/alert-events");
    expect(m.pendingAlertEventCount()).toBe(0);
    let resolveFirst: () => void = () => {};
    m.trackAlertEvent(new Promise<void>((r) => { resolveFirst = r; }));
    const drained = m.drainAlertEvents();
    // Tracked after the snapshot: must not hold the drain open.
    m.trackAlertEvent(new Promise(() => {}));
    resolveFirst();
    await expect(Promise.race([
      drained.then(() => "drained"),
      new Promise((r) => setTimeout(() => r("stuck"), 200)),
    ])).resolves.toBe("drained");
    expect(m.pendingAlertEventCount()).toBe(1);
  });
  it("a never-resolving delivery delays the run by at most the deadline", async () => {
    const hung = agent("curator", () => trackAlertEvent(new Promise(() => {})));
    const t0 = Date.now();
    const r = await executeAgent(env, hung);
    const elapsed = Date.now() - t0;
    expect(r.status).toBe("success");
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
    expect(elapsed).toBeLessThan(DEADLINE_MS + 1500);
  });

  it("run A does not wait on run B's deliveries", async () => {
    let releaseB: () => void = () => {};
    const bDelivery = new Promise<void>((r) => { releaseB = r; });
    const runB = agent("curator", () => trackAlertEvent(bDelivery));
    let aDone = false;
    const runA = agent("architect", () => trackAlertEvent(Promise.resolve()));

    const pB = executeAgent(env, runB);
    // Let B start and register its delivery before A runs.
    await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    const ra = await executeAgent(env, runA).then((x) => { aDone = true; return x; });
    expect(aDone).toBe(true);
    expect(ra.status).toBe("success");
    expect(Date.now() - t0).toBeLessThan(DEADLINE_MS); // didn't sit on B's delivery

    releaseB();
    await pB;
  });

});
