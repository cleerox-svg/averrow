/**
 * Tests for the daily-briefing agent-run contract (Tier 2b).
 *
 * The daily platform briefing is a handler, not an AgentModule, but it
 * still participates in the agent_runs / agent_events contract so the
 * daily assessment is visible in agent_mesh / platform-diagnostics.
 *
 * Verifies:
 *   1. generateAndEmailBriefing writes ONE agent_runs row (agent_id
 *      'daily_briefing', started 'running'), completes it, and emits a
 *      'briefing_generated' telemetry event (target_agent = NULL).
 *   2. On generation/persist failure the run is marked failed via
 *      failAgentRun and the original error still propagates.
 *   3. The cron dedup-skip path does NOT write an agent_runs row — the
 *      run write lives inside generation, which the dedup guard skips.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

// Keep the briefing email out of the test — it's I/O and already
// covered by its own error-handling; we only care about the run contract.
vi.mock("../src/lib/briefing-email", () => ({
  sendBriefingEmail: vi.fn(async () => ({ sent: true, id: "email_test" })),
}));

interface Recorder {
  agentRunInserts: Array<{ args: unknown[] }>;
  agentRunUpdates: Array<{ sql: string; args: unknown[] }>;
  events: Array<{ sql: string; args: unknown[] }>;
  briefingInserts: number;
}

interface MakeEnvOpts {
  // count returned by the cron dedup SELECT ... threat_briefings
  dedupCount?: number;
  // when true, the threat_briefings INSERT throws (generation failure)
  failBriefingInsert?: boolean;
  // when true, the agent_runs INSERT throws (run-start bookkeeping hiccup)
  failAgentRunInsert?: boolean;
  // when set, the cached-briefing SELECT returns a row (12h-window cache hit)
  cachedRow?: Record<string, unknown> | null;
}

function makeEnv(opts: MakeEnvOpts = {}): { env: Env; rec: Recorder } {
  const rec: Recorder = {
    agentRunInserts: [],
    agentRunUpdates: [],
    events: [],
    briefingInserts: 0,
  };

  const db = {
    prepare(sql: string) {
      const lower = sql.toLowerCase();
      const exec = (args: unknown[]) => ({
        run: async () => {
          if (lower.includes("insert into agent_runs")) {
            if (opts.failAgentRunInsert) throw new Error("D1 agent_runs INSERT failed");
            rec.agentRunInserts.push({ args });
            return { meta: { last_row_id: 0 } };
          }
          if (lower.includes("update agent_runs")) {
            rec.agentRunUpdates.push({ sql, args });
            return { meta: {} };
          }
          if (lower.includes("insert into agent_events")) {
            rec.events.push({ sql, args });
            return { meta: {} };
          }
          if (lower.includes("insert into threat_briefings")) {
            if (opts.failBriefingInsert) throw new Error("D1 briefings INSERT failed");
            rec.briefingInserts++;
            return { meta: { last_row_id: 42 } };
          }
          return { meta: { last_row_id: 42 } };
        },
        first: async () => {
          // Cron dedup guard: SELECT COUNT(*) ... threat_briefings
          if (lower.includes("count(*)") && lower.includes("threat_briefings")) {
            return { count: opts.dedupCount ?? 0 };
          }
          // On-demand cached-briefing lookup (12h window).
          if (lower.includes("from threat_briefings") && lower.includes("-12 hours")) {
            return opts.cachedRow ?? null;
          }
          return {};
        },
        all: async () => ({ results: [] }),
      });
      return {
        bind: (...args: unknown[]) => exec(args),
        // safeFirst/safeQuery call prepare(sql).first()/.all() without bind
        run: exec([]).run,
        first: exec([]).first,
        all: exec([]).all,
      };
    },
  };

  return { env: { DB: db } as unknown as Env, rec };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe("daily briefing agent-run contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes one agent_runs row and emits a briefing_generated event on generation", async () => {
    const { generateAndEmailBriefing } = await import("../src/handlers/briefing");
    const { env, rec } = makeEnv();

    const result = await generateAndEmailBriefing(env, "cron:daily");

    // Existing return contract preserved.
    expect(result.briefingId).toBe(42);
    expect(result.emailSent).toBe(true);

    // Exactly one run, agent_id 'daily_briefing'.
    expect(rec.agentRunInserts).toHaveLength(1);
    expect(rec.agentRunInserts[0].args[1]).toBe("daily_briefing");

    // Run completed (not left running).
    expect(rec.agentRunUpdates).toHaveLength(1);
    expect(rec.agentRunUpdates[0].args[0]).toBe("success");

    // Telemetry event emitted with target_agent = NULL (SQL literal).
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0].sql).toContain("briefing_generated");
    expect(rec.events[0].sql).toContain("NULL");
    expect(rec.briefingInserts).toBe(1);
  });

  it("marks the run failed and propagates the error when persistence throws", async () => {
    const { generateAndEmailBriefing } = await import("../src/handlers/briefing");
    const { env, rec } = makeEnv({ failBriefingInsert: true });

    await expect(generateAndEmailBriefing(env, "cron:daily")).rejects.toThrow(
      /briefings INSERT failed/,
    );

    // Run was opened, then marked failed (via failAgentRun UPDATE).
    expect(rec.agentRunInserts).toHaveLength(1);
    expect(rec.agentRunUpdates).toHaveLength(1);
    expect(rec.agentRunUpdates[0].sql.toLowerCase()).toContain("status = 'failed'");
    // No success telemetry on failure.
    expect(rec.events).toHaveLength(0);
  });

  it("does NOT write an agent_runs row on the cron dedup-skip path", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    const { env, rec } = makeEnv({ dedupCount: 1 });

    const event = {
      cron: "13 13 * * *",
      scheduledTime: Date.parse("2026-07-12T13:13:00Z"),
      type: "scheduled",
    } as unknown as ScheduledEvent;

    await handleScheduled(event, env, ctx);

    // Already-emailed today → generation skipped → no run written.
    expect(rec.agentRunInserts).toHaveLength(0);
    expect(rec.briefingInserts).toBe(0);
    expect(rec.events).toHaveLength(0);
  });

  it("does NOT write an agent_runs row or event on the on-demand cached-return path", async () => {
    const { handleGenerateBriefing } = await import("../src/handlers/briefing");
    const { env, rec } = makeEnv({
      cachedRow: { id: 7, type: "daily", report_date: "2026-07-12", emailed: 1 },
    });

    const request = new Request("https://x/api/admin/briefing?cached=true", {
      headers: { Origin: "https://x" },
    });
    const res = await handleGenerateBriefing(request, env, "usr_1");
    const body = (await res.json()) as { success: boolean; cached: boolean };

    // Cache hit → returns the existing row, generates nothing.
    expect(body.cached).toBe(true);
    expect(rec.agentRunInserts).toHaveLength(0);
    expect(rec.briefingInserts).toBe(0);
    expect(rec.events).toHaveLength(0);
  });

  it("still generates + returns the briefing when the agent_runs INSERT throws (best-effort bookkeeping)", async () => {
    const { generateAndEmailBriefing } = await import("../src/handlers/briefing");
    const { env, rec } = makeEnv({ failAgentRunInsert: true });

    const result = await generateAndEmailBriefing(env, "cron:daily");

    // Deliverable is unaffected by the run-tracking hiccup.
    expect(result.briefingId).toBe(42);
    expect(result.emailSent).toBe(true);
    expect(rec.briefingInserts).toBe(1);

    // No runId was obtained → no completion/fail UPDATE attempted.
    expect(rec.agentRunInserts).toHaveLength(0);
    expect(rec.agentRunUpdates).toHaveLength(0);
    // Telemetry event still emitted (independent of the run row).
    expect(rec.events).toHaveLength(1);
  });
});
