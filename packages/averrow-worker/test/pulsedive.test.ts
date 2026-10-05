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
  opts?: {
    key?: string | undefined;
    dailyCount?: number;
    monthlyCount?: number;
    /** Pre-seeded KV risk cache entries, keyed by indicator. */
    cached?: Record<string, string>;
  },
): { env: Env; updates: Update[]; fetchCount: () => number; dailyCount: () => number; monthlyCount: () => number } {
  const updates: Update[] = [];
  const kv = new Map<string, string>();
  const dailyKey = `pulsedive_daily_${new Date().toISOString().slice(0, 10)}`;
  const monthlyKey = `pulsedive_monthly_${new Date().toISOString().slice(0, 7)}`;
  if (opts?.dailyCount != null) kv.set(dailyKey, String(opts.dailyCount));
  if (opts?.monthlyCount != null) kv.set(monthlyKey, String(opts.monthlyCount));
  for (const [ind, risk] of Object.entries(opts?.cached ?? {})) kv.set(`pulsedive:${ind}`, risk);
  let fetches = 0;

  // Minimal Response stand-in. The module reads the body as TEXT and parses
  // it itself (so a non-JSON 200 — e.g. a Cloudflare HTML interstitial —
  // can be reported with a snippet), so the mock must expose text() and
  // headers.get() the way a real Response does.
  const makeRes = (init: { ok: boolean; status: number; body: unknown; contentType?: string }): Response => {
    const text = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    return {
      ok: init.ok,
      status: init.status,
      statusText: "",
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? init.contentType ?? "application/json" : null) },
      async text() { return text; },
      async json() { return JSON.parse(text) as unknown; },
    } as unknown as Response;
  };

  globalThis.fetch = vi.fn(async (url: string) => {
    fetches++;
    const m = url.match(/indicator=([^&]+)/);
    const ind = m ? decodeURIComponent(m[1]!) : "";
    const risk = riskByIndicator[ind];
    if (risk === "HTTP429") return makeRes({ ok: false, status: 429, body: {} });
    // Pulsedive's real "unknown indicator" answer: HTTP 404 + JSON {error}.
    if (risk === "HTTP404_NOT_FOUND") return makeRes({ ok: false, status: 404, body: { error: "Indicator not found." } });
    if (risk === "HTTP404_HTML") {
      return makeRes({ ok: false, status: 404, body: "<html><body><h1>404 Not Found</h1></body></html>", contentType: "text/html" });
    }
    if (risk === "HTTP404_OTHER") return makeRes({ ok: false, status: 404, body: { error: "Something else broke." } });
    if (risk === "HTTP404_KEY") return makeRes({ ok: false, status: 404, body: { error: "API key not found." } });
    if (risk === "HTTP404_ENDPOINT") return makeRes({ ok: false, status: 404, body: { error: "Endpoint not found" } });
    if (risk === "HTTP404_EMPTY") return makeRes({ ok: false, status: 404, body: "", contentType: "text/plain" });
    if (risk === "HTML") {
      // HTTP 200 carrying an HTML error/interstitial page.
      return makeRes({ ok: true, status: 200, body: "<!DOCTYPE html><html><body>Just a moment...</body></html>", contentType: "text/html" });
    }
    const body =
      risk === "ERROR" ? { error: "Indicator not found." } :        // valid "no data"
      risk === "ERROR_OTHER" ? { error: "Invalid API key." } :      // hard failure
      risk === "ERROR_KEY_NOT_FOUND" ? { error: "API key not found." } : // must NOT read as "indicator not found"
      { risk };
    return makeRes({ ok: true, status: 200, body });
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

  return {
    env,
    updates,
    fetchCount: () => fetches,
    dailyCount: () => parseInt(kv.get(dailyKey) ?? "0", 10),
    monthlyCount: () => parseInt(kv.get(monthlyKey) ?? "0", 10),
  };
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

  // ── Regression: 2026-09-11 "upstream=7/8, check API status" outage ──

  it("names the HTTP-200-but-not-JSON body in the thrown error (Cloudflare-interstitial case)", async () => {
    const { env } = makeEnv([{ id: "t1", indicator: "a.com" }], { "a.com": "HTML" });
    // The bare taxonomy line ("upstream errors ... check API status") is not
    // diagnosable on its own — the detail must reach pull-history.
    await expect(pulsedive.ingest({ env, ...CTX })).rejects.toThrow(/first upstream detail/);
    await expect(
      pulsedive.ingest({ env, ...CTX }),
    ).rejects.toThrow(/non-JSON body \(content-type=text\/html\)/);
  });

  it("aborts after 3 consecutive upstream failures instead of spending the whole batch", async () => {
    const threats = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, indicator: `d${i}.com` }));
    // HTML = HTTP 200 with a non-JSON body → classified `upstream`
    // (an `auth` failure aborts on the first hit, by design).
    const risks = Object.fromEntries(threats.map((t) => [t.indicator, "HTML"]));
    const { env, fetchCount, dailyCount } = makeEnv(threats, risks);

    await expect(pulsedive.ingest({ env, ...CTX })).rejects.toThrow(/all 3 lookups failed/);
    // Only the streak's worth of quota is spent, not the whole 8-item batch.
    expect(fetchCount()).toBe(3);
    expect(dailyCount()).toBe(3);
  });

  // ── Regression: 2026-09-11+ "upstream=3 … HTTP 404 Not Found" every run ──
  // Pulsedive answers an unknown indicator with HTTP 404 + {"error":"Indicator not found."}.

  it("treats HTTP 404 + 'Indicator not found.' JSON as risk=unknown: cached, stamped checked, metered, run succeeds", async () => {
    const threats = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, indicator: `fresh${i}.com` }));
    const risks = Object.fromEntries(threats.map((t) => [t.indicator, "HTTP404_NOT_FOUND"]));
    const { env, updates, fetchCount, dailyCount, monthlyCount } = makeEnv(threats, risks);

    const r = await pulsedive.ingest({ env, ...CTX }); // must NOT throw
    expect(monthlyCount()).toBe(3); // monthly ceiling metered too, same as 200 not-found
    expect(r).toEqual({ itemsFetched: 3, itemsNew: 0, itemsDuplicate: 3, itemsError: 0 });
    // every threat stamped checked with risk 'unknown' (same SQL as the 200 not-found path)
    expect(updates).toHaveLength(3);
    for (const u of updates) {
      expect(u.sql).toMatch(/pulsedive_checked = 1, pulsedive_risk = \?/);
      expect(u.args[0]).toBe("unknown");
    }
    // quota spent once per HTTP request, exactly like the 200 not-found path
    expect(fetchCount()).toBe(3);
    expect(dailyCount()).toBe(3);
    // cached "unknown" in KV → a repeat lookup makes no HTTP call
    expect(await env.CACHE.get("pulsedive:fresh0.com")).toBe("unknown");
    expect(await checkPulsedive("fresh0.com", env)).toBe("unknown");
    expect(fetchCount()).toBe(3);
  });

  it("treats HTTP 404 with an HTML body as an upstream failure (uncached, unstamped)", async () => {
    const { env, updates } = makeEnv([{ id: "t1", indicator: "a.com" }], { "a.com": "HTTP404_HTML" });
    await expect(pulsedive.ingest({ env, ...CTX })).rejects.toThrow(/upstream=1 .*first upstream detail: HTTP 404/);
    expect(updates).toEqual([]);
    expect(await env.CACHE.get("pulsedive:a.com")).toBeNull();
  });

  it("treats HTTP 404 with a different JSON {error} as an upstream failure", async () => {
    const { env, updates } = makeEnv([{ id: "t1", indicator: "a.com" }], { "a.com": "HTTP404_OTHER" });
    await expect(pulsedive.ingest({ env, ...CTX })).rejects.toThrow(/upstream=1 .*first upstream detail: HTTP 404/);
    expect(updates).toEqual([]);
    expect(await env.CACHE.get("pulsedive:a.com")).toBeNull();
  });

  it("treats HTTP 404 + {error:'API key not found.'} as an AUTH failure, not risk=unknown", async () => {
    const threats = [{ id: "t1", indicator: "a.com" }, { id: "t2", indicator: "b.com" }];
    const { env, updates, fetchCount } = makeEnv(threats, { "a.com": "HTTP404_KEY", "b.com": "HTTP404_KEY" });
    await expect(pulsedive.ingest({ env, ...CTX })).rejects.toThrow(/rotate PULSEDIVE_API_KEY \(auth=1 .*first auth detail: API key not found\./);
    expect(fetchCount()).toBe(1); // auth aborts on first hit
    expect(updates).toEqual([]);
    expect(await env.CACHE.get("pulsedive:a.com")).toBeNull();
  });

  it("treats HTTP 404 + {error:'Endpoint not found'} as an upstream failure, not risk=unknown", async () => {
    const { env, updates } = makeEnv([{ id: "t1", indicator: "a.com" }], { "a.com": "HTTP404_ENDPOINT" });
    await expect(pulsedive.ingest({ env, ...CTX })).rejects.toThrow(/upstream=1 .*first upstream detail: HTTP 404/);
    expect(updates).toEqual([]);
    expect(await env.CACHE.get("pulsedive:a.com")).toBeNull();
  });

  it("treats an empty HTTP 404 body as an upstream failure", async () => {
    const { env, updates } = makeEnv([{ id: "t1", indicator: "a.com" }], { "a.com": "HTTP404_EMPTY" });
    await expect(pulsedive.ingest({ env, ...CTX })).rejects.toThrow(/upstream=1 .*first upstream detail: HTTP 404/);
    expect(updates).toEqual([]);
  });

  it("treats HTTP 200 + {error:'API key not found.'} as AUTH (anchored not-found match on the 200 path too)", async () => {
    const { env, updates } = makeEnv([{ id: "t1", indicator: "a.com" }], { "a.com": "ERROR_KEY_NOT_FOUND" });
    await expect(pulsedive.ingest({ env, ...CTX })).rejects.toThrow(/auth=1/);
    expect(updates).toEqual([]);
    expect(await env.CACHE.get("pulsedive:a.com")).toBeNull();
  });

  it("a 404 not-found between upstream failures resets the abort streak", async () => {
    // Without the reset, the 4th lookup would be the 3rd consecutive failure
    // and abort the run at 4 fetches.
    const order = ["HTML", "HTML", "HTTP404_NOT_FOUND", "HTML", "HTML", "high"];
    const threats = order.map((_, i) => ({ id: `t${i}`, indicator: `m${i}.com` }));
    const risks = Object.fromEntries(threats.map((t, i) => [t.indicator, order[i]!]));
    const { env, updates, fetchCount } = makeEnv(threats, risks);

    const r = await pulsedive.ingest({ env, ...CTX }); // not all failed → no throw
    expect(fetchCount()).toBe(6);
    expect(r).toEqual({ itemsFetched: 6, itemsNew: 1, itemsDuplicate: 1, itemsError: 4 });
    expect(updates.map((u) => u.args[u.args.length - 1])).toEqual(["t2", "t5"]);
  });

  it("does not charge the daily quota for KV cache hits", async () => {
    const { env, fetchCount, dailyCount } = makeEnv(
      [{ id: "t1", indicator: "known.com" }],
      {},
      { cached: { "known.com": "critical" } },
    );
    const r = await pulsedive.ingest({ env, ...CTX });
    expect(r.itemsNew).toBe(1);
    expect(fetchCount()).toBe(0);   // served from KV — no HTTP call
    expect(dailyCount()).toBe(0);   // ...so no provider quota consumed
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
