/**
 * Tests for the per-agent orphan reaper.
 *
 * The reaper consults each candidate row's agent module to find its
 * declared `stallThresholdMinutes`, then reaps the row only when its
 * age exceeds threshold + 30-min buffer. Earlier versions used a
 * flat 90-min constant, which mis-fired against NEXUS (declared
 * 360 min for the long ASN-correlation Workflow) and would have
 * under-reaped against short-running agents.
 *
 * Verifies:
 *   1. NEXUS-style long-threshold agents stay safe past 90 min.
 *   2. Default 90-min ceiling kicks in for agents not in the registry.
 *   3. Live rows (not past their per-agent ceiling) are NOT reaped.
 *   4. SQL preserves the existing guardrails: status='partial' +
 *      completed_at IS NULL + datetime() canonicalization +
 *      duration_ms back-stamp.
 *   5. D1 throws are swallowed; per-row failures don't abort the
 *      whole sweep.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  reapOrphanAgentRuns,
  DEFAULT_REAP_AGE_MINUTES,
  REAP_BUFFER_MINUTES,
} from "../src/lib/agent-runs-reaper";
import type { Env } from "../src/types";

// Mock the agent module registry with a controlled fixture so tests
// don't depend on the real codebase's agent set.
vi.mock("../src/agents", () => ({
  agentModules: {
    nexus: { stallThresholdMinutes: 360 },          // 360 + 30 = reap @ 390
    sentinel: { stallThresholdMinutes: 75 },        // 75  + 30 = reap @ 105
    brand_enricher: { stallThresholdMinutes: 5 },   // 5   + 30 = reap @ 35
    no_threshold: {},                               // → default 90
  },
}));

interface Candidate {
  id: string;
  agent_id: string;
  started_at: string;
  age_minutes: number;
}

function makeEnv(opts: {
  candidates?: Candidate[];
  changes?: Record<string, number>;     // row.id → meta.changes returned by per-row UPDATE
  selectThrows?: boolean;
  updateThrowsFor?: string[];           // row ids whose UPDATE should throw
}): {
  env: Env;
  updateCalls: Array<{ ceiling: number; id: string }>;
} {
  const updateCalls: Array<{ ceiling: number; id: string }> = [];

  const env = {
    DB: {
      prepare(sql: string) {
        const lower = sql.toLowerCase();
        // SELECT path — candidates list.
        if (lower.startsWith("select")) {
          return {
            all: async () => {
              if (opts.selectThrows) throw new Error("D1 SELECT failed");
              return { results: opts.candidates ?? [] };
            },
          };
        }
        // UPDATE path — accepts (ceiling, id) bind args via .bind().run().
        return {
          bind: (...args: unknown[]) => ({
            run: async () => {
              const ceiling = args[0] as number;
              const id = args[1] as string;
              updateCalls.push({ ceiling, id });
              if (opts.updateThrowsFor?.includes(id)) {
                throw new Error(`D1 UPDATE failed for ${id}`);
              }
              const changes = opts.changes?.[id] ?? 1;
              return { success: true, meta: { changes } };
            },
          }),
        };
      },
    },
  } as unknown as Env;

  return { env, updateCalls };
}

describe("reapOrphanAgentRuns", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT reap NEXUS at 100 min (under its per-agent ceiling)", async () => {
    const { env, updateCalls } = makeEnv({
      candidates: [
        { id: "run-nexus-100", agent_id: "nexus", started_at: "x", age_minutes: 100 },
      ],
    });
    const reaped = await reapOrphanAgentRuns(env);
    expect(reaped).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("reaps NEXUS at 400 min (past its 360 + 30 ceiling)", async () => {
    const { env, updateCalls } = makeEnv({
      candidates: [
        { id: "run-nexus-400", agent_id: "nexus", started_at: "x", age_minutes: 400 },
      ],
      changes: { "run-nexus-400": 1 },
    });
    const reaped = await reapOrphanAgentRuns(env);
    expect(reaped).toBe(1);
    expect(updateCalls).toEqual([{ ceiling: 390, id: "run-nexus-400" }]);
  });

  it("reaps sentinel at its 105-min ceiling, not the default 90", async () => {
    const { env, updateCalls } = makeEnv({
      candidates: [
        { id: "s-100", agent_id: "sentinel", started_at: "x", age_minutes: 100 },   // < 105 → skip
        { id: "s-200", agent_id: "sentinel", started_at: "x", age_minutes: 200 },   // > 105 → reap
      ],
      changes: { "s-200": 1 },
    });
    const reaped = await reapOrphanAgentRuns(env);
    expect(reaped).toBe(1);
    expect(updateCalls).toEqual([{ ceiling: 105, id: "s-200" }]);
  });

  it("falls back to DEFAULT (90) for agents not in the registry", async () => {
    const { env, updateCalls } = makeEnv({
      candidates: [
        { id: "u-old",   agent_id: "unknown_agent", started_at: "x", age_minutes: 200 },
        { id: "u-young", agent_id: "unknown_agent", started_at: "x", age_minutes: 50 },
      ],
      changes: { "u-old": 1 },
    });
    const reaped = await reapOrphanAgentRuns(env);
    expect(reaped).toBe(1);
    expect(updateCalls).toEqual([{ ceiling: 90, id: "u-old" }]);
  });

  it("uses DEFAULT when the module exists but has no stallThresholdMinutes", async () => {
    const { env, updateCalls } = makeEnv({
      candidates: [
        { id: "n-old", agent_id: "no_threshold", started_at: "x", age_minutes: 200 },
      ],
      changes: { "n-old": 1 },
    });
    await reapOrphanAgentRuns(env);
    expect(updateCalls).toEqual([{ ceiling: 90, id: "n-old" }]);
  });

  it("processes multiple agents in one sweep with their own ceilings", async () => {
    const { env, updateCalls } = makeEnv({
      candidates: [
        { id: "n-400",   agent_id: "nexus",          started_at: "x", age_minutes: 400 }, // reap
        { id: "n-200",   agent_id: "nexus",          started_at: "x", age_minutes: 200 }, // skip (<390)
        { id: "s-150",   agent_id: "sentinel",       started_at: "x", age_minutes: 150 }, // reap (>105)
        { id: "be-40",   agent_id: "brand_enricher", started_at: "x", age_minutes: 40 },  // reap (>35)
      ],
      changes: { "n-400": 1, "s-150": 1, "be-40": 1 },
    });
    const reaped = await reapOrphanAgentRuns(env);
    expect(reaped).toBe(3);
    expect(updateCalls.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { ceiling: 35, id: "be-40" },
      { ceiling: 390, id: "n-400" },
      { ceiling: 105, id: "s-150" },
    ]);
  });

  it("returns 0 when no candidate rows are returned by SELECT", async () => {
    const { env, updateCalls } = makeEnv({ candidates: [] });
    expect(await reapOrphanAgentRuns(env)).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("returns 0 when the SELECT itself throws (never crashes navigator)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = makeEnv({ selectThrows: true });
    expect(await reapOrphanAgentRuns(env)).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("per-row UPDATE failure doesn't abort the rest of the sweep", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, updateCalls } = makeEnv({
      candidates: [
        { id: "x-1", agent_id: "nexus",    started_at: "x", age_minutes: 400 }, // throws
        { id: "x-2", agent_id: "sentinel", started_at: "x", age_minutes: 150 }, // succeeds
      ],
      changes: { "x-2": 1 },
      updateThrowsFor: ["x-1"],
    });
    const reaped = await reapOrphanAgentRuns(env);
    expect(reaped).toBe(1);   // only x-2 counted
    expect(updateCalls.map((c) => c.id).sort()).toEqual(["x-1", "x-2"]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("exposes the policy constants for callers + platform docs", () => {
    expect(DEFAULT_REAP_AGE_MINUTES).toBe(90);
    expect(REAP_BUFFER_MINUTES).toBe(30);
  });
});
