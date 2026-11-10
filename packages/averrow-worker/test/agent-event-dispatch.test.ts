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
