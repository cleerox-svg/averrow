/**
 * Orchestrator hourly tick: feed ingestion runs BEFORE the best-effort
 * inline geo pass, and that pass is wall-clock bounded.
 *
 * Incident 2026-11-09 20:07 UTC: zero feeds pulled; the last orchestrator
 * action was the NEXUS dispatch. `runThreatFeedScan` awaited
 * `enrichThreatsGeo` (no timeout) before `runAllFeeds`, and D1 was
 * saturated around :05-:07, so the optional geo step held the invocation
 * until it died — and because runAllFeeds never ran, it never threw, so
 * no `platform_feed_silent` alert either.
 *
 * Harness mirrors test/orchestrator-hour-gate.test.ts: the real
 * `handleScheduled` with `event.cron === '7 * * * *'`, every side-effectful
 * module replaced by a spy.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/types";

const callOrder: string[] = [];

const executeAgentCalls: string[] = [];
vi.mock("../src/lib/agentRunner", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/agentRunner")>(
    "../src/lib/agentRunner",
  );
  return {
    ...actual,
    executeAgent: vi.fn(async (_env: unknown, agentModule: { name: string }) => {
      executeAgentCalls.push(agentModule.name);
      callOrder.push(`agent:${agentModule.name}`);
      return { runId: "test-run", status: "success" as const, result: null };
    }),
  };
});

vi.mock("../src/lib/workflow-dispatch", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/workflow-dispatch")>(
    "../src/lib/workflow-dispatch",
  );
  return {
    ...actual,
    dispatchWorkflow: vi.fn(async () => {
      callOrder.push("dispatchWorkflow");
      return { kind: "dispatched" as const, instance_id: "wf-test-1" };
    }),
  };
});

vi.mock("../src/agents/sentinel", async () => {
  const actual = await vi.importActual<typeof import("../src/agents/sentinel")>(
    "../src/agents/sentinel",
  );
  return { ...actual, runSentinelSocialAssessment: vi.fn(async () => {}) };
});

type GeoImpl = () => Promise<unknown>;
let geoImpl: GeoImpl = async () => ({});
const enrichThreatsGeoSpy = vi.fn(async () => {
  callOrder.push("enrichThreatsGeo");
  return geoImpl();
});
vi.mock("../src/lib/geoip", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/geoip")>("../src/lib/geoip");
  return { ...actual, enrichThreatsGeo: enrichThreatsGeoSpy };
});

let feedsTotalNew = 0;
const runAllFeedsSpy = vi.fn(async () => {
  callOrder.push("runAllFeeds");
  return { feedsRun: 1, totalNew: feedsTotalNew, feedsFailed: 2, feedsSkipped: 3, feedsTimedOut: 1, feedsDeferred: 2 };
});
const runAllEnrichmentFeedsSpy = vi.fn(async (..._args: unknown[]) => {
  callOrder.push("runAllEnrichmentFeeds");
  return { feedsRun: 2, totalEnriched: 0, feedsFailed: 1, feedsSkipped: 1, feedsTimedOut: 1, feedsDeferred: 1 };
});
const runAllSocialFeedsSpy = vi.fn(async (..._args: unknown[]) => {
  callOrder.push("runAllSocialFeeds");
  return { feedsRun: 1, totalNew: 0, feedsFailed: 1, feedsSkipped: 2, feedsTimedOut: 1, feedsDeferred: 2 };
});
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

vi.mock("../src/lib/enrichment", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/enrichment")>(
    "../src/lib/enrichment",
  );
  return {
    ...actual,
    runEnrichmentPipeline: vi.fn(async () => ({
      dnsResolved: 0, geoEnriched: 0, whoisEnriched: 0, brandsMatched: 0, domainRanksChecked: 0,
    })),
  };
});

vi.mock("../src/threat-feeds", async () => {
  const actual = await vi.importActual<typeof import("../src/threat-feeds")>("../src/threat-feeds");
  return {
    ...actual,
    runThreatFeedSync: vi.fn(async () => ({
      phishtank: { fetched: 0, matched: 0 },
      urlhaus: { fetched: 0, matched: 0 },
    })),
  };
});

vi.mock("../src/brand-threat-correlator", async () => {
  const actual = await vi.importActual<typeof import("../src/brand-threat-correlator")>(
    "../src/brand-threat-correlator",
  );
  return {
    ...actual,
    runDailyAssessments: vi.fn(async () => ({ brandsAssessed: 0, highRiskBrands: 0, scoreSpikes: 0 })),
  };
});

vi.mock("../src/lib/brand-candidates", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/brand-candidates")>(
    "../src/lib/brand-candidates",
  );
  return { ...actual, aggregateBrandCandidates: vi.fn(async () => ({})) };
});

vi.mock("../src/lib/incident-recovery", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/incident-recovery")>(
    "../src/lib/incident-recovery",
  );
  return {
    ...actual,
    runIncidentRecoverySweep: vi.fn(async () => ({ recovered: 0, stillFailing: 0, skipped: 0 })),
  };
});

vi.mock("../src/handlers/admin", async () => {
  const actual = await vi.importActual<typeof import("../src/handlers/admin")>("../src/handlers/admin");
  return {
    ...actual,
    handleImportTranco: vi.fn(
      async () => new Response(JSON.stringify({ success: true, data: { imported: 0, message: "mocked" } })),
    ),
  };
});

const infoSpy = vi.fn();
const warnSpy = vi.fn();
const errorSpy = vi.fn();
vi.mock("../src/lib/logger", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/logger")>("../src/lib/logger");
  return {
    ...actual,
    logger: {
      ...actual.logger,
      info: (event: string, data?: Record<string, unknown>) => infoSpy(event, data),
      warn: (event: string, data?: Record<string, unknown>) => warnSpy(event, data),
      error: (event: string, data?: Record<string, unknown>) => errorSpy(event, data),
    },
  };
});

// ─── Fixtures ────────────────────────────────────────────────────

const MONDAY = "2026-07-20";

function eventAtHour(hour: number): ScheduledEvent {
  return {
    cron: "7 * * * *",
    scheduledTime: Date.parse(`${MONDAY}T${String(hour).padStart(2, "0")}:07:00Z`),
    type: "scheduled",
  } as unknown as ScheduledEvent;
}

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function makeEnv(): Env {
  const db = {
    prepare(sql: string) {
      const lower = sql.toLowerCase();
      const exec = () => ({
        run: async () => {
          callOrder.push(lower.includes("insert into agent_events") ? "agent_events_insert" : "db_run");
          return { meta: { last_row_id: 1, changes: 0 }, success: true };
        },
        first: async <T>(): Promise<T | null> => {
          if (lower.includes("count(*)")) return { n: 0, count: 0 } as unknown as T;
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
  return {
    DB: db,
    CACHE: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
    CERTSTREAM_MONITOR: {
      idFromName: () => "cs-id",
      get: () => ({
        fetch: vi.fn(async () => new Response(JSON.stringify({
          status: "ok",
          stats: { connected: true, certsProcessed: 0, certsMatched: 0, errors: 0 },
        }))),
      }),
    },
    NEXUS_RUN: {},
  } as unknown as Env;
}

describe("orchestrator tick — feed ingestion precedes the bounded inline geo pass", () => {
  beforeAll(async () => {
    const mod = await import("../src/cron/orchestrator");
    expect(typeof mod.handleScheduled).toBe("function");
  }, 120_000);

  beforeEach(() => {
    callOrder.length = 0;
    executeAgentCalls.length = 0;
    feedsTotalNew = 0;
    geoImpl = async () => ({});
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes runAllFeeds before enrichThreatsGeo (and NEXUS dispatch before both)", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    await handleScheduled(eventAtHour(4), makeEnv(), ctx);

    const feeds = callOrder.indexOf("runAllFeeds");
    const geo = callOrder.indexOf("enrichThreatsGeo");
    expect(feeds).toBeGreaterThanOrEqual(0);
    expect(geo).toBeGreaterThan(feeds);
    expect(callOrder.indexOf("dispatchWorkflow")).toBeLessThan(feeds);
    expect(runAllFeedsSpy).toHaveBeenCalledTimes(1);
    expect(enrichThreatsGeoSpy).toHaveBeenCalledTimes(1);
  });

  it("caps the enrichment loop at scheduledTime + ENRICHMENT_TICK_DEADLINE_MS", async () => {
    const { ENRICHMENT_TICK_DEADLINE_MS } = await import("../src/lib/feedRunner");
    const event = eventAtHour(4);
    vi.useFakeTimers();
    try {
      // A live tick, 2 min into the invocation.
      vi.setSystemTime(event.scheduledTime + 2 * 60_000);
      const { handleScheduled } = await import("../src/cron/orchestrator");
      await handleScheduled(event, makeEnv(), ctx);
    } finally {
      vi.useRealTimers();
    }
    const call = runAllEnrichmentFeedsSpy.mock.calls.at(-1)!;
    expect(call[2]).toEqual({ deadline: event.scheduledTime + ENRICHMENT_TICK_DEADLINE_MS });
  });

  it("caps the social feed loop at the same tick deadline, after enrichment", async () => {
    const { ENRICHMENT_TICK_DEADLINE_MS } = await import("../src/lib/feedRunner");
    const event = eventAtHour(5);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(event.scheduledTime + 2 * 60_000);
      const { handleScheduled } = await import("../src/cron/orchestrator");
      await handleScheduled(event, makeEnv(), ctx);
    } finally {
      vi.useRealTimers();
    }
    const call = runAllSocialFeedsSpy.mock.calls.at(-1)!;
    expect(call[2]).toEqual({ deadline: event.scheduledTime + ENRICHMENT_TICK_DEADLINE_MS });
    expect(callOrder.indexOf("runAllSocialFeeds")).toBeGreaterThan(callOrder.indexOf("runAllEnrichmentFeeds"));
  });

  it("logs feedsTimedOut / feedsDeferred for the ingest, enrichment and social loops", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    await handleScheduled(eventAtHour(5), makeEnv(), ctx);
    expect(infoSpy).toHaveBeenCalledWith("threat_feed_scan_feeds", expect.objectContaining({
      feedsRun: 1, feedsFailed: 2, feedsSkipped: 3, feedsTimedOut: 1, feedsDeferred: 2,
    }));
    expect(infoSpy).toHaveBeenCalledWith("threat_feed_scan_enrichment_feeds", expect.objectContaining({
      feedsRun: 2, feedsFailed: 1, feedsTimedOut: 1, feedsDeferred: 1,
    }));
    expect(infoSpy).toHaveBeenCalledWith("threat_feed_scan_social_feeds", expect.objectContaining({
      feedsRun: 1, feedsFailed: 1, feedsTimedOut: 1, feedsDeferred: 2,
    }));
  });

  it("still gates sentinel on runAllFeeds' totalNew", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");

    feedsTotalNew = 3;
    await handleScheduled(eventAtHour(9), makeEnv(), ctx);
    expect(executeAgentCalls).toContain("sentinel");
    expect(callOrder).toContain("agent_events_insert");
    expect(callOrder.indexOf("agent:sentinel")).toBeGreaterThan(callOrder.indexOf("runAllFeeds"));

    callOrder.length = 0;
    executeAgentCalls.length = 0;
    feedsTotalNew = 0;
    await handleScheduled(eventAtHour(9), makeEnv(), ctx);
    expect(executeAgentCalls).not.toContain("sentinel");
  });

  it("a never-resolving enrichThreatsGeo holds the rest of the tick for at most INLINE_GEO_ENRICH_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const { handleScheduled, INLINE_GEO_ENRICH_TIMEOUT_MS } = await import("../src/cron/orchestrator");
    expect(INLINE_GEO_ENRICH_TIMEOUT_MS).toBe(10_000);

    geoImpl = () => new Promise(() => {}); // D1 saturated: never settles

    let done = false;
    const tick = handleScheduled(eventAtHour(9), makeEnv(), ctx).then(() => { done = true; });

    // Just short of the cap: feeds already ran, geo is pending, analyst
    // (which runs after geo) has not.
    await vi.advanceTimersByTimeAsync(INLINE_GEO_ENRICH_TIMEOUT_MS - 1);
    expect(runAllFeedsSpy).toHaveBeenCalledTimes(1);
    expect(enrichThreatsGeoSpy).toHaveBeenCalledTimes(1);
    expect(executeAgentCalls).not.toContain("analyst");
    expect(done).toBe(false);

    // Cross the cap: the rest of runThreatFeedScan proceeds.
    await vi.advanceTimersByTimeAsync(1);
    await tick;
    expect(done).toBe(true);
    expect(executeAgentCalls).toContain("analyst");
    expect(callOrder).toContain("runAllEnrichmentFeeds");
    expect(warnSpy).toHaveBeenCalledWith(
      "threat_feed_scan_geo_timeout",
      expect.objectContaining({ timeout_ms: INLINE_GEO_ENRICH_TIMEOUT_MS }),
    );
  });
});

describe("runInlineGeoEnrichment", () => {
  beforeEach(() => {
    geoImpl = async () => ({});
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves promptly and clears its timer when geo finishes first", async () => {
    vi.useFakeTimers();
    const { runInlineGeoEnrichment } = await import("../src/cron/orchestrator");
    await runInlineGeoEnrichment(makeEnv(), 10_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs (never throws) when geo rejects before the timeout", async () => {
    const { runInlineGeoEnrichment } = await import("../src/cron/orchestrator");
    geoImpl = async () => { throw new Error("D1 DB is overloaded"); };
    await expect(runInlineGeoEnrichment(makeEnv(), 10_000)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith("threat_feed_scan_geo_error", { error: "D1 DB is overloaded" });
  });

  it("a rejection landing after the timeout is caught and logged, not an unhandled rejection", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { runInlineGeoEnrichment } = await import("../src/cron/orchestrator");
      let rejectGeo: (e: Error) => void = () => {};
      geoImpl = () => new Promise((_resolve, reject) => { rejectGeo = reject; });

      const run = runInlineGeoEnrichment(makeEnv(), 10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(run).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith("threat_feed_scan_geo_timeout", expect.anything());

      rejectGeo(new Error("late D1 failure"));
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 10));

      expect(unhandled).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        "threat_feed_scan_geo_late_error",
        expect.objectContaining({ error: "late D1 failure" }),
      );
      expect(errorSpy).not.toHaveBeenCalledWith("threat_feed_scan_geo_error", expect.anything());
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
