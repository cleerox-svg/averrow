/**
 * S3.4b (Wave 3) — direct unit coverage for the orchestrator's cron
 * hour-gate dispatch table (`src/cron/orchestrator.ts`, inside the
 * hourly `7 * * * *` mesh tick).
 *
 * This is the exact wiring class whose silent breakage caused the
 * historical 22-hour agent-mesh outage (CLAUDE.md §6 "cron-audit
 * rule", also documented at the top of `runThreatFeedScan` in
 * orchestrator.ts): the orchestrator's cron moved from `0 * * * *` to
 * `7 * * * *` and a stale `minute === 0` gate silently killed every
 * hour-gated agent for ~22 hours, tsc-clean, because a minute literal
 * that no longer matched the firing minute is dead code forever.
 *
 * The seam: `handleScheduled` is the real entry point Cloudflare Workers
 * calls on a scheduled trigger, and it is genuinely side-effectful (feed
 * ingestion, enrichment, D1 writes, agent dispatch). There is no pure,
 * extractable "which agents fire this hour" function to call directly —
 * the gates are inline `if (hour ...)` checks scattered through
 * `handleScheduled` and `runThreatFeedScan`. Per the task brief, this
 * suite does NOT refactor product code to create that seam; instead it
 * calls the real `handleScheduled` with `event.cron === '7 * * * *'`
 * (the hourly mesh) and a fully-controlled `Env`, and intercepts
 * dispatch at its two real chokepoints:
 *
 *   - `executeAgent` (src/lib/agentRunner.ts) — every AgentModule-based
 *     dispatch (analyst, attributor, news_watcher, observer, narrator,
 *     notification_narrator, auto_seeder, geoip_refresh, seed_strategist,
 *     flight_control, ...) funnels through this one function.
 *   - `dispatchWorkflow` (src/lib/workflow-dispatch.ts) — NEXUS's
 *     Workflow dispatch, the one gate NOT wired through executeAgent.
 *
 * Every other dynamically-imported module `runThreatFeedScan` touches on
 * EVERY tick (feed ingestion, geo enrichment, threat-feed sync, brand
 * match backfill, tranco import, snapshots, brand candidates, incident
 * recovery, sentinel's social assessment) is replaced with a spy via
 * `vi.importActual` + override, so real network/D1 work never happens
 * and each hour-gated call site becomes directly observable. The D1
 * fake only needs to answer the handful of bare COUNT(*) queries left
 * in the un-mocked code paths — everything else is intercepted upstream.
 *
 * This suite's job is narrow and mechanical: pin the gate → dispatch
 * mapping so a regression of the outage class (a cron-minute change
 * that silently orphans a gate, an off-by-one in a modulus, a swap from
 * `event.scheduledTime` to wall-clock time) fails LOUDLY here instead of
 * silently in production.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/types";

// ─── Chokepoint #1: every AgentModule dispatch funnels through executeAgent ───
const executeAgentCalls: string[] = [];
vi.mock("../src/lib/agentRunner", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/agentRunner")>(
    "../src/lib/agentRunner",
  );
  return {
    ...actual,
    executeAgent: vi.fn(async (_env: unknown, agentModule: { name: string }) => {
      executeAgentCalls.push(agentModule.name);
      return { runId: "test-run", status: "success" as const, result: null };
    }),
  };
});

// ─── Chokepoint #2: NEXUS's Workflow dispatch (not wired through executeAgent) ───
const dispatchWorkflowSpy = vi.fn(async () => ({
  kind: "dispatched" as const,
  instance_id: "wf-test-1",
}));
vi.mock("../src/lib/workflow-dispatch", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/workflow-dispatch")>(
    "../src/lib/workflow-dispatch",
  );
  return { ...actual, dispatchWorkflow: dispatchWorkflowSpy };
});

// ─── Sentinel's social assessment: a ctx.waitUntil call, not executeAgent ───
const sentinelSocialSpy = vi.fn(async () => {});
vi.mock("../src/agents/sentinel", async () => {
  const actual = await vi.importActual<typeof import("../src/agents/sentinel")>(
    "../src/agents/sentinel",
  );
  return { ...actual, runSentinelSocialAssessment: sentinelSocialSpy };
});

// ─── Neutralize the always-runs-every-tick work inside runThreatFeedScan so
//     it can't do real network/D1 work and so hour-gated calls stand out. ───
const enrichThreatsGeoSpy = vi.fn(async () => ({}));
vi.mock("../src/lib/geoip", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/geoip")>("../src/lib/geoip");
  return { ...actual, enrichThreatsGeo: enrichThreatsGeoSpy };
});

const runAllFeedsSpy = vi.fn(async () => ({
  feedsRun: 0, totalNew: 0, feedsFailed: 0, feedsSkipped: 0,
}));
const runAllEnrichmentFeedsSpy = vi.fn(async () => ({
  feedsRun: 0, totalEnriched: 0, feedsFailed: 0, feedsSkipped: 0,
}));
const runAllSocialFeedsSpy = vi.fn(async () => ({
  feedsRun: 0, totalNew: 0, feedsFailed: 0, feedsSkipped: 0,
}));
vi.mock("../src/lib/feedRunner", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/feedRunner")>(
    "../src/lib/feedRunner",
  );
  return {
    ...actual,
    runAllFeeds: runAllFeedsSpy,
    runAllEnrichmentFeeds: runAllEnrichmentFeedsSpy,
    runAllSocialFeeds: runAllSocialFeedsSpy,
  };
});

const runEnrichmentPipelineSpy = vi.fn(async () => ({
  dnsResolved: 0, geoEnriched: 0, whoisEnriched: 0, brandsMatched: 0, domainRanksChecked: 0,
}));
vi.mock("../src/lib/enrichment", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/enrichment")>(
    "../src/lib/enrichment",
  );
  return { ...actual, runEnrichmentPipeline: runEnrichmentPipelineSpy };
});

const runThreatFeedSyncSpy = vi.fn(async () => ({
  phishtank: { fetched: 0, matched: 0 },
  urlhaus: { fetched: 0, matched: 0 },
}));
vi.mock("../src/threat-feeds", async () => {
  const actual = await vi.importActual<typeof import("../src/threat-feeds")>(
    "../src/threat-feeds",
  );
  return { ...actual, runThreatFeedSync: runThreatFeedSyncSpy };
});

const runDailyAssessmentsSpy = vi.fn(async () => ({
  brandsAssessed: 0, highRiskBrands: 0, scoreSpikes: 0,
}));
vi.mock("../src/brand-threat-correlator", async () => {
  const actual = await vi.importActual<typeof import("../src/brand-threat-correlator")>(
    "../src/brand-threat-correlator",
  );
  return { ...actual, runDailyAssessments: runDailyAssessmentsSpy };
});

const generateDailySnapshotsSpy = vi.fn(async () => {});
vi.mock("../src/lib/snapshots", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/snapshots")>(
    "../src/lib/snapshots",
  );
  return { ...actual, generateDailySnapshots: generateDailySnapshotsSpy };
});

const aggregateBrandCandidatesSpy = vi.fn(async () => ({}));
vi.mock("../src/lib/brand-candidates", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/brand-candidates")>(
    "../src/lib/brand-candidates",
  );
  return { ...actual, aggregateBrandCandidates: aggregateBrandCandidatesSpy };
});

const runIncidentRecoverySweepSpy = vi.fn(async () => ({
  recovered: 0, stillFailing: 0, skipped: 0,
}));
vi.mock("../src/lib/incident-recovery", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/incident-recovery")>(
    "../src/lib/incident-recovery",
  );
  return { ...actual, runIncidentRecoverySweep: runIncidentRecoverySweepSpy };
});

const handleImportTrancoSpy = vi.fn(
  async () =>
    new Response(JSON.stringify({ success: true, data: { imported: 0, message: "mocked" } })),
);
vi.mock("../src/handlers/admin", async () => {
  const actual = await vi.importActual<typeof import("../src/handlers/admin")>(
    "../src/handlers/admin",
  );
  return { ...actual, handleImportTranco: handleImportTrancoSpy };
});

// ─── Fixtures ────────────────────────────────────────────────────

const MONDAY = "2026-07-20"; // not a Sunday — keeps the day-of-week gates quiet
const SUNDAY = "2026-07-19";

function eventAtHour(hour: number, day = MONDAY, minute = 7): ScheduledEvent {
  const iso = `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;
  return {
    cron: "7 * * * *",
    scheduledTime: Date.parse(iso),
    type: "scheduled",
  } as unknown as ScheduledEvent;
}

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** `dailySnapshotCount` controls the answer to the daily_snapshots
 *  COUNT(*) query so tests can isolate the `hour === 0` branch of the
 *  `hour === 0 || no-snapshot-yet` OR-gate from its fallback branch. */
function makeEnv(opts: { dailySnapshotCount?: number } = {}): Env {
  const dailySnapshotCount = opts.dailySnapshotCount ?? 1;

  const db = {
    prepare(sql: string) {
      const lower = sql.toLowerCase();
      const exec = () => ({
        run: async () => ({ meta: { last_row_id: 1, changes: 0 }, success: true }),
        first: async <T>(): Promise<T | null> => {
          if (lower.includes("count(*) as n from daily_snapshots")) {
            return { n: dailySnapshotCount } as unknown as T;
          }
          // Every other bare COUNT(*) left un-mocked (threats brand-match
          // backlog, brands email-security backlog, AI-attribution
          // backlog) answers 0 so their conditional side-work never fires
          // — it isn't part of the hour-gate table under test here.
          if (lower.includes("count(*) as n from threats") || lower.includes("count(*) as n from brands")) {
            return { n: 0 } as unknown as T;
          }
          return null;
        },
        all: async <T>() => ({ results: [] as T[] }),
      });
      return {
        bind: (..._args: unknown[]) => exec(),
        run: exec().run,
        first: exec().first,
        all: exec().all,
      };
    },
  };

  const cache = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };

  const certstreamFetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          stats: { connected: true, certsProcessed: 0, certsMatched: 0, errors: 0 },
        }),
      ),
  );
  const certstreamNamespace = {
    idFromName: (_name: string) => "cs-id",
    get: (_id: string) => ({ fetch: certstreamFetch }),
  };

  return {
    DB: db,
    CACHE: cache,
    CERTSTREAM_MONITOR: certstreamNamespace,
    NEXUS_RUN: {},
  } as unknown as Env;
}

describe("S3.4b — orchestrator hour-gate dispatch table (src/cron/orchestrator.ts)", () => {
  beforeEach(() => {
    executeAgentCalls.length = 0;
    vi.clearAllMocks();
  });

  it("locks the modular gates (NEXUS + enrichment %4===0, attributor %4===1, sentinel-social %6===0, news_watcher %6===2) across the full 0-23 hour cycle", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");

    for (let hour = 0; hour < 24; hour++) {
      executeAgentCalls.length = 0;
      dispatchWorkflowSpy.mockClear();
      sentinelSocialSpy.mockClear();
      runEnrichmentPipelineSpy.mockClear();

      const env = makeEnv();
      // eslint-disable-next-line no-await-in-loop
      await handleScheduled(eventAtHour(hour), env, ctx);

      expect([hour, dispatchWorkflowSpy.mock.calls.length > 0]).toEqual([hour, hour % 4 === 0]);
      expect([hour, runEnrichmentPipelineSpy.mock.calls.length > 0]).toEqual([hour, hour % 4 === 0]);
      expect([hour, sentinelSocialSpy.mock.calls.length > 0]).toEqual([hour, hour % 6 === 0]);
      expect([hour, executeAgentCalls.includes("attributor")]).toEqual([hour, hour % 4 === 1]);
      expect([hour, executeAgentCalls.includes("news_watcher")]).toEqual([hour, hour % 6 === 2]);
    }
  });

  it("hour===0 fires observer + daily assessments + the brand-candidates aggregator, and forces the snapshot generator even when a snapshot already exists today", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    const env = makeEnv({ dailySnapshotCount: 5 }); // a snapshot already exists — only hour===0 should still force a run

    await handleScheduled(eventAtHour(0), env, ctx);

    expect(executeAgentCalls).toContain("observer");
    expect(runDailyAssessmentsSpy).toHaveBeenCalledTimes(1);
    expect(aggregateBrandCandidatesSpy).toHaveBeenCalledTimes(1);
    expect(generateDailySnapshotsSpy).toHaveBeenCalledTimes(1);
  });

  it("the hour===0 gates stay quiet at the adjacent hours 1 and 23 (no off-by-one, no wrap-around leak), and the snapshot generator is skipped once a snapshot already exists for the day", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");

    for (const hour of [1, 23]) {
      executeAgentCalls.length = 0;
      runDailyAssessmentsSpy.mockClear();
      aggregateBrandCandidatesSpy.mockClear();
      generateDailySnapshotsSpy.mockClear();

      const env = makeEnv({ dailySnapshotCount: 3 });
      // eslint-disable-next-line no-await-in-loop
      await handleScheduled(eventAtHour(hour), env, ctx);

      expect(executeAgentCalls).not.toContain("observer");
      expect(runDailyAssessmentsSpy).not.toHaveBeenCalled();
      expect(aggregateBrandCandidatesSpy).not.toHaveBeenCalled();
      expect(generateDailySnapshotsSpy).not.toHaveBeenCalled();
    }
  });

  it("the snapshot generator still fires off-hour when no snapshot exists yet for the day (the OR branch of `hour === 0 || no-snapshot-yet`)", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    const env = makeEnv({ dailySnapshotCount: 0 });

    await handleScheduled(eventAtHour(9), env, ctx);

    expect(generateDailySnapshotsSpy).toHaveBeenCalledTimes(1);
  });

  it("hour===6 fires the observer briefing (tranco import) + seed_strategist + threat narratives (narrator)", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    const env = makeEnv();

    await handleScheduled(eventAtHour(6), env, ctx);

    expect(handleImportTrancoSpy).toHaveBeenCalledTimes(1);
    expect(executeAgentCalls).toContain("seed_strategist");
    expect(executeAgentCalls).toContain("narrator");
  });

  it("hours 5 and 7 do not fire the hour===6-only observer-briefing gate", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");

    for (const hour of [5, 7]) {
      executeAgentCalls.length = 0;
      handleImportTrancoSpy.mockClear();

      const env = makeEnv();
      // eslint-disable-next-line no-await-in-loop
      await handleScheduled(eventAtHour(hour), env, ctx);

      expect(handleImportTrancoSpy).not.toHaveBeenCalled();
      expect(executeAgentCalls).not.toContain("seed_strategist");
      expect(executeAgentCalls).not.toContain("narrator");
    }
  });

  it("hour===13 fires the notification digest (notification_narrator); hours 12 and 14 do not", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");

    const env13 = makeEnv();
    await handleScheduled(eventAtHour(13), env13, ctx);
    expect(executeAgentCalls).toContain("notification_narrator");

    for (const hour of [12, 14]) {
      executeAgentCalls.length = 0;
      const env = makeEnv();
      // eslint-disable-next-line no-await-in-loop
      await handleScheduled(eventAtHour(hour), env, ctx);
      expect(executeAgentCalls).not.toContain("notification_narrator");
    }
  });

  it("auto_seeder fires ONLY Sunday hour===5 — a day-of-week AND hour compound gate, not just an hour gate", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");

    const sunday5 = makeEnv();
    await handleScheduled(eventAtHour(5, SUNDAY), sunday5, ctx);
    expect(executeAgentCalls).toContain("auto_seeder");

    // Same hour, NOT Sunday — must not fire (proves the day gate matters, not just the hour).
    executeAgentCalls.length = 0;
    const monday5 = makeEnv();
    await handleScheduled(eventAtHour(5, MONDAY), monday5, ctx);
    expect(executeAgentCalls).not.toContain("auto_seeder");

    // Sunday, but the wrong hour — must not fire (proves the hour gate on top of the day gate).
    executeAgentCalls.length = 0;
    const sunday6 = makeEnv();
    await handleScheduled(eventAtHour(6, SUNDAY), sunday6, ctx);
    expect(executeAgentCalls).not.toContain("auto_seeder");
  });

  it("geoip_refresh fires ONLY Sunday hour===2", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");

    const sunday2 = makeEnv();
    await handleScheduled(eventAtHour(2, SUNDAY), sunday2, ctx);
    expect(executeAgentCalls).toContain("geoip_refresh");

    executeAgentCalls.length = 0;
    const monday2 = makeEnv();
    await handleScheduled(eventAtHour(2, MONDAY), monday2, ctx);
    expect(executeAgentCalls).not.toContain("geoip_refresh");
  });

  // ─── Regression guards for the outage's exact failure class ─────

  it("gates are hour-only — dispatch is identical regardless of the cron's fire MINUTE (the exact bug class behind the 22h mesh outage: a stale minute===0 gate silently killed everything once the cron moved to :07)", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");

    for (const minute of [0, 7, 45]) {
      executeAgentCalls.length = 0;
      dispatchWorkflowSpy.mockClear();

      const env = makeEnv();
      // eslint-disable-next-line no-await-in-loop
      await handleScheduled(eventAtHour(4, MONDAY, minute), env, ctx);

      // hour 4: 4 % 4 === 0 — NEXUS + analyst must fire no matter what
      // minute the event carries. A reintroduced minute gate (the
      // original bug) would flip this to false for minutes != 0.
      expect(dispatchWorkflowSpy).toHaveBeenCalledTimes(1);
      expect(executeAgentCalls).toContain("analyst");
    }
  });

  it("hour gates key off event.scheduledTime, not the wall clock at invocation time — clock drift can't silently flip a gate", async () => {
    vi.useFakeTimers();
    try {
      // Wall clock says hour 18 (18 % 4 !== 0, 18 % 6 === 0) — the
      // OPPOSITE gate state from the scheduled hour below.
      vi.setSystemTime(new Date(`${MONDAY}T18:00:00Z`));

      const { handleScheduled } = await import("../src/cron/orchestrator");
      const env = makeEnv();

      // scheduledTime says hour 4 (4 % 4 === 0, 4 % 6 !== 0).
      await handleScheduled(eventAtHour(4), env, ctx);

      expect(dispatchWorkflowSpy).toHaveBeenCalledTimes(1); // fired: scheduledTime hour is 4
      expect(sentinelSocialSpy).not.toHaveBeenCalled(); // correctly quiet: 4 % 6 !== 0
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins the gate literals in source so a stray edit to the hour-gate table shows up as an intentional diff here", () => {
    const orchestratorPath = fileURLToPath(new URL("../src/cron/orchestrator.ts", import.meta.url));
    const src = readFileSync(orchestratorPath, "utf8");

    expect(src).toContain("hour % 4 === 0"); // NEXUS + enrichment pipeline cadence
    expect(src).toContain("hour % 6 === 0"); // sentinel social assessment
    expect(src).toContain("hour % 4 === 1"); // attributor
    expect(src).toContain("hour % 6 === 2"); // news_watcher
    expect(src).toContain("hour === 0");
    expect(src).toContain("hour === 6");
    expect(src).toContain("hour === 13");
    // No lingering LIVE minute-based gate inside the hourly mesh — the
    // exact pattern that caused the 22h outage. (The file's bug-history
    // comment block legitimately mentions `minute === 0` in prose, so
    // this checks for an actual `if (...minute...)` conditional, not
    // just the substring anywhere in the file.)
    expect(src).not.toMatch(/if\s*\([^)]*\bminute\b[^)]*\)/);
  });
});
