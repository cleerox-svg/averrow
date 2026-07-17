/**
 * Regression tests for handlers/feeds.ts handleFeedsAggregateStats +
 * the cache-busting sites that keep it fresh.
 *
 * Two-part fix under test:
 *   1. total_ingested now reads feed_status.records_ingested_today
 *      (bounded to ~44 feed rows) instead of an unbounded
 *      SUM(records_ingested) over feed_pull_history (44.6K rows and
 *      growing forever — a full-table SCAN on every call).
 *   2. The endpoint is now KV-cached under 'feeds_aggregate_stats:v1'
 *      (TTL 300s), busted alongside 'feeds_overview:v1' at every feed
 *      mutation site (pause/unpause/trigger).
 *
 * D1 is faked the same hand-rolled way as search.test.ts /
 * agent-circuit-breaker.test.ts (no live-D1 harness in this repo). KV
 * uses the MockKV class from cached-value.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { handleFeedsAggregateStats, handlePauseFeed, handleUnpauseFeed } from "../src/handlers/feeds";
import type { Env } from "../src/types";

// ─── Fakes ─────────────────────────────────────────────────────────

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

interface Captured {
  sql: string;
  binds: unknown[];
  op: "first" | "run";
}

function makeDb(opts: { statsRow?: Record<string, unknown>; feedExists?: boolean } = {}) {
  const calls: Captured[] = [];
  const statsRow = opts.statsRow ?? { active: 3, disabled: 1, total_ingested: 500 };
  const feedExists = opts.feedExists ?? true;

  const respond = (sql: string, binds: unknown[], op: "first" | "run") => {
    calls.push({ sql, binds, op });
    if (/SELECT\s+feed_name\s+FROM\s+feed_configs\s+WHERE\s+feed_name\s*=\s*\?/i.test(sql)) {
      return feedExists ? { feed_name: binds[0] } : null;
    }
    if (/COUNT\(CASE WHEN enabled=1/i.test(sql)) {
      return statsRow;
    }
    if (/UPDATE feed_configs/i.test(sql)) return { success: true };
    if (/UPDATE feed_status/i.test(sql)) return { success: true };
    return null;
  };

  const prepare = (sql: string) => ({
    first: async (...binds: unknown[]) => respond(sql, binds, "first"),
    bind: (...binds: unknown[]) => ({
      first: async () => respond(sql, binds, "first"),
      run: async () => respond(sql, binds, "run"),
    }),
    run: async () => respond(sql, [], "run"),
  });

  const batch = async (stmts: Array<{ run: () => Promise<unknown> }>) => {
    for (const s of stmts) await s.run();
    return [];
  };

  return { db: { prepare, batch } as unknown as D1Database, calls };
}

function makeEnv(dbOpts: Parameters<typeof makeDb>[0] = {}) {
  const { db, calls } = makeDb(dbOpts);
  const kv = new MockKV();
  const env = { DB: db, CACHE: kv } as unknown as Env;
  return { env, calls, kv };
}

function statsReq(): Request {
  return new Request("https://averrow.com/api/feeds/stats");
}

function mutateReq(): Request {
  return new Request("https://averrow.com/api/feeds/x/pause", { method: "POST" });
}

async function bodyOf(res: Response) {
  return res.json() as Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("handleFeedsAggregateStats — query shape", () => {
  it("sums feed_status.records_ingested_today, never feed_pull_history", async () => {
    const { env, calls } = makeEnv();
    await handleFeedsAggregateStats(statsReq(), env);

    const statsCall = calls.find((c) => /COUNT\(CASE WHEN enabled=1/i.test(c.sql));
    expect(statsCall).toBeDefined();
    expect(statsCall!.sql).toMatch(/SUM\(records_ingested_today\)\s+FROM\s+feed_status/i);
    expect(statsCall!.sql).not.toMatch(/feed_pull_history/i);
  });

  it("returns the {active, disabled, total_ingested} shape unchanged", async () => {
    const { env } = makeEnv({ statsRow: { active: 7, disabled: 2, total_ingested: 12345 } });
    const res = await handleFeedsAggregateStats(statsReq(), env);
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toEqual({ success: true, data: { active: 7, disabled: 2, total_ingested: 12345 } });
  });
});

describe("handleFeedsAggregateStats — KV caching", () => {
  it("computes and caches on a cold call, storing under 'feeds_aggregate_stats:v1'", async () => {
    const { env, kv } = makeEnv({ statsRow: { active: 1, disabled: 0, total_ingested: 99 } });
    await handleFeedsAggregateStats(statsReq(), env);

    const cached = kv.store.get("feeds_aggregate_stats:v1");
    expect(cached).toBeDefined();
    expect(JSON.parse(cached!)).toEqual({ success: true, data: { active: 1, disabled: 0, total_ingested: 99 } });
  });

  it("serves a warm cache without touching D1 — second call within TTL is a pure KV hit", async () => {
    const { env, calls } = makeEnv({ statsRow: { active: 5, disabled: 5, total_ingested: 1000 } });

    const first = await handleFeedsAggregateStats(statsReq(), env);
    expect((await bodyOf(first)).data).toEqual({ active: 5, disabled: 5, total_ingested: 1000 });
    expect(calls.length).toBeGreaterThan(0); // cold call did hit D1

    calls.length = 0; // reset the D1 call log
    const second = await handleFeedsAggregateStats(statsReq(), env);
    expect(calls.length).toBe(0); // warm cache — no D1 round-trip at all
    expect(await bodyOf(second)).toEqual({ success: true, data: { active: 5, disabled: 5, total_ingested: 1000 } });
  });

  it("a pre-seeded cache entry is returned verbatim without recomputing", async () => {
    const { env, calls } = makeEnv();
    env.CACHE.put(
      "feeds_aggregate_stats:v1",
      JSON.stringify({ success: true, data: { active: 42, disabled: 0, total_ingested: 0 } }),
    );
    const res = await handleFeedsAggregateStats(statsReq(), env);
    expect(calls.length).toBe(0);
    expect(await bodyOf(res)).toEqual({ success: true, data: { active: 42, disabled: 0, total_ingested: 0 } });
  });
});

describe("feed mutations bust feeds_aggregate_stats:v1", () => {
  let env: Env;
  let kv: MockKV;

  beforeEach(() => {
    const made = makeEnv({ feedExists: true });
    env = made.env;
    kv = made.kv;
    // Pre-seed both cache keys as if a prior stats/overview call warmed them.
    kv.store.set("feeds_overview:v1", JSON.stringify({ stale: true }));
    kv.store.set("feeds_aggregate_stats:v1", JSON.stringify({ stale: true }));
  });

  it("handlePauseFeed busts both feeds_overview:v1 and feeds_aggregate_stats:v1", async () => {
    const res = await handlePauseFeed(mutateReq(), env, "some_feed");
    expect(res.status).toBe(200);
    expect(kv.store.has("feeds_overview:v1")).toBe(false);
    expect(kv.store.has("feeds_aggregate_stats:v1")).toBe(false);
  });

  it("handleUnpauseFeed busts both feeds_overview:v1 and feeds_aggregate_stats:v1", async () => {
    const res = await handleUnpauseFeed(mutateReq(), env, "some_feed");
    expect(res.status).toBe(200);
    expect(kv.store.has("feeds_overview:v1")).toBe(false);
    expect(kv.store.has("feeds_aggregate_stats:v1")).toBe(false);
  });

  it("a 404 (feed not found) does NOT bust the caches — no mutation happened", async () => {
    const made = makeEnv({ feedExists: false });
    made.kv.store.set("feeds_aggregate_stats:v1", JSON.stringify({ stale: true }));
    const res = await handlePauseFeed(mutateReq(), made.env, "ghost_feed");
    expect(res.status).toBe(404);
    expect(made.kv.store.has("feeds_aggregate_stats:v1")).toBe(true);
  });
});
