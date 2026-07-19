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
 *
 * Regression closed here (post-mortem, PR #1637 / migration 0238):
 * S0.1 registered ct_monitor as a new AgentModule dispatched through
 * executeAgent (lib/agentRunner.ts), which gates every run on a
 * deployment-approval row in `agent_approvals` — first sighting of an
 * agent with no row auto-creates a 'pending' row and returns BEFORE
 * writing any agent_runs row. ct_monitor shipped without its approval
 * migration, so every `18 * * * *` tick was silently blocked in prod:
 * pollCertificates never ran, and ct_monitor never appeared in
 * agent_mesh.per_agent[]. This suite's original D1 fake did not expose
 * a queryable `agent_approvals` table, so `getApprovalState` threw,
 * `executeAgent` hit its fail-open branch (approvalGateAvailable=false
 * → blockingState=null → run proceeds), and the gate was never
 * exercised — the suite asserted the happy-path lifecycle and passed
 * even though prod was blocked. `makeEnv()` below now backs
 * `agent_approvals` with a real seeded map so the gate runs for real;
 * the "deployment-approval gate" cases at the bottom pin BOTH the
 * approved happy path and the missing-row block so this class of bug
 * can't slip through silently again.
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

type ApprovalState = "pending" | "approved" | "rejected" | "changes_requested";

/** Mirrors the post-S0.1-fix production state: migration 0126
 *  grandfathered lookalike_scanner pre-5.4, migration 0238 grandfathered
 *  ct_monitor + trademark_monitor. Pass `{ approvals: {...} }` to
 *  override — e.g. `{}` to reproduce the pre-migration-0238 regression
 *  where ct_monitor had no row. */
const DEFAULT_APPROVALS: Record<string, ApprovalState> = {
  ct_monitor: "approved",
  lookalike_scanner: "approved",
  trademark_monitor: "approved",
};

function makeEnv(
  opts: { approvals?: Record<string, ApprovalState> } = {},
): { env: Env; rec: Recorder; approvals: Map<string, ApprovalState> } {
  const rec: Recorder = { agentRunInserts: [], agentRunUpdates: [] };
  const approvals = new Map<string, ApprovalState>(
    Object.entries(opts.approvals ?? DEFAULT_APPROVALS),
  );

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
          } else if (lower.includes("insert or ignore into agent_approvals")) {
            // executeAgent's createPending() on first sighting of an
            // unapproved agent — mirror the real INSERT OR IGNORE
            // semantics (only seed 'pending' when no row exists yet, so
            // it never clobbers a state a test seeded on purpose).
            const agentId = String(args[0]);
            if (!approvals.has(agentId)) approvals.set(agentId, "pending");
          }
          return { meta: { last_row_id: 1, changes: 1 }, success: true };
        },
        first: async () => {
          // Circuit-breaker gate → agent enabled.
          if (lower.includes("from agent_configs")) {
            return { enabled: 1, paused_reason: null };
          }
          // Deployment-approval gate — real lookup against the seeded
          // map, so a missing row genuinely returns null (blocking the
          // run) instead of failing open. This is the exact gate that
          // was un-exercised before this fix (see file header).
          if (lower.includes("from agent_approvals")) {
            const agentId = String(args[0]);
            const state = approvals.get(agentId);
            return state ? { agent_id: agentId, state } : null;
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

  return { env: { DB: db } as unknown as Env, rec, approvals };
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

  // ── Deployment-approval gate (the PR #1637 / migration 0238 regression) ──
  //
  // Every scanner here is dispatched through executeAgent, which refuses to
  // run any agent with no 'approved' row in agent_approvals. Before this
  // fix, the suite's D1 fake had no queryable agent_approvals table, so
  // getApprovalState() threw and executeAgent's fail-open branch let every
  // run through regardless — the gate itself was never exercised. These
  // cases seed a REAL approvals map (via makeEnv's `approvals` option) so
  // the gate runs for real on both sides: approved → runs; missing → blocked.
  describe("deployment-approval gate", () => {
    const cases = [
      { cron: "18 * * * *", agentId: "ct_monitor" },
      { cron: "22 * * * *", agentId: "lookalike_scanner" },
      { cron: "23 * * * *", agentId: "trademark_monitor" },
    ] as const;

    for (const { cron, agentId } of cases) {
      it(`${cron} blocks ${agentId} when agent_approvals has no row for it — writes NO agent_runs row`, async () => {
        const { handleScheduled } = await import("../src/cron/orchestrator");
        // No rows seeded for anyone — reproduces the pre-0238 prod state
        // where ct_monitor shipped with zero agent_approvals row.
        const { env, rec } = makeEnv({ approvals: {} });

        await handleScheduled(scheduledEvent(cron), env, ctx);

        expect(rec.agentRunInserts).toEqual([]);
        expect(rec.agentRunUpdates).toEqual([]);
      });
    }

    it("executeAgent returns status 'circuit_open' and writes no agent_runs row for ct_monitor with no approval row (the exact PR-1637 regression)", async () => {
      const { executeAgent } = await import("../src/lib/agentRunner");
      const { ctMonitorAgent } = await import("../src/agents/ct-monitor");
      const { env, rec, approvals } = makeEnv({ approvals: {} });

      const result = await executeAgent(env, ctMonitorAgent, {}, "cron", "scheduled");

      expect(result.status).toBe("circuit_open");
      expect(result.runId).toBe("");
      expect(rec.agentRunInserts).toEqual([]);
      // executeAgent's createPending() auto-creates the pending row on
      // first sighting — matches the real gate's side effect, and is
      // exactly what left ct_monitor stuck 'pending' in prod for ~24h
      // until migration 0238's upsert flipped it to 'approved'.
      expect(approvals.get("ct_monitor")).toBe("pending");
    });

    it("executeAgent runs ct_monitor to a full agent_runs lifecycle once agent_approvals has an 'approved' row (mirrors migration 0238's grandfather)", async () => {
      const { executeAgent } = await import("../src/lib/agentRunner");
      const { ctMonitorAgent } = await import("../src/agents/ct-monitor");
      const { env, rec } = makeEnv({ approvals: { ct_monitor: "approved" } });

      const result = await executeAgent(env, ctMonitorAgent, {}, "cron", "scheduled");

      expect(result.status).toBe("success");
      expect(rec.agentRunInserts).toEqual([{ agentId: "ct_monitor" }]);
      expect(rec.agentRunUpdates).toHaveLength(1);
      expect(rec.agentRunUpdates[0].args[0]).toBe("success");
    });

    it("a 'rejected' agent_approvals row also blocks the run (not just a missing row)", async () => {
      const { handleScheduled } = await import("../src/cron/orchestrator");
      const { env, rec } = makeEnv({ approvals: { ct_monitor: "rejected" } });

      await handleScheduled(scheduledEvent("18 * * * *"), env, ctx);

      expect(rec.agentRunInserts).toEqual([]);
    });
  });
});
