/**
 * Cartographer run budget + bounded Phase 2 campaign counts (2026-11-10).
 *
 * Prod 2026-11-08..10: 23 of 44 cartographer runs orphaned ('partial',
 * completed_at NULL; reaped at 180 min or force-failed by FC) and each run
 * read ~670K rows, ~607K of them in Phase 2's per-run
 * `COUNT(DISTINCT campaign_id) … WHERE hosting_provider_id IN (top 50)`.
 *
 * Pins:
 *   1. Pure helpers: budget clock, RDAP attempts cap (not just successes),
 *      campaign-count fetch planning (row budget, first miss always taken),
 *      KV value parsing.
 *   2. loadProviderCampaignCounts: KV hits never touch D1; misses within the
 *      budget are fetched in ONE statement and cached 24h; over-budget misses
 *      are absent (deferred); a provider with no campaign rows caches 0.
 *   3. execute() with the budget already spent: every later phase is
 *      skipped, the run still returns (summary output written) and carries
 *      `degraded` → executeAgent records 'partial' WITH completed_at.
 *   4. Phase 2 scores only providers whose campaign count is known.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Env } from "../src/types";
import type { AgentContext } from "../src/lib/agentRunner";
import {
  cartographerAgent,
  cartographerBudgetSpent,
  rdapLookupAllowed,
  planCampaignCountFetch,
  parseCampaignCount,
  loadProviderCampaignCounts,
  CARTOGRAPHER_RUN_BUDGET_MS,
  RDAP_MAX_ATTEMPTS_PER_RUN,
  RDAP_MAX_SUCCESSES_PER_RUN,
  PROVIDER_CAMPAIGN_COUNT_KV_PREFIX,
  PROVIDER_CAMPAIGN_COUNT_TTL_S,
} from "../src/agents/cartographer";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── 1. Pure helpers ──────────────────────────────────────────────

describe("cartographer budget helpers", () => {
  it("budget is spent at exactly the budget and after", () => {
    expect(cartographerBudgetSpent(0, CARTOGRAPHER_RUN_BUDGET_MS - 1)).toBe(false);
    expect(cartographerBudgetSpent(0, CARTOGRAPHER_RUN_BUDGET_MS)).toBe(true);
    // Well inside the cron invocation's 15-min wall limit.
    expect(CARTOGRAPHER_RUN_BUDGET_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  it("RDAP is capped on attempts, not only on successes", () => {
    expect(rdapLookupAllowed(0, 0)).toBe(true);
    // All lookups failing: the old success-only cap never stopped this.
    expect(rdapLookupAllowed(RDAP_MAX_ATTEMPTS_PER_RUN, 0)).toBe(false);
    expect(rdapLookupAllowed(5, RDAP_MAX_SUCCESSES_PER_RUN)).toBe(false);
  });

  it("planCampaignCountFetch fills the row budget in order and defers the rest", () => {
    const plan = planCampaignCountFetch(
      [
        { id: "a", estimatedRows: 60 },
        { id: "b", estimatedRows: 30 },
        { id: "c", estimatedRows: 20 },
        { id: "d", estimatedRows: 5 },
      ],
      100,
    );
    expect(plan).toEqual({ fetch: ["a", "b", "d"], deferred: ["c"] });
  });

  it("the first miss is always fetched even when it alone exceeds the budget", () => {
    expect(planCampaignCountFetch([{ id: "huge", estimatedRows: 1_000_000 }, { id: "s", estimatedRows: 1 }], 100))
      .toEqual({ fetch: ["huge"], deferred: ["s"] });
  });

  it("parseCampaignCount: integers ≥ 0 only", () => {
    expect(parseCampaignCount(null)).toBeNull();
    expect(parseCampaignCount("x")).toBeNull();
    expect(parseCampaignCount("-1")).toBeNull();
    expect(parseCampaignCount("1.5")).toBeNull();
    expect(parseCampaignCount("0")).toBe(0);
    expect(parseCampaignCount("12")).toBe(12);
  });
});

// ─── 2. loadProviderCampaignCounts ────────────────────────────────

function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const puts: Array<{ key: string; value: string; ttl?: number }> = [];
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      store.set(k, v);
      puts.push({ key: k, value: v, ttl: opts?.expirationTtl });
    },
  } as unknown as KVNamespace;
  return { kv, store, puts };
}

function campaignDb(counts: Record<string, number>) {
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => {
          queries.push({ sql, args });
          return {
            results: args
              .map((id) => String(id))
              .filter((id) => id in counts)
              .map((id) => ({ hosting_provider_id: id, campaign_count: counts[id] })),
          };
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, queries };
}

describe("loadProviderCampaignCounts", () => {
  it("serves KV hits without D1, fetches in-budget misses once, defers the rest", async () => {
    const { kv, puts } = fakeKv({ [`${PROVIDER_CAMPAIGN_COUNT_KV_PREFIX}hit`]: "4" });
    const { db, queries } = campaignDb({ m1: 7 });
    const env = { DB: db, CACHE: kv } as unknown as Env;

    const counts = await loadProviderCampaignCounts(env, [
      { id: "hit", total_threat_count: 999_999 },
      { id: "m1", total_threat_count: 80 },
      { id: "m2", total_threat_count: 15 }, // no campaign rows → 0
      { id: "m3", total_threat_count: 50 }, // over budget → deferred
    ], 100);

    expect([...counts.entries()]).toEqual([["hit", 4], ["m1", 7], ["m2", 0]]);
    expect(counts.has("m3")).toBe(false);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.args).toEqual(["m1", "m2"]);
    expect(queries[0]!.sql).toMatch(/COUNT\(DISTINCT campaign_id\)/);
    expect(puts.map((p) => [p.key, p.value, p.ttl])).toEqual([
      [`${PROVIDER_CAMPAIGN_COUNT_KV_PREFIX}m1`, "7", PROVIDER_CAMPAIGN_COUNT_TTL_S],
      [`${PROVIDER_CAMPAIGN_COUNT_KV_PREFIX}m2`, "0", PROVIDER_CAMPAIGN_COUNT_TTL_S],
    ]);
  });

  it("all cached → zero D1 reads", async () => {
    const { kv } = fakeKv({
      [`${PROVIDER_CAMPAIGN_COUNT_KV_PREFIX}a`]: "1",
      [`${PROVIDER_CAMPAIGN_COUNT_KV_PREFIX}b`]: "2",
    });
    const { db, queries } = campaignDb({});
    const counts = await loadProviderCampaignCounts({ DB: db, CACHE: kv } as unknown as Env, [
      { id: "a", total_threat_count: 10 },
      { id: "b", total_threat_count: 10 },
    ]);
    expect(counts.size).toBe(2);
    expect(queries).toHaveLength(0);
  });

  it("a KV read error is a miss, not a crash", async () => {
    const kv = {
      get: async () => { throw new Error("kv down"); },
      put: async () => { throw new Error("kv down"); },
    } as unknown as KVNamespace;
    const { db } = campaignDb({ a: 3 });
    const counts = await loadProviderCampaignCounts({ DB: db, CACHE: kv } as unknown as Env, [
      { id: "a", total_threat_count: 10 },
    ]);
    expect(counts.get("a")).toBe(3);
  });
});

// ─── 3/4. execute() under the run budget ──────────────────────────

interface ProviderRow {
  id: string; name: string; asn: string | null;
  active_threat_count: number; total_threat_count: number;
  avg_response_time: number | null; trend_7d: number | null; trend_30d: number | null;
  last_score: number | null;
}

function executeDb(providers: ProviderRow[] = []) {
  const sqls: string[] = [];
  const scoreUpdates: unknown[][] = [];
  const stmt = (sql: string, args: unknown[] = []): Record<string, unknown> => ({
    bind: (...next: unknown[]) => stmt(sql, next),
    run: async () => {
      if (/UPDATE hosting_providers SET reputation_score/.test(sql)) scoreUpdates.push(args);
      return { meta: {}, success: true };
    },
    first: async () => (/SELECT COUNT\(\*\) AS providers/i.test(sql) ? { providers: 0, with_provider: 0 } : null),
    all: async () => {
      if (/FROM hosting_providers hp\s+WHERE hp\.total_threat_count > 0/.test(sql)) return { results: providers };
      if (/COUNT\(DISTINCT campaign_id\)/.test(sql)) {
        return { results: args.map((id) => ({ hosting_provider_id: String(id), campaign_count: 1 })) };
      }
      return { results: [] };
    },
  });
  const db = {
    prepare: (sql: string) => { sqls.push(sql); return stmt(sql); },
    batch: async (s: unknown[]) => s.map(() => ({ meta: {}, success: true })),
  } as unknown as D1Database;
  return { db, sqls, scoreUpdates };
}

function ctxFor(env: Env): AgentContext {
  return { env, runId: "run-budget", agentName: "cartographer", input: {}, triggeredBy: "flight_control" };
}

describe("cartographer execute() run budget", () => {
  it("budget spent at the first check: later phases skipped, run returns degraded with a summary", async () => {
    let calls = 0;
    // First Date.now() = run start; every later read is past the budget.
    vi.spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? 1_000_000 : 1_000_000 + CARTOGRAPHER_RUN_BUDGET_MS + 1));
    const { db, sqls } = executeDb();
    const { kv } = fakeKv();
    const result = await cartographerAgent.execute(ctxFor({ DB: db, CACHE: kv } as unknown as Env));

    expect(result.degraded?.reason).toMatch(/wall-clock budget \(8 min\) spent — skipped: /);
    for (const p of ["phase0 batches 1-3", "phase0.5 mmdb", "phase1 ipinfo", "phase2 provider scoring", "phase3 email security", "phase4 dmarc geo", "phase5 provider stats"]) {
      expect(result.degraded?.reason).toContain(p);
    }
    // No phase query ran.
    expect(sqls.some((s) => /enriched_at IS NULL/.test(s))).toBe(false);
    expect(sqls.some((s) => /email_security_scanned_at IS NULL/.test(s))).toBe(false);
    expect(sqls.some((s) => /dmarc_report_records/.test(s))).toBe(false);
    // The run still reports what it did.
    const summary = result.agentOutputs?.find((o) => String(o.summary).startsWith("Cartographer:"));
    expect(summary?.details).toMatchObject({ run_budget_ms: CARTOGRAPHER_RUN_BUDGET_MS });
    expect((summary?.details as { budget_skipped: string[] }).budget_skipped.length).toBeGreaterThan(0);
  });

  it("within budget: no degraded flag; Phase 2 scores only providers with a known campaign count", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000_000);
    const prov = (id: string, total: number): ProviderRow => ({
      id, name: id, asn: null, active_threat_count: total, total_threat_count: total,
      avg_response_time: null, trend_7d: null, trend_30d: null, last_score: null,
    });
    // Second provider pushes the miss budget (150K) over → deferred.
    const { db, scoreUpdates } = executeDb([prov("big", 140_000), prov("next", 20_000), prov("small", 5_000)]);
    const { kv } = fakeKv({ [`${PROVIDER_CAMPAIGN_COUNT_KV_PREFIX}small`]: "2" });

    const result = await cartographerAgent.execute(ctxFor({ DB: db, CACHE: kv } as unknown as Env));

    expect(result.degraded).toBeUndefined();
    const scoredIds = scoreUpdates.map((args) => args[args.length - 1]);
    expect(scoredIds.sort()).toEqual(["big", "small"]);
    const summary = result.agentOutputs?.find((o) => String(o.summary).startsWith("Cartographer:"));
    expect(summary?.details).toMatchObject({ heuristic_scored: 2, providers_deferred_campaign_budget: 1 });
  });
});
