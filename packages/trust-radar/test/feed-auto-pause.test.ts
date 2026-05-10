/**
 * Phase 4 Step 3 — feed auto-pause regression tests.
 *
 * Covers the counter + threshold contract from feedRunner.runFeed():
 *   1. Successful run resets consecutive_failures to 0 (even when
 *      the feed legitimately returned zero records).
 *   2. Failed run increments consecutive_failures by 1 and does NOT
 *      auto-pause while still below the threshold.
 *   3. Hitting the threshold flips enabled=0 and writes
 *      paused_reason='auto:consecutive_failures'.
 *   4. Hitting the threshold fires exactly ONE critical notification
 *      and one agent_activity_log row — concurrent threshold hits on
 *      the same feed don't duplicate it.
 *   5. Per-feed override in feed_configs.consecutive_failure_threshold
 *      wins over the global default from system_config.
 *
 * These tests drive runFeed() through a hand-rolled mock D1 that
 * records every prepare(...).bind(...).run()/first() call so we can
 * assert on the exact SQL shape that lands.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runFeed, resolveFailureThreshold, resetGlobalThresholdCache } from "../src/lib/feedRunner";
import type { FeedConfigRow } from "../src/lib/feedRunner";
import type { FeedModule, FeedResult } from "../src/feeds/types";

// ─── Mock notifications module ───────────────────────────────────

const createNotificationMock = vi.fn().mockResolvedValue(1);
vi.mock("../src/lib/notifications", () => ({
  createNotification: (...args: unknown[]) => createNotificationMock(...args),
}));

// ─── Mock D1 ─────────────────────────────────────────────────────

interface StmtCall {
  sql: string;
  bindArgs: unknown[];
  op: "run" | "first" | "all";
}

interface MockState {
  feed_configs: Record<string, { enabled: number; paused_reason: string | null; consecutive_failure_threshold: number | null }>;
  feed_status: Record<string, { health_status: string; consecutive_failures: number }>;
  system_config: Record<string, string>;
}

function makeMockDb(state: MockState) {
  const calls: StmtCall[] = [];

  const prepare = (sql: string) => {
    const bind = (...bindArgs: unknown[]) => {
      const runOp = async () => {
        calls.push({ sql, bindArgs, op: "run" });
        applySideEffect(state, sql, bindArgs);
        return { success: true };
      };
      const firstOp = async () => {
        calls.push({ sql, bindArgs, op: "first" });
        return readFirst(state, sql, bindArgs);
      };
      const allOp = async () => {
        calls.push({ sql, bindArgs, op: "all" });
        return { results: [] };
      };
      return { run: runOp, first: firstOp, all: allOp };
    };
    const firstNoBind = async () => {
      calls.push({ sql, bindArgs: [], op: "first" });
      return readFirst(state, sql, []);
    };
    return { bind, first: firstNoBind, run: async () => ({ success: true }), all: async () => ({ results: [] }) };
  };

  return { db: { prepare } as unknown as D1Database, calls };
}

function applySideEffect(state: MockState, sql: string, args: unknown[]): void {
  // Rough SQL pattern matching — enough for the runFeed() flow.
  if (/^UPDATE feed_configs\s+SET enabled = 0/i.test(sql)) {
    // The auto-pause UPDATE binds (paused_reason, feed_name) — the
    // pause reason is now a parameter (auth-failure routing) rather
    // than a literal string in the SQL, so read it from args[0].
    const feedName = String(args[args.length - 1]);
    const pausedReason = String(args[0]);
    if (state.feed_configs[feedName]) {
      state.feed_configs[feedName]!.enabled = 0;
      state.feed_configs[feedName]!.paused_reason = pausedReason;
    }
  }
  if (/UPDATE feed_status SET\s+last_failure/i.test(sql)) {
    const feedName = String(args[args.length - 1]);
    const newCount = typeof args[1] === "number" ? (args[1] as number) : 0;
    state.feed_status[feedName] = {
      health_status: "degraded",
      consecutive_failures: newCount,
    };
  }
  if (/UPDATE feed_status SET\s+last_successful_pull/i.test(sql)) {
    const feedName = String(args[args.length - 1]);
    state.feed_status[feedName] = {
      health_status: "healthy",
      consecutive_failures: 0,
    };
  }
}

function readFirst(state: MockState, sql: string, args: unknown[]): unknown {
  if (/SELECT value FROM system_config/i.test(sql)) {
    return { value: state.system_config["feed_consecutive_failure_threshold"] ?? "5" };
  }
  if (/SELECT health_status, consecutive_failures FROM feed_status/i.test(sql)) {
    const feedName = String(args[0]);
    const row = state.feed_status[feedName];
    return row ? { health_status: row.health_status, consecutive_failures: row.consecutive_failures } : null;
  }
  if (/SELECT enabled, paused_reason FROM feed_configs/i.test(sql)) {
    const feedName = String(args[0]);
    const row = state.feed_configs[feedName];
    return row ? { enabled: row.enabled, paused_reason: row.paused_reason } : null;
  }
  return null;
}

// ─── Fixtures ────────────────────────────────────────────────────

function makeConfig(overrides: Partial<FeedConfigRow> = {}): FeedConfigRow {
  return {
    feed_name: "test_feed",
    display_name: "Test Feed",
    source_url: null,
    schedule_cron: "*/5 * * * *",
    rate_limit: 60,
    batch_size: 100,
    retry_count: 3,
    enabled: 1,
    consecutive_failure_threshold: null,
    ...overrides,
  };
}

function makeSuccessFeedModule(result: Partial<FeedResult> = {}): FeedModule {
  return {
    ingest: async () => ({
      itemsFetched: 0,
      itemsNew: 0,
      itemsDuplicate: 0,
      itemsError: 0,
      ...result,
    }),
  };
}

function makeFailingFeedModule(msg = "boom"): FeedModule {
  return {
    ingest: async () => {
      throw new Error(msg);
    },
  };
}

function makeEnv(db: D1Database) {
  return { DB: db, CACHE: { get: async () => null, put: async () => undefined } } as unknown as Parameters<typeof runFeed>[0];
}

// ─── Tests ───────────────────────────────────────────────────────

describe("resolveFailureThreshold", () => {
  it("uses the global default when no per-feed override is set", () => {
    expect(resolveFailureThreshold({ consecutive_failure_threshold: null }, 5)).toBe(5);
    expect(resolveFailureThreshold({ consecutive_failure_threshold: undefined }, 5)).toBe(5);
  });

  it("uses the per-feed override when set to a positive value", () => {
    expect(resolveFailureThreshold({ consecutive_failure_threshold: 3 }, 5)).toBe(3);
    expect(resolveFailureThreshold({ consecutive_failure_threshold: 10 }, 5)).toBe(10);
  });

  it("falls back to the global default when override is non-positive", () => {
    expect(resolveFailureThreshold({ consecutive_failure_threshold: 0 }, 5)).toBe(5);
    expect(resolveFailureThreshold({ consecutive_failure_threshold: -1 }, 5)).toBe(5);
  });
});

describe("runFeed auto-pause", () => {
  beforeEach(() => {
    createNotificationMock.mockClear();
    resetGlobalThresholdCache();
  });

  it("resets consecutive_failures to 0 on successful run (even with zero ingested records)", async () => {
    const state: MockState = {
      feed_configs: { test_feed: { enabled: 1, paused_reason: null, consecutive_failure_threshold: null } },
      feed_status: { test_feed: { health_status: "degraded", consecutive_failures: 3 } },
      system_config: { feed_consecutive_failure_threshold: "5" },
    };
    const { db, calls } = makeMockDb(state);
    const config = makeConfig();
    const mod = makeSuccessFeedModule({ itemsFetched: 0, itemsNew: 0 });

    await runFeed(makeEnv(db), config, mod);

    expect(state.feed_status["test_feed"]!.consecutive_failures).toBe(0);
    // Verify the UPDATE sets consecutive_failures = 0 in SQL
    const updateCall = calls.find((c) => /UPDATE feed_status SET[\s\S]*last_successful_pull/i.test(c.sql));
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toMatch(/consecutive_failures\s*=\s*0/i);
  });

  it("increments consecutive_failures and does NOT auto-pause below threshold", async () => {
    const state: MockState = {
      feed_configs: { test_feed: { enabled: 1, paused_reason: null, consecutive_failure_threshold: null } },
      feed_status: { test_feed: { health_status: "healthy", consecutive_failures: 2 } },
      system_config: { feed_consecutive_failure_threshold: "5" },
    };
    const { db } = makeMockDb(state);
    const config = makeConfig();
    const mod = makeFailingFeedModule("network timeout");

    await expect(runFeed(makeEnv(db), config, mod)).rejects.toThrow(/failed/);

    expect(state.feed_status["test_feed"]!.consecutive_failures).toBe(3);
    expect(state.feed_configs["test_feed"]!.enabled).toBe(1);
    expect(state.feed_configs["test_feed"]!.paused_reason).toBeNull();
  });

  it("hitting the threshold flips enabled=0 and sets paused_reason='auto:consecutive_failures'", async () => {
    const state: MockState = {
      feed_configs: { test_feed: { enabled: 1, paused_reason: null, consecutive_failure_threshold: null } },
      feed_status: { test_feed: { health_status: "degraded", consecutive_failures: 4 } },
      system_config: { feed_consecutive_failure_threshold: "5" },
    };
    const { db, calls } = makeMockDb(state);
    const config = makeConfig();
    const mod = makeFailingFeedModule("http 503");

    await expect(runFeed(makeEnv(db), config, mod)).rejects.toThrow();

    expect(state.feed_status["test_feed"]!.consecutive_failures).toBe(5);
    expect(state.feed_configs["test_feed"]!.enabled).toBe(0);
    expect(state.feed_configs["test_feed"]!.paused_reason).toBe("auto:consecutive_failures");

    // The UPDATE feed_configs statement should have fired with the
    // pause reason bound as the first parameter. The SQL itself uses
    // a placeholder so auth-failure pauses can route to a distinct
    // reason without a second statement.
    const pauseCall = calls.find((c) => /UPDATE feed_configs\s+SET enabled = 0/i.test(c.sql));
    expect(pauseCall).toBeDefined();
    expect(pauseCall!.sql).toMatch(/paused_reason\s*=\s*\?/i);
    expect(pauseCall!.bindArgs[0]).toBe("auto:consecutive_failures");
  });

  it("HTTP 403/401 auth failures route to paused_reason='auto:auth_failure'", async () => {
    const state: MockState = {
      feed_configs: { test_feed: { enabled: 1, paused_reason: null, consecutive_failure_threshold: null } },
      feed_status: { test_feed: { health_status: "degraded", consecutive_failures: 4 } },
      system_config: { feed_consecutive_failure_threshold: "5" },
    };
    const { db, calls } = makeMockDb(state);
    const config = makeConfig();
    // Mirrors the OTX failure mode that motivated this routing:
    // five consecutive HTTP 403 responses should take the feed to
    // auth_failure (sticky — won't be auto-recovered) instead of
    // consecutive_failures (eligible for the 4-hour recovery sweep).
    const mod = makeFailingFeedModule("OTX HTTP 403");

    await expect(runFeed(makeEnv(db), config, mod)).rejects.toThrow();

    expect(state.feed_configs["test_feed"]!.enabled).toBe(0);
    expect(state.feed_configs["test_feed"]!.paused_reason).toBe("auto:auth_failure");

    const pauseCall = calls.find((c) => /UPDATE feed_configs\s+SET enabled = 0/i.test(c.sql));
    expect(pauseCall).toBeDefined();
    expect(pauseCall!.bindArgs[0]).toBe("auto:auth_failure");
  });

  it("fires exactly one critical notification on the auto-pause transition", async () => {
    const state: MockState = {
      feed_configs: { test_feed: { enabled: 1, paused_reason: null, consecutive_failure_threshold: null } },
      feed_status: { test_feed: { health_status: "degraded", consecutive_failures: 4 } },
      system_config: { feed_consecutive_failure_threshold: "5" },
    };
    const { db } = makeMockDb(state);
    const config = makeConfig();
    const mod = makeFailingFeedModule("http 503");

    await expect(runFeed(makeEnv(db), config, mod)).rejects.toThrow();

    // Exactly one critical notification — not a degraded-transition one,
    // because the feed was already degraded (prev health_status != healthy).
    const criticalCalls = createNotificationMock.mock.calls.filter(
      (c) => (c[1] as { severity: string }).severity === "critical"
    );
    expect(criticalCalls).toHaveLength(1);
    const notif = criticalCalls[0]![1] as {
      type: string;
      severity: string;
      title: string;
      message: string;
      metadata: Record<string, unknown>;
    };
    expect(notif.type).toBe("feed_health");
    expect(notif.severity).toBe("critical");
    expect(notif.title).toContain("auto-paused");
    expect(notif.message).toContain("5");
    expect(notif.message).toContain("http 503");
    expect(notif.metadata.auto_paused).toBe(true);
    expect(notif.metadata.consecutive_failures).toBe(5);
    expect(notif.metadata.threshold).toBe(5);
  });

  it("does not re-fire the notification if the feed is already auto-paused", async () => {
    const state: MockState = {
      // Already paused — simulates a concurrent run that beat us to the punch
      feed_configs: { test_feed: { enabled: 0, paused_reason: "auto:consecutive_failures", consecutive_failure_threshold: null } },
      feed_status: { test_feed: { health_status: "degraded", consecutive_failures: 5 } },
      system_config: { feed_consecutive_failure_threshold: "5" },
    };
    const { db } = makeMockDb(state);
    // Config is what the runFeed() call was given — the initial dispatch read
    // saw enabled=1 and only the check-then-update inside autoPauseFeed sees
    // the current state.
    const config = makeConfig();
    const mod = makeFailingFeedModule("http 503");

    await expect(runFeed(makeEnv(db), config, mod)).rejects.toThrow();

    const criticalCalls = createNotificationMock.mock.calls.filter(
      (c) => (c[1] as { severity: string }).severity === "critical"
    );
    expect(criticalCalls).toHaveLength(0);
  });

  it("respects a per-feed threshold override from feed_configs", async () => {
    const state: MockState = {
      feed_configs: { test_feed: { enabled: 1, paused_reason: null, consecutive_failure_threshold: 2 } },
      feed_status: { test_feed: { health_status: "degraded", consecutive_failures: 1 } },
      // Global is 10, but override is 2 — two failures should be enough
      system_config: { feed_consecutive_failure_threshold: "10" },
    };
    const { db } = makeMockDb(state);
    const config = makeConfig({ consecutive_failure_threshold: 2 });
    const mod = makeFailingFeedModule("http 500");

    await expect(runFeed(makeEnv(db), config, mod)).rejects.toThrow();

    expect(state.feed_status["test_feed"]!.consecutive_failures).toBe(2);
    expect(state.feed_configs["test_feed"]!.enabled).toBe(0);
    expect(state.feed_configs["test_feed"]!.paused_reason).toBe("auto:consecutive_failures");
  });
});
