/**
 * Tier-4 metrics-tabs backend changes.
 *
 * Covers the three backend contract changes the metrics-tabs frontend
 * consumes:
 *   1. handleMetricsFeedFailures now stamps a `severity` field on each
 *      per_feed row (via the shared computeFeedSeverity helper).
 *   2. handleMetricsAiSpend now returns the superset that absorbed the
 *      retired ai-cost-optimization endpoint: per-agent breakdown across
 *      all three windows with an out:in ratio, plus a cartographer-only
 *      daily series — while keeping its legacy fields intact.
 *   3. fetchComprehensiveBriefing bounds the honeypot pageBreakdown to
 *      the top 20 pages and surfaces the true distinct-page count as
 *      pageBreakdownTotal.
 */

import { describe, it, expect } from "vitest";
import { handleMetricsFeedFailures, handleMetricsAiSpend } from "../src/handlers/admin";
import { fetchComprehensiveBriefing } from "../src/handlers/briefing";
import type { Env } from "../src/types";

// ─── Test doubles ────────────────────────────────────────────────

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

interface Route {
  match: (sql: string) => boolean;
  first?: unknown;
  all?: unknown[];
}

/** SQL-routing D1 stub. `.first()` / `.all()` resolve from the first
 *  matching route; unmatched reads return undefined / empty so handlers
 *  that fan out extra queries degrade gracefully. Captures every prepared
 *  SQL string for assertions. */
function makeRoutingDb(routes: Route[]): { db: Env["DB"]; sql: string[] } {
  const sql: string[] = [];
  const db = {
    prepare(query: string) {
      sql.push(query);
      return {
        bind() {
          return this;
        },
        async first() {
          for (const r of routes) if (r.match(query) && r.first !== undefined) return r.first;
          return undefined;
        },
        async all() {
          for (const r of routes) if (r.match(query) && r.all !== undefined) return { results: r.all };
          return { results: [] };
        },
      };
    },
  } as unknown as Env["DB"];
  return { db, sql };
}

function req(path: string): Request {
  return new Request(`https://averrow.com${path}`, {
    headers: { Origin: "https://averrow.com" },
  });
}

// ─── 1. Feed-failures severity field ─────────────────────────────

describe("handleMetricsFeedFailures — stamps severity on each per_feed row", () => {
  it("maps each feed to critical / high / null via the shared helper", async () => {
    const kv = new MockKV();
    const { db } = makeRoutingDb([
      {
        match: (s) => s.includes("feed_pull_history") && s.includes("GROUP BY feed_name"),
        all: [
          { feed_name: "greynoise", pulls: 20, success: 2, failed: 18, partial: 0, records: 0, last_success_at: null, last_failure_at: "x" },
          { feed_name: "healthy",   pulls: 40, success: 40, failed: 0, partial: 0, records: 5000, last_success_at: "x", last_failure_at: null },
        ],
      },
      {
        match: (s) => s.includes("FROM feed_status"),
        all: [
          { feed_name: "greynoise", consecutive_failures: 4, health_status: "degraded", last_error: "boom" },
          { feed_name: "deadfeed",  consecutive_failures: 5, health_status: "failed",   last_error: "dead" },
        ],
      },
      {
        match: (s) => s.includes("FROM feed_configs"),
        all: [
          { feed_name: "greynoise", display_name: "GreyNoise", enabled: 1, paused_reason: null, threshold: 5 },
          { feed_name: "deadfeed",  display_name: "Dead",      enabled: 0, paused_reason: "auto:consecutive_failures", threshold: 5 },
          { feed_name: "manual",    display_name: "Manual",    enabled: 0, paused_reason: "operator: seasonal", threshold: 5 },
          { feed_name: "healthy",   display_name: "Healthy",   enabled: 1, paused_reason: null, threshold: 5 },
        ],
      },
      {
        match: (s) => s.includes("feed_pull_history") && s.includes("ORDER BY started_at DESC"),
        all: [],
      },
    ]);
    const env = { DB: db, CACHE: kv } as unknown as Env;

    const res = await handleMetricsFeedFailures(req("/api/admin/metrics/feed-failures"), env);
    const body = (await res.json()) as {
      success: boolean;
      data: { per_feed: Array<{ feed_name: string; severity: "critical" | "high" | null }> };
    };
    expect(body.success).toBe(true);

    const sev = new Map(body.data.per_feed.map((f) => [f.feed_name, f.severity]));
    // greynoise: enabled, consec 4/5 = 80% → critical
    expect(sev.get("greynoise")).toBe("critical");
    // deadfeed: auto:consecutive_failures (enabled=0) → critical
    expect(sev.get("deadfeed")).toBe("critical");
    // manual: operator pause → excluded from signal (null)
    expect(sev.get("manual")).toBeNull();
    // healthy: no failures → null
    expect(sev.get("healthy")).toBeNull();

    // Field is present on EVERY row.
    for (const f of body.data.per_feed) {
      expect(f).toHaveProperty("severity");
    }
  });
});

// ─── 2. Extended ai-spend shape ──────────────────────────────────

describe("handleMetricsAiSpend — merged superset shape", () => {
  it("returns windows, legacy by_agent_30d, per-window by_agent with out_in_ratio, and cartographer_daily_30d", async () => {
    const kv = new MockKV();
    const { db } = makeRoutingDb([
      // Windowed totals (single conditional-aggregation scan — no GROUP BY).
      {
        match: (s) => s.includes("calls_24h") && !s.includes("GROUP BY agent_id"),
        first: {
          calls_24h: 10, input_24h: 1000, output_24h: 200, cost_24h: 0.5,
          calls_7d: 70,  input_7d: 7000,  output_7d: 1400, cost_7d: 3.5,
          calls_30d: 300, input_30d: 30000, output_30d: 6000, cost_30d: 15,
        },
      },
      // Per-agent conditional GROUP BY scan.
      {
        match: (s) => s.includes("GROUP BY agent_id"),
        all: [
          { agent_id: "cartographer", calls_24h: 5, input_24h: 800, output_24h: 160, cost_24h: 0.4, calls_7d: 35, input_7d: 5600, output_7d: 1120, cost_7d: 2.8, calls_30d: 200, input_30d: 24000, output_30d: 4800, cost_30d: 12 },
          { agent_id: "analyst",      calls_24h: 5, input_24h: 200, output_24h: 40,  cost_24h: 0.1, calls_7d: 35, input_7d: 1400, output_7d: 280,  cost_7d: 0.7, calls_30d: 100, input_30d: 6000,  output_30d: 1200, cost_30d: 3 },
          { agent_id: "zero",         calls_24h: 0, input_24h: 0,   output_24h: 0,   cost_24h: 0,   calls_7d: 0,  input_7d: 0,    output_7d: 0,    cost_7d: 0,   calls_30d: 1,   input_30d: 0,     output_30d: 5,    cost_30d: 0 },
        ],
      },
      // Cartographer-only daily series (checked before the all-agent one).
      {
        match: (s) => s.includes("GROUP BY day") && s.includes("agent_id = 'cartographer'"),
        all: [{ day: "2026-07-01", calls: 5, input_tokens: 800, output_tokens: 160, cost_usd: 0.4 }],
      },
      // All-agent daily series.
      {
        match: (s) => s.includes("GROUP BY day") && !s.includes("agent_id = 'cartographer'"),
        all: [{ day: "2026-07-01", calls: 10, input_tokens: 1000, output_tokens: 200, cost_usd: 0.5 }],
      },
    ]);
    const env = { DB: db, CACHE: kv } as unknown as Env;

    const res = await handleMetricsAiSpend(req("/api/admin/metrics/ai-spend"), env);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        windows: Record<"24h" | "7d" | "30d", { calls: number; input_tokens: number; output_tokens: number; cost_usd: number }>;
        by_agent_30d: Array<{ agent_id: string; calls: number; cost_usd: number }>;
        by_agent: Record<"24h" | "7d" | "30d", Array<{ agent_id: string; cost_usd: number; out_in_ratio: number }>>;
        daily_30d: Array<{ day: string }>;
        cartographer_daily_30d: Array<{ day: string; cost_usd: number }>;
      };
    };
    expect(body.success).toBe(true);

    // Legacy windows shape unchanged.
    expect(body.data.windows["24h"]).toEqual({ calls: 10, input_tokens: 1000, output_tokens: 200, cost_usd: 0.5 });
    expect(body.data.windows["30d"].cost_usd).toBe(15);

    // Legacy by_agent_30d preserved (30d rows, cost-sorted, no ratio).
    expect(body.data.by_agent_30d[0].agent_id).toBe("cartographer");
    expect(body.data.by_agent_30d[0].calls).toBe(200);

    // New per-window per-agent breakdown with out:in ratio.
    const a24 = body.data.by_agent["24h"];
    expect(a24[0].agent_id).toBe("cartographer"); // cost-sorted per window
    const cart24 = a24.find((r) => r.agent_id === "cartographer")!;
    expect(cart24.out_in_ratio).toBeCloseTo(0.2, 4); // 160/800

    const a7 = body.data.by_agent["7d"];
    expect(a7.find((r) => r.agent_id === "cartographer")!.out_in_ratio).toBeCloseTo(0.2, 4); // 1120/5600

    // Divide-by-zero guard: input 0 → ratio 0 (not NaN/Infinity).
    const zero24 = a24.find((r) => r.agent_id === "zero")!;
    expect(zero24.out_in_ratio).toBe(0);

    // Cartographer daily series present and distinct from all-agent daily.
    expect(body.data.cartographer_daily_30d).toHaveLength(1);
    expect(body.data.cartographer_daily_30d[0].cost_usd).toBe(0.4);
    expect(body.data.daily_30d).toHaveLength(1);
  });
});

// ─── 3. Honeypot pageBreakdown bound ─────────────────────────────

describe("fetchComprehensiveBriefing — honeypot pageBreakdown is bounded", () => {
  it("caps pageBreakdown query with LIMIT 20 and surfaces pageBreakdownTotal", async () => {
    const { db, sql } = makeRoutingDb([
      // Honeypot page breakdown (top pages).
      {
        match: (s) => s.includes("FROM honeypot_visits GROUP BY page"),
        all: [
          { page: "/wp-admin", visits: 500, bots: 480 },
          { page: "/.env", visits: 300, bots: 290 },
        ],
      },
      // Distinct-page scalar.
      {
        match: (s) => s.includes("COUNT(DISTINCT page)"),
        first: { distinct_pages: 137 },
      },
    ]);
    const env = { DB: db } as unknown as Env;

    const briefing = await fetchComprehensiveBriefing(env);

    // The GROUP BY page query must carry LIMIT 20.
    const pageQuery = sql.find((s) => s.includes("FROM honeypot_visits GROUP BY page"));
    expect(pageQuery).toBeDefined();
    expect(pageQuery!).toContain("LIMIT 20");

    // The true distinct-page count is surfaced separately.
    expect(briefing.honeypot.pageBreakdownTotal).toBe(137);
    // The breakdown itself carries the mocked rows.
    expect(briefing.honeypot.pageBreakdown).toHaveLength(2);
    expect(briefing.honeypot.pageBreakdown[0].page).toBe("/wp-admin");
  });
});
