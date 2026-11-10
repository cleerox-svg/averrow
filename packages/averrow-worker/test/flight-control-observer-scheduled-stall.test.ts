/**
 * Flight Control: Observer's stall check follows the SCHEDULED briefing,
 * not the newest agent_runs row (PR #1938 review M1).
 *
 * agent_runs has no trigger column, so a successful pivot_detected event run
 * (the newest row) used to mask a failed or missing 00:41 briefing: no stall,
 * no catch-up, the day's briefing silently lost. The scheduled path now
 * stamps a KV marker (lib/observer-schedule-marker.ts) and getAgentHealth
 * measures Observer's stall age from it (AgentHealth.stall_reference_at);
 * planStallRecoveries uses the same reference.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getAgentHealth,
  planStallRecoveries,
  STALL_RECOVERY_KV_PREFIX,
  type AgentHealth,
} from "../src/agents/flightControl";
import { agentModules } from "../src/agents/index";
import { observerAgent } from "../src/agents/observer";
import {
  OBSERVER_SCHEDULED_SUCCESS_KV_KEY,
  OBSERVER_SCHEDULED_SUCCESS_TTL_SECONDS,
  readObserverScheduledSuccess,
  stampObserverScheduledSuccess,
} from "../src/lib/observer-schedule-marker";
import type { Env } from "../src/types";

const HOUR_MS = 60 * 60 * 1000;
const now = Date.now();
/** agent_runs.started_at format, `hoursAgo` before now. */
const sqlTs = (hoursAgo: number): string =>
  new Date(now - hoursAgo * HOUR_MS).toISOString().slice(0, 19).replace("T", " ");
const isoTs = (hoursAgo: number): string => new Date(now - hoursAgo * HOUR_MS).toISOString();

interface LatestRow {
  agent_id: string; last_run_status: string; last_run_at: string;
  last_completed_at: string | null; duration_ms: number | null;
}

/** Routes getAgentHealth's four reads by SQL text. Only observer has a run. */
function fakeHealthDb(latest: LatestRow[]): D1Database {
  return {
    prepare(sql: string) {
      const all = async () => {
        if (sql.includes("json_each(?)")) return { results: latest };
        return { results: [] }; // avg durations, agent_configs, workflow stats
      };
      return { bind: () => ({ all }), all };
    },
  } as unknown as D1Database;
}

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const puts: Array<{ key: string; value: string; ttl?: number }> = [];
  const kv = {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string, o?: { expirationTtl?: number }) {
      puts.push({ key, value, ttl: o?.expirationTtl });
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, store, puts };
}

const observerRow = (hoursAgo: number, status = "success"): LatestRow => ({
  agent_id: "observer", last_run_status: status, last_run_at: sqlTs(hoursAgo),
  last_completed_at: status === "success" ? sqlTs(hoursAgo - 0.01) : null, duration_ms: 1000,
});

async function observerHealth(latest: LatestRow[], kv: KVNamespace): Promise<AgentHealth> {
  const health = await getAgentHealth(fakeHealthDb(latest), kv);
  const h = health.find((x) => x.agent_id === "observer");
  if (!h) throw new Error("observer missing from health");
  return h;
}

const thresholdsMinutes = new Map(Object.entries(agentModules).map(([id, m]) => [id, m.stallThresholdMinutes]));
const plan = (health: AgentHealth[], kv: KVNamespace) =>
  planStallRecoveries(health, {
    db: { prepare: () => ({ bind: () => ({}) }) } as unknown as D1Database,
    cache: kv, modules: agentModules, thresholdsMinutes, nowMs: Date.now(),
  });

describe("FC Observer stall check reads the scheduled run, not the newest row", () => {
  it("scheduled run failed, pivot run succeeded after it → still stalled and caught up", async () => {
    // Yesterday's briefing succeeded 26h ago (marker); today's 00:41 run
    // failed; a pivot run succeeded 1h ago and is now the newest row.
    const { kv } = fakeKv({ [OBSERVER_SCHEDULED_SUCCESS_KV_KEY]: isoTs(26) });
    const h = await observerHealth([observerRow(1)], kv);
    expect(h.last_run_status).toBe("success"); // the masking row…
    expect(h.stall_reference_at).toBe(isoTs(26));
    expect(h.is_stalled).toBe(true);           // …no longer masks the stall

    const r = await plan([h], kv);
    expect(r.decisions.find((d) => d.agentId === "observer")?.decision).toBe("dispatch");
    expect(r.toRecover.map((x) => x.agentId)).toEqual(["observer"]);
  });

  it("a pivot run newer than the last recovery does not reset the recovery cooldown", async () => {
    const { kv } = fakeKv({
      [OBSERVER_SCHEDULED_SUCCESS_KV_KEY]: isoTs(30),
      // Recovery 2h ago (still inside its 2h×2^(n-1) window for attempt 2);
      // the pivot run 1h ago started after it.
      [STALL_RECOVERY_KV_PREFIX + "observer"]: JSON.stringify({ attempts: 2, last_at: now - 2 * HOUR_MS }),
    });
    const h = await observerHealth([observerRow(1)], kv);
    const r = await plan([h], kv);
    expect(r.decisions.find((d) => d.agentId === "observer")?.decision).toBe("skip_cooldown");
    expect(r.toRecover).toHaveLength(0);
  });

  it("scheduled success → not stalled, even when a later pivot run failed", async () => {
    const { kv } = fakeKv({ [OBSERVER_SCHEDULED_SUCCESS_KV_KEY]: isoTs(3) });
    expect((await observerHealth([observerRow(3)], kv)).is_stalled).toBe(false);
    expect((await observerHealth([observerRow(1, "failed")], kv)).is_stalled).toBe(false);
  });

  it("no marker (first deploy) → falls back to the newest agent_runs row", async () => {
    const fresh = await observerHealth([observerRow(1)], fakeKv().kv);
    expect(fresh.stall_reference_at).toBeNull();
    expect(fresh.is_stalled).toBe(false);
    const old = await observerHealth([observerRow(26)], fakeKv().kv);
    expect(old.is_stalled).toBe(true);
  });

  it("only observer reads a marker; other agents keep newest-row ages", async () => {
    const { kv } = fakeKv({ [OBSERVER_SCHEDULED_SUCCESS_KV_KEY]: isoTs(26) });
    const health = await getAgentHealth(fakeHealthDb([observerRow(1)]), kv);
    for (const h of health.filter((x) => x.agent_id !== "observer")) {
      expect(h.stall_reference_at ?? null, h.agent_id).toBeNull();
    }
  });
});

describe("observer scheduled-success marker", () => {
  it("stamps an ISO timestamp with the TTL and reads it back", async () => {
    const { kv, puts } = fakeKv();
    await stampObserverScheduledSuccess(kv, Date.UTC(2026, 10, 10, 0, 42));
    expect(puts).toEqual([{ key: OBSERVER_SCHEDULED_SUCCESS_KV_KEY, value: "2026-11-10T00:42:00.000Z", ttl: OBSERVER_SCHEDULED_SUCCESS_TTL_SECONDS }]);
    expect(await readObserverScheduledSuccess(kv)).toBe("2026-11-10T00:42:00.000Z");
  });

  it("read: garbage or a KV error → null; stamp: a KV error never throws", async () => {
    expect(await readObserverScheduledSuccess(fakeKv({ [OBSERVER_SCHEDULED_SUCCESS_KV_KEY]: "nope" }).kv)).toBeNull();
    const broken = { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } } as unknown as KVNamespace;
    expect(await readObserverScheduledSuccess(broken)).toBeNull();
    await expect(stampObserverScheduledSuccess(broken)).resolves.toBeUndefined();
  });

  it("a pivot_detected run never stamps it", async () => {
    const { kv, puts } = fakeKv();
    const env = { DB: { prepare: () => { throw new Error("no D1"); } }, CACHE: kv } as unknown as Env;
    await observerAgent.execute({
      env, runId: "r", agentName: "observer", triggeredBy: "cron",
      input: { triggeredByEvent: "pivot_detected", events: [{ id: "x", payload: {} }] },
    });
    expect(puts).toHaveLength(0);
  });

  it("the scheduled path stamps it after the pivot branch has returned", () => {
    const obs = readFileSync(fileURLToPath(new URL("../src/agents/observer.ts", import.meta.url)), "utf8");
    const pivotBranch = obs.indexOf('if (triggeredByEvent === "pivot_detected") {');
    const stamp = obs.indexOf("if (!triggeredByEvent) await stampObserverScheduledSuccess(env.CACHE);");
    expect(pivotBranch).toBeGreaterThan(0);
    expect(stamp).toBeGreaterThan(pivotBranch);
    expect(obs.split("stampObserverScheduledSuccess(").length - 1).toBe(1); // exactly one call site
  });
});
