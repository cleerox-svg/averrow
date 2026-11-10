/**
 * agent_events consumer — coalescing + per-day cap (lib/agent-event-dispatch.ts).
 *
 * NEXUS emits pivot_detected in bursts (prod 2026-11-09: 60 events in six
 * bursts of 7-11). The consumer used to call executeAgent once PER EVENT —
 * up to 10 identical observer runs per tick, all via waitUntil in the :07
 * invocation. Pins:
 *   1. One dispatch per target per tick, carrying the first (highest
 *      priority) event's payload and every folded event id.
 *   2. A target at its daily cap gets no dispatch; its events are reported
 *      as capped (the consumer marks them done, never re-queues).
 *   3. Telemetry events (target NULL / '') are never dispatched.
 *   4. Observer's cap is tighter than the default.
 *   5. The orchestrator consumer is wired through the planner.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  planAgentEventDispatch,
  eventDispatchDailyCap,
  eventDispatchKey,
  parseDispatchCount,
  EVENT_DISPATCH_DAILY_CAP_DEFAULT,
  type PendingAgentEvent,
} from "../src/lib/agent-event-dispatch";
import { STALE_PROCESSING_AGENT_EVENTS_SQL } from "../src/cron/orchestrator";
import { hasSqlite, openDerivedDb } from "./sqlite-d1-harness";

const ev = (id: string, target: string | null, payload: Record<string, unknown> = {}, priority = 1): PendingAgentEvent => ({
  id,
  event_type: target ? "pivot_detected" : "threats_enriched",
  source_agent: "nexus",
  target_agent: target,
  payload_json: JSON.stringify(payload),
  priority,
});

describe("planAgentEventDispatch", () => {
  it("collapses a burst of pivot_detected events into ONE observer dispatch", () => {
    const burst = Array.from({ length: 10 }, (_, i) => ev(`e${i}`, "observer", { kind: "dormancy", n: i }));
    const plan = planAgentEventDispatch(burst, new Map());
    expect(plan.dispatches).toHaveLength(1);
    expect(plan.dispatches[0]!.target).toBe("observer");
    expect(plan.dispatches[0]!.event.id).toBe("e0");
    expect(plan.dispatches[0]!.eventIds).toEqual(burst.map((e) => e.id));
    expect(plan.capped).toEqual([]);
  });

  it("dispatches each distinct target once", () => {
    const plan = planAgentEventDispatch(
      [ev("a1", "observer"), ev("b1", "analyst"), ev("a2", "observer")],
      new Map(),
    );
    expect(plan.dispatches.map((d) => [d.target, d.eventIds])).toEqual([
      ["observer", ["a1", "a2"]],
      ["analyst", ["b1"]],
    ]);
  });

  it("a target at its daily cap is not dispatched; its events are reported capped", () => {
    const cap = eventDispatchDailyCap("observer");
    const plan = planAgentEventDispatch([ev("a1", "observer"), ev("a2", "observer")], new Map([["observer", cap]]));
    expect(plan.dispatches).toEqual([]);
    expect(plan.capped).toEqual([{ target: "observer", eventIds: ["a1", "a2"], dispatchedToday: cap, cap }]);
  });

  it("one below the cap still dispatches", () => {
    const cap = eventDispatchDailyCap("observer");
    const plan = planAgentEventDispatch([ev("a1", "observer")], new Map([["observer", cap - 1]]));
    expect(plan.dispatches).toHaveLength(1);
  });

  it("telemetry events (target NULL or '') are never dispatched", () => {
    const plan = planAgentEventDispatch([ev("t1", null), ev("t2", ""), ev("a1", "observer")], new Map());
    expect(plan.telemetryIds).toEqual(["t1", "t2"]);
    expect(plan.dispatches.map((d) => d.target)).toEqual(["observer"]);
  });

  it("observer's cap is tighter than the default; unknown targets get the default", () => {
    expect(eventDispatchDailyCap("observer")).toBeLessThan(EVENT_DISPATCH_DAILY_CAP_DEFAULT);
    expect(eventDispatchDailyCap("some_agent")).toBe(EVENT_DISPATCH_DAILY_CAP_DEFAULT);
  });

  it("KV helpers: per-target per-day key, malformed counts read as 0", () => {
    expect(eventDispatchKey("observer", "2026-11-10")).toBe("agent_events:dispatch:observer:2026-11-10");
    expect(parseDispatchCount(null)).toBe(0);
    expect(parseDispatchCount("garbage")).toBe(0);
    expect(parseDispatchCount("-3")).toBe(0);
    expect(parseDispatchCount("2")).toBe(2);
  });
});

describe("orchestrator processAgentEvents wiring", () => {
  const orch = readFileSync(fileURLToPath(new URL("../src/cron/orchestrator.ts", import.meta.url)), "utf8");
  const start = orch.indexOf("async function processAgentEvents");
  const body = orch.slice(start, orch.indexOf("\nasync function runJob", start));

  it("plans through planAgentEventDispatch and dispatches per planned target, not per event", () => {
    expect(body).toContain("planAgentEventDispatch(");
    expect(body).toMatch(/for \(const d of plan\.dispatches\)/);
    // The old per-event executeAgent loop is gone.
    expect(body).not.toMatch(/for \(const event of events\.results\)/);
    expect(body).toContain("coalescedEventInput(d)");
  });
});

describe("orchestrator processAgentEvents finalize + stale claims", () => {
  const orch = readFileSync(fileURLToPath(new URL("../src/cron/orchestrator.ts", import.meta.url)), "utf8");
  const start = orch.indexOf("async function processAgentEvents");
  const body = orch.slice(start, orch.indexOf("\nasync function runJob", start));

  it("the final done/failed batch runs under the overload retry; the sweep runs before the claim", () => {
    expect(body).toMatch(/withD1Retry\(\(\) => env\.DB\.batch\(finalStmts\)/);
    expect(body).toContain("overloadBaseMs: D1_OVERLOAD_RETRY_BASE_MS");
    expect(body.indexOf("STALE_PROCESSING_AGENT_EVENTS_SQL")).toBeGreaterThan(0);
    expect(body.indexOf("STALE_PROCESSING_AGENT_EVENTS_SQL"))
      .toBeLessThan(body.indexOf("SET status = 'processing'"));
  });

  it.skipIf(!hasSqlite())("fails only 'processing' rows from an earlier tick", () => {
    const db = openDerivedDb(["agent_events"]);
    const ins = db.prepare(
      `INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, created_at, status)
       VALUES (?, 'pivot_detected', 'nexus', 'observer', '{}', 1, datetime('now', ?), ?)`,
    );
    ins.run("stuck-2h", "-2 hours", "processing");
    ins.run("claimed-now", "-10 minutes", "processing");
    ins.run("pending-2h", "-2 hours", "pending");
    ins.run("done-2h", "-2 hours", "done");
    // node:sqlite lacks UPDATE … LIMIT; D1 accepts it (prod EXPLAIN, 2026-11-10). Run the same WHERE.
    db.exec(STALE_PROCESSING_AGENT_EVENTS_SQL.replace(/\s+LIMIT \?\s*$/, ""));
    const rows = db.prepare(`SELECT id, status FROM agent_events ORDER BY id`).all() as Array<{ id: string; status: string }>;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      "claimed-now": "processing",
      "done-2h": "done",
      "pending-2h": "pending",
      "stuck-2h": "failed",
    });
  });
});
