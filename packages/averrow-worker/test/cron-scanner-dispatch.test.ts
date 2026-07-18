/**
 * S0.1 — dedicated-cron dispatch for the three detection scanners
 * (Assessment 2026-07 §3.4 R1/R2; addresses T4 "orchestrator
 * cron-dispatch has no direct test").
 *
 * Before S0.1, CT monitor / lookalike / trademark ran inline at the tail
 * of the hourly orchestrator tick (`7 * * * *`), after analyst's ~153s
 * inline await — dropping ~67% of runs. ct_monitor additionally wrote no
 * agent_runs telemetry, so FC's stall watchdog couldn't see it.
 *
 * This suite pins the new wiring so it can't silently regress (the exact
 * class of change that caused the 22h mesh outage):
 *
 *   1. event.cron '18 * * * *' dispatches ct_monitor and writes ONE
 *      agent_runs row (start 'partial' → completion 'success'), so it is
 *      now visible to FC / platform-diagnostics (R2 fix).
 *   2. event.cron '22 * * * *' dispatches lookalike_scanner (agent_runs).
 *   3. event.cron '23 * * * *' dispatches trademark_monitor (agent_runs).
 *   4. Each dedicated-cron tick dispatches ONLY its own scanner — never
 *      the other two (no cross-fire; each branch returns early).
 *   5. The orchestrator source no longer contains the inline tail
 *      dispatch of these three (no double-run on the hourly tick).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/types";

// Keep the three scanners' heavy bodies out of the test — we only care
// that the cron branch reaches executeAgent and writes agent_runs.
vi.mock("../src/scanners/ct-monitor", () => ({
  pollCertificates: vi.fn(async () => ({
    brandsScanned: 0,
    totalCerts: 0,
    newCerts: 0,
    suspicious: 0,
  })),
}));
vi.mock("../src/scanners/lookalike-domains", () => ({
  checkLookalikeBatch: vi.fn(async () => {}),
  seedLookalikesForOrgBrands: vi.fn(async () => ({ seeded: 0 })),
}));
vi.mock("../src/scanners/trademark-monitor", () => ({
  runTrademarkScanBatch: vi.fn(async () => ({ assets_seeded: 0, findings_created: 0 })),
}));

interface Recorder {
  agentRunInserts: Array<{ agentId: string }>;
  agentRunUpdates: Array<{ sql: string; args: unknown[] }>;
}

function makeEnv(): { env: Env; rec: Recorder } {
  const rec: Recorder = { agentRunInserts: [], agentRunUpdates: [] };

  const db = {
    prepare(sql: string) {
      const lower = sql.toLowerCase();
      const exec = (args: unknown[]) => ({
        run: async () => {
          if (lower.includes("insert into agent_runs")) {
            // executeAgent binds (runId, agentId) on the start INSERT.
            rec.agentRunInserts.push({ agentId: String(args[1]) });
          } else if (lower.startsWith("update agent_runs")) {
            rec.agentRunUpdates.push({ sql, args });
          }
          return { meta: { last_row_id: 1 }, success: true };
        },
        first: async () => {
          // Circuit-breaker gate → agent enabled.
          if (lower.includes("from agent_configs")) {
            return { enabled: 1, paused_reason: null };
          }
          // Deployment-approval gate → approved (else the run is blocked
          // before any agent_runs row is written).
          if (lower.includes("from agent_approvals")) {
            return { agent_id: "x", state: "approved" };
          }
          return {};
        },
        all: async () => ({ results: [] }),
      });
      return {
        bind: (...args: unknown[]) => exec(args),
        run: exec([]).run,
        first: exec([]).first,
        all: exec([]).all,
      };
    },
  };

  return { env: { DB: db } as unknown as Env, rec };
}

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function scheduledEvent(cron: string): ScheduledEvent {
  return {
    cron,
    scheduledTime: Date.parse("2026-07-18T00:18:00Z"),
    type: "scheduled",
  } as unknown as ScheduledEvent;
}

describe("S0.1 dedicated-cron scanner dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("'18 * * * *' dispatches ct_monitor with a full agent_runs lifecycle", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    const { env, rec } = makeEnv();

    await handleScheduled(scheduledEvent("18 * * * *"), env, ctx);

    // Exactly one run, agent_id 'ct_monitor' — the R2 telemetry fix.
    expect(rec.agentRunInserts).toEqual([{ agentId: "ct_monitor" }]);
    // Completed (not left 'partial'/'running') with status 'success'.
    expect(rec.agentRunUpdates).toHaveLength(1);
    expect(rec.agentRunUpdates[0].args[0]).toBe("success");
  });

  it("'22 * * * *' dispatches lookalike_scanner only", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    const { env, rec } = makeEnv();

    await handleScheduled(scheduledEvent("22 * * * *"), env, ctx);

    expect(rec.agentRunInserts).toEqual([{ agentId: "lookalike_scanner" }]);
    expect(rec.agentRunUpdates[0].args[0]).toBe("success");
  });

  it("'23 * * * *' dispatches trademark_monitor only", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    const { env, rec } = makeEnv();

    await handleScheduled(scheduledEvent("23 * * * *"), env, ctx);

    expect(rec.agentRunInserts).toEqual([{ agentId: "trademark_monitor" }]);
    expect(rec.agentRunUpdates[0].args[0]).toBe("success");
  });

  it("each dedicated-cron tick dispatches ONLY its own scanner (no cross-fire)", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");

    for (const [cron, expected] of [
      ["18 * * * *", "ct_monitor"],
      ["22 * * * *", "lookalike_scanner"],
      ["23 * * * *", "trademark_monitor"],
    ] as const) {
      const { env, rec } = makeEnv();
      await handleScheduled(scheduledEvent(cron), env, ctx);
      const ids = rec.agentRunInserts.map((r) => r.agentId);
      expect(ids).toEqual([expected]);
      expect(ids).not.toContain(
        expected === "ct_monitor" ? "lookalike_scanner" : "ct_monitor",
      );
    }
  });

  it("orchestrator no longer dispatches the three scanners inline on the hourly tick (no double-run)", () => {
    const orchestratorPath = fileURLToPath(
      new URL("../src/cron/orchestrator.ts", import.meta.url),
    );
    const src = readFileSync(orchestratorPath, "utf8");

    // The old inline tail dispatch used runJob wrappers with these labels.
    // Their removal is the guarantee against a double-run once the
    // dedicated crons own dispatch.
    expect(src).not.toContain("runJob('ct_monitor'");
    expect(src).not.toContain("runJob('lookalike_check'");
    expect(src).not.toContain("runJob('trademark_scan'");

    // And the dedicated cron branches must exist.
    expect(src).toContain("event.cron === '18 * * * *'");
    expect(src).toContain("event.cron === '22 * * * *'");
    expect(src).toContain("event.cron === '23 * * * *'");
  });
});
