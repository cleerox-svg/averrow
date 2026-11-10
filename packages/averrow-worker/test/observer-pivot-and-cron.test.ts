/**
 * Observer: dedicated daily cron + a working pivot_detected edge
 * (owner decisions 2026-11-10).
 *
 * Pins:
 *   1. Cron: `41 0 * * *` (OBSERVER_CRON) dispatches observer through
 *      executeAgent by EXACT match, above the hourly-mesh guard; any other
 *      cron string does not; wrangler declares it; minute 41 collides with no
 *      other trigger and is off the 5- and 10-minute grids; the hourly tick no longer
 *      dispatches observer at hour 0 (no double run); observer has no
 *      minute gate.
 *   2. Navigator's drain expires telemetry events after 5 min but leaves
 *      TARGETED events pending for the :07 consumer (expired only after
 *      TARGETED_EVENT_EXPIRY_HOURS).
 *   3. Coalesced input carries every folded event's payload.
 *   4. A pivot-triggered observer run reports every pivot from the payloads,
 *      makes no AI call and reads nothing from D1.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/types";

const executeAgentMock = vi.fn(async () => ({ runId: "r", status: "success", result: null }));
vi.mock("../src/lib/agentRunner", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/agentRunner")>("../src/lib/agentRunner");
  return { ...actual, executeAgent: (...args: unknown[]) => executeAgentMock(...(args as [])) };
});

const generateInsightMock = vi.fn();
vi.mock("../src/lib/haiku", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/haiku")>("../src/lib/haiku");
  return { ...actual, generateInsight: (...args: unknown[]) => generateInsightMock(...args) };
});

import { handleScheduled, OBSERVER_CRON } from "../src/cron/orchestrator";
import { STALE_AGENT_EVENTS_DRAIN_SQL, TARGETED_EVENT_EXPIRY_HOURS } from "../src/cron/navigator";
import { planAgentEventDispatch, coalescedEventInput, type PendingAgentEvent } from "../src/lib/agent-event-dispatch";
import { observerAgent } from "../src/agents/observer";
import { parsePivotPayload, buildPivotReport, pivotsFromInput } from "../src/lib/observer-pivot-report";
import { hasSqlite, openDerivedDb } from "./sqlite-d1-harness";

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const fire = (cron: string): Promise<void> =>
  handleScheduled({ cron, scheduledTime: Date.UTC(2026, 10, 10, 0, 41), type: "scheduled" } as unknown as ScheduledEvent, {} as Env, ctx);

beforeEach(() => {
  executeAgentMock.mockClear();
  generateInsightMock.mockReset();
});

// ─── 1. Dedicated cron ────────────────────────────────────────────

describe("observer dedicated cron", () => {
  it("dispatches observer via executeAgent on the exact cron only", async () => {
    expect(OBSERVER_CRON).toBe("41 0 * * *");
    await fire(OBSERVER_CRON);
    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    const [, mod, input, by, type] = executeAgentMock.mock.calls[0] as unknown as [unknown, { name: string }, unknown, string, string];
    expect(mod.name).toBe("observer");
    expect(input).toEqual({});
    expect([by, type]).toEqual(["cron", "scheduled"]);

    executeAgentMock.mockClear();
    await fire("41 1 * * *");
    await fire("41 * * * *");
    expect(executeAgentMock).not.toHaveBeenCalled();
  });

  it("wiring: above the mesh guard, declared in wrangler, unique minute off the */5 and */10 grids", () => {
    const orch = src("../src/cron/orchestrator.ts");
    const branch = orch.indexOf("if (event.cron === OBSERVER_CRON) {");
    const meshGuard = orch.indexOf("if (event.cron !== '7 * * * *') {");
    expect(branch).toBeGreaterThan(0);
    expect(meshGuard).toBeGreaterThan(branch);

    const crons = /^crons\s*=\s*\[(.*)\]$/m.exec(src("../wrangler.toml"))?.[1] ?? "";
    expect(crons).toContain('"41 0 * * *"');
    const minutes = [...crons.matchAll(/"(\d+) [^"]*"/g)].map((m) => Number(m[1]));
    expect(minutes.filter((m) => m === 41)).toHaveLength(1);
    expect(41 % 5).not.toBe(0);
  });

  it("the hourly tick no longer dispatches observer at hour 0 (no double run)", () => {
    const orch = src("../src/cron/orchestrator.ts");
    expect(orch).not.toMatch(/allAgents\["observer"\]/);
    expect(orch).not.toMatch(/threat_feed_scan_observer_error/);
    // Observer itself has no minute gate.
    expect(src("../src/agents/observer.ts")).not.toMatch(/getUTCMinutes|minute\s*===/);
  });
});

// ─── 2. Navigator drain keeps targeted events ─────────────────────

describe.skipIf(!hasSqlite())("Navigator stale-event drain", () => {
  it("expires telemetry after 5 min, keeps targeted events pending until the expiry window", () => {
    const db = openDerivedDb(["agent_events"]);
    const ins = db.prepare(
      `INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, created_at, status)
       VALUES (?, ?, 'nexus', ?, '{}', 1, datetime('now', ?), 'pending')`,
    );
    ins.run("tele-old", "threats_enriched", null, "-10 minutes");
    ins.run("tele-empty-old", "nexus_complete", "", "-10 minutes");
    ins.run("tele-new", "threats_enriched", null, "-1 minutes");
    ins.run("pivot-55m", "pivot_detected", "observer", "-55 minutes");
    ins.run("pivot-2h", "pivot_detected", "observer", "-119 minutes");
    ins.run("pivot-expired", "pivot_detected", "observer", `-${TARGETED_EVENT_EXPIRY_HOURS * 60 + 5} minutes`);

    // node:sqlite lacks UPDATE … LIMIT; D1 accepts it (prod EXPLAIN, 2026-11-10). Run the same WHERE.
    db.exec(STALE_AGENT_EVENTS_DRAIN_SQL.replace(/\s+LIMIT \?\s*$/, ""));

    const rows = db.prepare(`SELECT id, status FROM agent_events ORDER BY id`).all() as Array<{ id: string; status: string }>;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      "pivot-2h": "pending",
      "pivot-55m": "pending",
      "pivot-expired": "done",
      "tele-empty-old": "done",
      "tele-new": "pending",
      "tele-old": "done",
    });
  });

  it("the expiry gives an event written just after :07 two consumer ticks", () => {
    expect(TARGETED_EVENT_EXPIRY_HOURS).toBeGreaterThanOrEqual(2);
  });
});

// ─── 3. Coalesced input ───────────────────────────────────────────

const ev = (id: string, payload: unknown): PendingAgentEvent => ({
  id, event_type: "pivot_detected", source_agent: "nexus", target_agent: "observer",
  payload_json: typeof payload === "string" ? payload : JSON.stringify(payload), priority: 1,
});

describe("coalescedEventInput", () => {
  it("lists every folded event's payload; a malformed payload reads as {}", () => {
    const plan = planAgentEventDispatch(
      [ev("e1", { kind: "dormancy", cluster_id: "c1", asn: "AS1" }), ev("e2", "{not json"), ev("e3", { kind: "infra_movement", cluster_id: "c3" })],
      new Map(),
    );
    const input = coalescedEventInput(plan.dispatches[0]!);
    expect(input).toMatchObject({ kind: "dormancy", cluster_id: "c1", triggeredByEvent: "pivot_detected", coalescedEvents: 3 });
    expect(input.events).toEqual([
      { id: "e1", event_type: "pivot_detected", payload: { kind: "dormancy", cluster_id: "c1", asn: "AS1" } },
      { id: "e2", event_type: "pivot_detected", payload: {} },
      { id: "e3", event_type: "pivot_detected", payload: { kind: "infra_movement", cluster_id: "c3" } },
    ]);
  });
});

// ─── 4. Pivot-triggered observer run ──────────────────────────────

const dormancy = (id: string, asn: string, name?: string) => ({
  kind: "dormancy", cluster_id: id, asn, prev_asn: asn, payload_v: 2, ...(name ? { cluster_name: name } : {}),
});
const movement = {
  kind: "infra_movement", cluster_id: "cl_bridge_9", cluster_name: "cert-serial · phishing kit",
  new_asns: 2, new_ips: 4, new_serials: 0, new_asn_list: ["AS13335", "AS16509"], prev_asn_list: ["AS4837"], payload_v: 2,
};

describe("pivot report (pure)", () => {
  it("parses both kinds and rejects anything else", () => {
    expect(parsePivotPayload(dormancy("c1", "AS1"))).toMatchObject({ kind: "dormancy", clusterId: "c1", asn: "AS1" });
    expect(parsePivotPayload(movement)).toMatchObject({ kind: "infra_movement", newAsns: 2, newAsnList: ["AS13335", "AS16509"] });
    expect(parsePivotPayload({ kind: "other", cluster_id: "x" })).toBeNull();
    expect(parsePivotPayload({ kind: "dormancy" })).toBeNull();
    expect(parsePivotPayload("x")).toBeNull();
  });

  it("dedupes the same cluster+kind and falls back to a single spread payload", () => {
    expect(pivotsFromInput({ events: [{ id: "a", payload: dormancy("c1", "AS1") }, { id: "b", payload: dormancy("c1", "AS1") }] })).toHaveLength(1);
    expect(pivotsFromInput({ ...dormancy("c9", "AS9"), triggeredByEvent: "pivot_detected" })).toHaveLength(1);
  });

  it("infra movement makes it high severity; dormancy alone is medium; none → null", () => {
    expect(buildPivotReport([parsePivotPayload(movement)!])!.severity).toBe("high");
    expect(buildPivotReport([parsePivotPayload(dormancy("c1", "AS1"))!])!.severity).toBe("medium");
    expect(buildPivotReport([])).toBeNull();
  });
});

describe("observer execute() on pivot_detected", () => {
  it("reports every coalesced pivot from the payloads, no AI call, no D1 read", async () => {
    const env = {
      DB: { prepare: () => { throw new Error("pivot run must not read D1"); } },
    } as unknown as Env;
    const events = [
      { id: "e1", event_type: "pivot_detected", payload: dormancy("cluster_asn_AS4837_malware", "AS4837", "AS4837 · malware distribution") },
      { id: "e2", event_type: "pivot_detected", payload: movement },
      { id: "e3", event_type: "pivot_detected", payload: dormancy("cluster_asn_AS9009_phishing", "AS9009") },
    ];
    const result = await observerAgent.execute({
      env, runId: "run-pivot", agentName: "observer", triggeredBy: "cron",
      input: { ...events[0]!.payload, triggeredByEvent: "pivot_detected", coalescedEvents: 3, events },
    });

    expect(generateInsightMock).not.toHaveBeenCalled();
    expect(result.tokensUsed).toBe(0);
    expect(result.itemsProcessed).toBe(3);
    expect(result.output).toMatchObject({ ai_skipped: "event_triggered", pivots: 3, coalesced_events: 3 });

    const out = result.agentOutputs!;
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("insight");
    expect(out[0]!.severity).toBe("high");
    const s = String(out[0]!.summary);
    expect(s).toContain("Infrastructure pivots (3)");
    expect(s).toContain("cert-serial · phishing kit: +2 ASNs (AS13335, AS16509), +4 IPs from AS4837");
    expect(s).toContain("AS4837 · malware distribution (AS4837)");
    expect(s).toContain("cluster_asn_AS9009_phishing (AS9009)");
    expect(out[0]!.details).toMatchObject({
      kind: "pivot_report", pivots: 3, infra_movement: 1, dormancy: 2,
      cluster_ids: ["cluster_asn_AS4837_malware", "cl_bridge_9", "cluster_asn_AS9009_phishing"],
      asns: ["AS13335", "AS16509", "AS4837", "AS9009"],
    });
  });

  it("a pivot run with no valid payload writes a low diagnostic, still no AI", async () => {
    const env = { DB: { prepare: () => { throw new Error("no D1"); } } } as unknown as Env;
    const result = await observerAgent.execute({
      env, runId: "r2", agentName: "observer", triggeredBy: "cron",
      input: { triggeredByEvent: "pivot_detected", events: [{ id: "x", payload: {} }] },
    });
    expect(generateInsightMock).not.toHaveBeenCalled();
    expect(result.agentOutputs?.[0]).toMatchObject({ type: "diagnostic", severity: "low" });
  });
});
