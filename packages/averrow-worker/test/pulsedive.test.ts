/**
 * Tests for the Pulsedive risk-scoring enrichment module (migration 0250).
 * Covers key-gating, the daily budget, and the risk → calibration branches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pulsedive, checkPulsedive } from "../src/feeds/pulsedive";
import type { Env } from "../src/types";

interface Update { sql: string; args: unknown[] }

function makeEnv(
  threats: Array<{ id: string; indicator: string }>,
  riskByIndicator: Record<string, string>, // value, or "ERROR" for {error:...}
  opts?: { key?: string | undefined; dailyCount?: number; monthlyCount?: number },
): { env: Env; updates: Update[]; fetchCount: () => number } {
  const updates: Update[] = [];
  const kv = new Map<string, string>();
  if (opts?.dailyCount != null) kv.set(`pulsedive_daily_${new Date().toISOString().slice(0, 10)}`, String(opts.dailyCount));
  if (opts?.monthlyCount != null) kv.set(`pulsedive_monthly_${new Date().toISOString().slice(0, 7)}`, String(opts.monthlyCount));
  let fetches = 0;

  globalThis.fetch = vi.fn(async (url: string) => {
    fetches++;
    const m = url.match(/indicator=([^&]+)/);
    const ind = m ? decodeURIComponent(m[1]!) : "";
    const risk = riskByIndicator[ind];
    if (risk === "HTTP429") return { ok: false, status: 429, async json() { return {}; } } as unknown as Response;
    const body =
      risk === "ERROR" ? { error: "Indicator not found." } :        // valid "no data"
      risk === "ERROR_OTHER" ? { error: "Invalid API key." } :      // hard failure
      { risk };
    return { ok: true, status: 200, async json() { return body; } } as unknown as Response;
  }) as unknown as typeof fetch;

  const env = {
    PULSEDIVE_API_KEY: opts && "key" in opts ? opts.key : "test-key",
    CACHE: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => { kv.set(k, v); },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              // Respect the SELECT's LIMIT ? bind so the daily-budget clamp is testable.
              async all() { const lim = typeof args[0] === "number" ? args[0] : threats.length; return { results: threats.slice(0, lim) }; },
              async run() { if (/UPDATE\s+threats/i.test(sql)) updates.push({ sql, args }); return { meta: { changes: 1 } }; },
              async first() { return null; },
            };
          },
        };
      },
    },
  } as unknown as Env;

  return { env, updates, fetchCount: () => fetches };
}

const CTX = { feedName: "pulsedive", feedUrl: "https://pulsedive.com/api/info.php" };

beforeEach(() => {
  // Make the inter-call sleep() instant so the batch loop doesn't wait.
  vi.stubGlobal("setTimeout", ((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
});
afterEach(() => vi.unstubAllGlobals());

describe("pulsedive enrichment", () => {
  it("no-ops when PULSEDIVE_API_KEY is unset", async () => {
    const { env, fetchCount } = makeEnv([{ id: "t1", indicator: "evil.com" }], { "evil.com": "high" }, { key: undefined });
    const r = await pulsedive.ingest({ env, ...CTX });
    expect(r).toEqual({ itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
    expect(fetchCount()).toBe(0);
  });

  it("no-ops when the daily budget (15) is already spent", async () => {
    const { env, fetchCount } = makeEnv([{ id: "t1", indicator: "evil.com" }], { "evil.com": "high" }, { dailyCount: 15 });
    const r = await pulsedive.ingest({ env, ...CTX });
    expect(r.itemsFetched).toBe(0);
    expect(fetchCount()).toBe(0);
  });

  it("no-ops when the monthly budget (480) is already spent, even with day headroom", async () => {
    const { env, fetchCount } = makeEnv([{ id: "t1", indicator: "evil.com" }], { "evil.com": "high" }, { dailyCount: 0, monthlyCount: 480 });
    const r = await pulsedive.ingest({ env, ...CTX });
    expect(r.itemsFetched).toBe(0);
    expect(fetchCount()).toBe(0);
  });

  it("calibrates confidence/severity by risk level and records the check", async () => {
    const threats = [
      { id: "crit", indicator: "bad.com" },
      { id: "none", indicator: "good.com" },
      { id: "low", indicator: "meh.com" },
      { id: "unk", indicator: "who.com" },
    ];
    const risks = { "bad.com": "critical", "good.com": "none", "meh.com": "low", "who.com": "unknown" };
    const { env, updates } = makeEnv(threats, risks);

    const r = await pulsedive.ingest({ env, ...CTX });

    // critical + none + low each produce an actionable update (itemsNew);
    // unknown is "checked, no change" (itemsDuplicate).
    expect(r.itemsFetched).toBe(4);
    expect(r.itemsNew).toBe(3);
    expect(r.itemsDuplicate).toBe(1);
    expect(r.itemsError).toBe(0);
    expect(updates).toHaveLength(4); // every threat gets pulsedive_checked = 1

    const byId = (id: string) => updates.find((u) => u.args[u.args.length - 1] === id)!;
    expect(byId("crit").sql).toMatch(/confidence_score = MIN\(100/);
    expect(byId("none").sql).toMatch(/likely_false_positive/);
    expect(byId("low").sql).toMatch(/severity = CASE severity WHEN 'critical' THEN 'high'/);
    expect(byId("none").sql).toMatch(/severity = 'low'/);
    expect(byId("unk").sql).toMatch(/pulsedive_checked = 1, pulsedive_risk = \?/);
  });

  it("throws (trips the circuit breaker) when every lookup fails, and stamps nothing checked", async () => {
    const { env, updates } = makeEnv([{ id: "t1", indicator: "a.com" }], { "a.com": "ERROR_OTHER" });
    await expect(pulsedive.ingest({ env, ...CTX })).rejects.toThrow(/lookups failed/);
    expect(updates).toEqual([]); // a hard error must not mark the threat checked
  });

  it("does NOT mark checked on a non-'not found' error (retryable) but keeps processing others", async () => {
    const { env, updates } = makeEnv(
      [{ id: "ok", indicator: "ok.com" }, { id: "bad", indicator: "bad.com" }],
      { "ok.com": "high", "bad.com": "ERROR_OTHER" },
    );
    const r = await pulsedive.ingest({ env, ...CTX });
    expect(r.itemsNew).toBe(1);
    expect(r.itemsError).toBe(1);
    // only the good indicator got a pulsedive_checked stamp; the errored one is left for retry
    expect(updates.map((u) => u.args[u.args.length - 1])).toEqual(["ok"]);
  });

  it("returns null (itemsError) on a 429 without stamping checked", async () => {
    const { env, updates } = makeEnv([{ id: "t1", indicator: "a.com" }], { "a.com": "HTTP429" });
    await expect(pulsedive.ingest({ env, ...CTX })).rejects.toThrow(/lookups failed/); // all failed → throw
    expect(updates).toEqual([]);
  });

  it("clamps the batch to the remaining daily budget", async () => {
    const threats = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, indicator: `d${i}.com` }));
    const risks = Object.fromEntries(threats.map((t) => [t.indicator, "unknown"]));
    const { env } = makeEnv(threats, risks, { dailyCount: 14 }); // 15 - 14 = 1 remaining
    const r = await pulsedive.ingest({ env, ...CTX });
    expect(r.itemsFetched).toBe(1);
  });

  it("clamps the batch to the remaining monthly budget when it is the tighter ceiling", async () => {
    const threats = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, indicator: `d${i}.com` }));
    const risks = Object.fromEntries(threats.map((t) => [t.indicator, "unknown"]));
    const { env } = makeEnv(threats, risks, { dailyCount: 0, monthlyCount: 479 }); // 480 - 479 = 1 remaining
    const r = await pulsedive.ingest({ env, ...CTX });
    expect(r.itemsFetched).toBe(1);
  });

  it("treats an {error} response (unknown to Pulsedive) as risk=unknown, not a failure", async () => {
    const { env, updates } = makeEnv([{ id: "t1", indicator: "ghost.com" }], { "ghost.com": "ERROR" });
    const r = await pulsedive.ingest({ env, ...CTX });
    expect(r.itemsError).toBe(0);
    expect(r.itemsDuplicate).toBe(1); // checked, no actionable change
    expect(updates[0]!.args).toContain("unknown");
  });

  it("checkPulsedive caches by indicator (one fetch per value)", async () => {
    const { env, fetchCount } = makeEnv([], { "x.com": "medium" });
    const a = await checkPulsedive("x.com", env);
    const b = await checkPulsedive("x.com", env);
    expect(a).toBe("medium");
    expect(b).toBe("medium");
    expect(fetchCount()).toBe(1); // second call served from KV
  });
});
