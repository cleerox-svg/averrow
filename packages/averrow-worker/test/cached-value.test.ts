import { describe, it, expect, beforeEach, vi } from "vitest";
import { cachedValue, SINGLE_FLIGHT_MAX_WAIT_MS } from "../src/lib/cached-value";
import type { Env } from "../src/types";

// Mirrors the MockKV from cached-count.test.ts. Kept inline so each
// test file is self-contained — the helpers are small and the
// duplication is cheaper than coupling tests via shared fixtures.
class MockKV {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  ttls = new Map<string, number | undefined>();

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
    this.ttls.set(key, opts?.expirationTtl);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function makeEnv(kv: MockKV): Env {
  return { CACHE: kv } as unknown as Env;
}

describe("cachedValue", () => {
  let kv: MockKV;
  let env: Env;

  beforeEach(() => {
    kv = new MockKV();
    env = makeEnv(kv);
  });

  it("computes on cold cache and writes the value", async () => {
    const compute = vi.fn().mockResolvedValue({ items: [1, 2, 3], total: 3 });
    const v = await cachedValue(env, "test.cold", 60, compute);
    expect(v).toEqual({ items: [1, 2, 3], total: 3 });
    expect(compute).toHaveBeenCalledOnce();
    const stored = kv.store.get("cv:test.cold");
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed.v).toEqual({ items: [1, 2, 3], total: 3 });
  });

  it("refresh (Navigator warm): recomputes once the entry is refreshAfterSeconds(ttl) old; live reads keep the full ttl", async () => {
    // 3600s TTL → refresh threshold 3600 − 1800 − 60 = 1740s.
    const seedAged = (ageS: number) =>
      kv.store.set("cv:test.refresh", JSON.stringify({ v: "old", t: Date.now() - ageS * 1000 }));
    const compute = vi.fn().mockResolvedValue("new");

    seedAged(1700);
    expect(await cachedValue(env, "test.refresh", 3600, compute, { refresh: true })).toBe("old");
    seedAged(1800);
    expect(await cachedValue(env, "test.refresh", 3600, compute)).toBe("old"); // live: still fresh
    expect(await cachedValue(env, "test.refresh", 3600, compute, { refresh: true })).toBe("new");
    expect(compute).toHaveBeenCalledOnce();
  });

  describe("staleWhileRevalidate", () => {
    const seedAged = (value: string, ageS: number) =>
      kv.store.set("cv:test.swr", JSON.stringify({ v: value, t: Date.now() - ageS * 1000 }));
    const swrOpts = (pending: Promise<unknown>[] | null) => ({
      staleWhileRevalidate: {
        freshSeconds: 75,
        waitUntil: pending ? (p: Promise<unknown>) => { pending.push(p); } : undefined,
      },
    });

    it("an entry younger than freshSeconds is a hit", async () => {
      seedAged("old", 70);
      const compute = vi.fn().mockResolvedValue("new");
      expect(await cachedValue(env, "test.swr", 1200, compute, swrOpts([]))).toBe("old");
      expect(compute).not.toHaveBeenCalled();
    });

    it("stale (> fresh, < ttl): served at once; the lock holder refills in the background, then drops the lock", async () => {
      seedAged("old", 600);
      const pending: Promise<unknown>[] = [];
      const compute = vi.fn().mockResolvedValue("new");
      expect(await cachedValue(env, "test.swr", 1200, compute, swrOpts(pending))).toBe("old");
      expect(kv.store.has("cvlock:test.swr")).toBe(true);
      expect(pending).toHaveLength(1);
      await Promise.all(pending);
      expect(compute).toHaveBeenCalledOnce();
      expect(JSON.parse(kv.store.get("cv:test.swr")!).v).toBe("new");
      expect(kv.store.has("cvlock:test.swr")).toBe(false);
    });

    it("only the lock holder refills: concurrent stale readers schedule no second compute", async () => {
      seedAged("old", 600);
      kv.store.set("cvlock:test.swr", "held");
      const pending: Promise<unknown>[] = [];
      const compute = vi.fn().mockResolvedValue("new");
      expect(await cachedValue(env, "test.swr", 1200, compute, swrOpts(pending))).toBe("old");
      expect(pending).toHaveLength(0);
      expect(compute).not.toHaveBeenCalled();
    });

    it("a failing background refill is swallowed; the stale entry stays", async () => {
      seedAged("old", 600);
      const pending: Promise<unknown>[] = [];
      const compute = vi.fn().mockRejectedValue(new Error("D1 overloaded"));
      expect(await cachedValue(env, "test.swr", 1200, compute, swrOpts(pending))).toBe("old");
      await Promise.all(pending);
      expect(JSON.parse(kv.store.get("cv:test.swr")!).v).toBe("old");
      expect(kv.store.has("cvlock:test.swr")).toBe(false);
    });

    it("no waitUntil → a stale entry is recomputed inline (plain freshSeconds TTL)", async () => {
      seedAged("old", 80);
      expect(await cachedValue(env, "test.swr", 1200, vi.fn().mockResolvedValue("new"), swrOpts(null))).toBe("new");
    });

    it("older than ttlSeconds → not servable, recomputed inline even with waitUntil", async () => {
      seedAged("old", 1300);
      const pending: Promise<unknown>[] = [];
      expect(await cachedValue(env, "test.swr", 1200, vi.fn().mockResolvedValue("new"), swrOpts(pending))).toBe("new");
      expect(pending).toHaveLength(0);
    });

    it("a refresh (warm) call ignores freshSeconds and uses refreshAfterSeconds(ttl)", async () => {
      seedAged("old", 300); // > 75s fresh, < 540s refresh threshold for 1200s
      const compute = vi.fn().mockResolvedValue("new");
      expect(await cachedValue(env, "test.swr", 1200, compute, { ...swrOpts([]), refresh: true })).toBe("old");
      seedAged("old", 600);
      expect(await cachedValue(env, "test.swr", 1200, compute, { ...swrOpts([]), refresh: true })).toBe("new");
    });
  });

  it("returns cached value on warm cache without computing", async () => {
    const compute = vi.fn().mockResolvedValue([{ a: 1 }, { a: 2 }]);
    await cachedValue(env, "test.warm", 60, compute);
    const v2 = await cachedValue(env, "test.warm", 60, compute);
    expect(v2).toEqual([{ a: 1 }, { a: 2 }]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes when cached entry is stale", async () => {
    const compute = vi.fn().mockResolvedValue({ x: 1 });
    await cachedValue(env, "test.stale", 60, compute);
    const raw = kv.store.get("cv:test.stale")!;
    const parsed = JSON.parse(raw);
    parsed.t = Date.now() - 120_000;
    kv.store.set("cv:test.stale", JSON.stringify(parsed));
    await cachedValue(env, "test.stale", 60, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("bypasses cache entirely when ttlSeconds is 0", async () => {
    const compute = vi.fn().mockResolvedValue("hello");
    await cachedValue(env, "test.bypass", 0, compute);
    await cachedValue(env, "test.bypass", 0, compute);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(kv.store.has("cv:test.bypass")).toBe(false);
  });

  it("falls through to compute when KV.get throws", async () => {
    const throwingKv = {
      get: vi.fn().mockRejectedValue(new Error("kv outage")),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const throwingEnv = { CACHE: throwingKv } as unknown as Env;
    const compute = vi.fn().mockResolvedValue([1, 2, 3]);
    const v = await cachedValue(throwingEnv, "test.kvget.throws", 60, compute);
    expect(v).toEqual([1, 2, 3]);
    expect(compute).toHaveBeenCalledOnce();
  });

  it("returns the computed value when KV.put throws", async () => {
    const partiallyThrowingKv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockRejectedValue(new Error("kv put outage")),
    };
    const env2 = { CACHE: partiallyThrowingKv } as unknown as Env;
    const compute = vi.fn().mockResolvedValue({ ok: true });
    const v = await cachedValue(env2, "test.kvput.throws", 60, compute);
    expect(v).toEqual({ ok: true });
    expect(compute).toHaveBeenCalledOnce();
  });

  it("preserves nested structure across cache roundtrip", async () => {
    const complex = {
      list: [{ id: "a", meta: { count: 5, tags: ["x", "y"] } }],
      flag: true,
      n: 42,
    };
    const compute = vi.fn().mockResolvedValue(complex);
    await cachedValue(env, "test.complex", 60, compute);
    const v2 = await cachedValue(env, "test.complex", 60, compute);
    expect(v2).toEqual(complex);
    expect(compute).toHaveBeenCalledOnce();
  });

  it("isolates keys (no cross-contamination)", async () => {
    const aCompute = vi.fn().mockResolvedValue("alpha");
    const bCompute = vi.fn().mockResolvedValue("beta");
    await cachedValue(env, "test.a", 60, aCompute);
    await cachedValue(env, "test.b", 60, bCompute);
    expect(await cachedValue(env, "test.a", 60, aCompute)).toBe("alpha");
    expect(await cachedValue(env, "test.b", 60, bCompute)).toBe("beta");
    expect(aCompute).toHaveBeenCalledOnce();
    expect(bCompute).toHaveBeenCalledOnce();
  });

  it("propagates errors from compute (no swallow)", async () => {
    const throwingCompute = vi.fn().mockRejectedValue(new Error("d1 outage"));
    await expect(
      cachedValue(env, "test.compute.throws", 60, throwingCompute),
    ).rejects.toThrow("d1 outage");
  });

  describe("ttlFor (a result that should not live the full TTL)", () => {
    it("stamps a shorter-lived result so it expires after the short TTL, not the full one", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
        const compute = vi.fn().mockResolvedValue({ degraded: true });
        await cachedValue(env, "test.short", 600, compute, { ttlFor: (v) => (v.degraded ? 15 : 600) });
        vi.setSystemTime(new Date("2026-10-15T10:00:10Z"));
        await cachedValue(env, "test.short", 600, compute);
        expect(compute).toHaveBeenCalledTimes(1); // still fresh at 10s
        vi.setSystemTime(new Date("2026-10-15T10:00:16Z"));
        await cachedValue(env, "test.short", 600, compute);
        expect(compute).toHaveBeenCalledTimes(2); // expired at 16s, long before 600s
      } finally {
        vi.useRealTimers();
      }
    });

    it("never lengthens the TTL, and a result of 0 is not written", async () => {
      const compute = vi.fn().mockResolvedValue({ n: 1 });
      await cachedValue(env, "test.long", 60, compute, { ttlFor: () => 9999 });
      await cachedValue(env, "test.long", 60, compute);
      expect(compute).toHaveBeenCalledTimes(1);
      await cachedValue(env, "test.zero", 60, compute, { ttlFor: () => 0 });
      expect(kv.store.has("cv:test.zero")).toBe(false);
    });
  });

  describe("a short (degraded) result never displaces a usable full entry", () => {
    // Mirrors threatAggregate's unfiltered key: 3h TTL, single-flight (serves
    // stale up to the 6h KV expiry), 60s for a degraded result.
    const TTL = 10_800;
    const SF = { lockTtlSeconds: 120, waitMs: 400, pollMs: 10 };
    type Agg = { total: number; degraded_sections: string[] };
    const ttlFor = (v: Agg) => (v.degraded_sections.length ? 60 : TTL);
    const good: Agg = { total: 100, degraded_sections: [] };
    const degraded: Agg = { total: 0, degraded_sections: ["geo"] };
    const seed = (key: string, v: Agg, ageS: number, short = false) =>
      kv.store.set(`cv:${key}`, JSON.stringify({ v, t: Date.now() - ageS * 1000, ...(short ? { s: 1 } : {}) }));
    const stored = (key: string) => JSON.parse(kv.store.get(`cv:${key}`)!) as { v: Agg; t: number; s?: number };

    it("singleFlight: a 4h-old good entry survives a degraded refill and is returned", async () => {
      seed("sc.keep", good, 4 * 3600);
      const before = kv.store.get("cv:sc.keep");
      const compute = vi.fn().mockResolvedValue(degraded);
      const v = await cachedValue(env, "sc.keep", TTL, compute, { singleFlight: SF, ttlFor });
      expect(compute).toHaveBeenCalledOnce();
      expect(v).toEqual(good);
      expect(kv.store.get("cv:sc.keep")).toBe(before); // untouched
      expect(kv.store.has("cvlock:sc.keep")).toBe(false);
    });

    it("SWR background refill: a degraded result leaves the stale good entry in place", async () => {
      seed("sc.swr", good, 600);
      const before = kv.store.get("cv:sc.swr");
      const pending: Promise<unknown>[] = [];
      const compute = vi.fn().mockResolvedValue(degraded);
      const opts = { ttlFor, staleWhileRevalidate: { freshSeconds: 300, waitUntil: (p: Promise<unknown>) => { pending.push(p); } } };
      expect(await cachedValue(env, "sc.swr", TTL, compute, opts)).toEqual(good);
      await Promise.all(pending);
      expect(compute).toHaveBeenCalledOnce();
      expect(kv.store.get("cv:sc.swr")).toBe(before);
    });

    it("no prior entry: the degraded value is written as a short entry with the short TTL", async () => {
      const compute = vi.fn().mockResolvedValue(degraded);
      expect(await cachedValue(env, "sc.cold", TTL, compute, { singleFlight: SF, ttlFor })).toEqual(degraded);
      const e = stored("sc.cold");
      expect(e.v).toEqual(degraded);
      expect(e.s).toBe(1);
      expect(kv.ttls.get("cv:sc.cold")).toBe(120); // max(60 * 2, 60)
      // Pre-aged: expires for readers after ~60s, not TTL.
      expect(Date.now() - e.t).toBeGreaterThanOrEqual((TTL - 60) * 1000 - 50);
    });

    it("a short entry is replaced by a newer short result", async () => {
      seed("sc.short2", { total: 1, degraded_sections: ["a"] }, TTL + 5, true); // expired short
      const compute = vi.fn().mockResolvedValue(degraded);
      expect(await cachedValue(env, "sc.short2", TTL, compute, { singleFlight: SF, ttlFor })).toEqual(degraded);
      expect(stored("sc.short2").v).toEqual(degraded);
      expect(stored("sc.short2").s).toBe(1);
    });

    it("a short entry is replaced by a full result (flag cleared, full TTL)", async () => {
      seed("sc.short3", degraded, TTL + 5, true);
      const compute = vi.fn().mockResolvedValue(good);
      expect(await cachedValue(env, "sc.short3", TTL, compute, { singleFlight: SF, ttlFor })).toEqual(good);
      const e = stored("sc.short3");
      expect(e.v).toEqual(good);
      expect(e.s).toBeUndefined();
      expect(kv.ttls.get("cv:sc.short3")).toBe(TTL * 2);
    });

    it("a full-TTL result always overwrites a stale full entry", async () => {
      seed("sc.full", { total: 5, degraded_sections: [] }, 4 * 3600);
      const compute = vi.fn().mockResolvedValue(good);
      expect(await cachedValue(env, "sc.full", TTL, compute, { singleFlight: SF, ttlFor })).toEqual(good);
      expect(stored("sc.full").v).toEqual(good);
      expect(kv.ttls.get("cv:sc.full")).toBe(TTL * 2);
    });

    it("old envelopes without the flag read as full entries", async () => {
      // Pre-flag envelope, still fresh: a plain hit.
      seed("sc.legacy", good, 10);
      const compute = vi.fn().mockResolvedValue(degraded);
      expect(await cachedValue(env, "sc.legacy", TTL, compute, { singleFlight: SF, ttlFor })).toEqual(good);
      expect(compute).not.toHaveBeenCalled();
    });

    it("plain path (no singleFlight/SWR): an EXPIRED full entry is not served — the short result is written", async () => {
      // observatoryEvents' shape: never returns data older than ttlSeconds.
      seed("sc.plain", good, TTL + 5);
      const compute = vi.fn().mockResolvedValue(degraded);
      expect(await cachedValue(env, "sc.plain", TTL, compute, { ttlFor })).toEqual(degraded);
      expect(stored("sc.plain").v).toEqual(degraded);
      expect(stored("sc.plain").s).toBe(1);
    });

    it("refresh (warm) on the plain path: a still-servable full entry is kept over a short result", async () => {
      seed("sc.warm", good, TTL - 100); // past the refresh-ahead point, within TTL
      const before = kv.store.get("cv:sc.warm");
      const compute = vi.fn().mockResolvedValue(degraded);
      expect(await cachedValue(env, "sc.warm", TTL, compute, { ttlFor, refresh: true })).toEqual(good);
      expect(compute).toHaveBeenCalledOnce();
      expect(kv.store.get("cv:sc.warm")).toBe(before);
    });
  });

  describe("singleFlight (stale-while-revalidate refill lock)", () => {
    const SF = { lockTtlSeconds: 120, waitMs: 400, pollMs: 10 };
    const stale = (key: string, v: unknown) =>
      kv.store.set(`cv:${key}`, JSON.stringify({ v, t: Date.now() - 120_000 })); // 2 min old, ttl 60

    it("a caller with no lock takes it, computes, writes, and releases it", async () => {
      let lockDuringCompute: string | undefined;
      const compute = vi.fn(async () => {
        lockDuringCompute = kv.store.get("cvlock:test.sf");
        return { n: 1 };
      });
      const v = await cachedValue(env, "test.sf", 60, compute, { singleFlight: SF });
      expect(v).toEqual({ n: 1 });
      expect(lockDuringCompute).toBeDefined();
      expect(kv.store.has("cvlock:test.sf")).toBe(false);
      expect(kv.store.has("cv:test.sf")).toBe(true);
    });

    it("expired entry + lock held elsewhere: serves the stale value at once, no compute, no wait", async () => {
      stale("test.swr", { n: "old" });
      kv.store.set("cvlock:test.swr", "1");
      const compute = vi.fn().mockResolvedValue({ n: "new" });
      const t0 = Date.now();
      const v = await cachedValue(env, "test.swr", 60, compute, { singleFlight: { ...SF, waitMs: 5_000 } });
      expect(v).toEqual({ n: "old" });
      expect(compute).not.toHaveBeenCalled();
      expect(Date.now() - t0).toBeLessThan(100);
    });

    it("expired entry + no lock: takes the lock and recomputes (the refiller does not serve stale)", async () => {
      stale("test.refill", { n: "old" });
      const compute = vi.fn().mockResolvedValue({ n: "new" });
      const v = await cachedValue(env, "test.refill", 60, compute, { singleFlight: SF });
      expect(v).toEqual({ n: "new" });
      expect(compute).toHaveBeenCalledOnce();
      expect(JSON.parse(kv.store.get("cv:test.refill")!).v).toEqual({ n: "new" });
      expect(kv.store.has("cvlock:test.refill")).toBe(false);
    });

    it("re-reads after taking the lock: a refill that landed meanwhile is served, not recomputed", async () => {
      stale("test.reread", { n: "old" });
      const origPut = kv.put.bind(kv);
      kv.put = async (k: string, v: string) => {
        await origPut(k, v);
        // Another caller's refill lands right as we take the lock.
        if (k === "cvlock:test.reread") {
          kv.store.set("cv:test.reread", JSON.stringify({ v: { n: "theirs" }, t: Date.now() }));
        }
      };
      const compute = vi.fn().mockResolvedValue({ n: "mine" });
      const v = await cachedValue(env, "test.reread", 60, compute, { singleFlight: SF });
      expect(v).toEqual({ n: "theirs" });
      expect(compute).not.toHaveBeenCalled();
      expect(kv.store.has("cvlock:test.reread")).toBe(false);
    });

    it("cold key + lock held: waits briefly and returns the holder's write", async () => {
      kv.store.set("cvlock:test.cold-wait", "1");
      setTimeout(() => kv.store.set("cv:test.cold-wait", JSON.stringify({ v: { n: 42 }, t: Date.now() })), 30);
      const compute = vi.fn().mockResolvedValue({ n: 0 });
      const v = await cachedValue(env, "test.cold-wait", 60, compute, { singleFlight: SF });
      expect(v).toEqual({ n: 42 });
      expect(compute).not.toHaveBeenCalled();
    });

    it("cold key + lock whose holder never writes: computes after the short wait (fail-open)", async () => {
      kv.store.set("cvlock:test.stuck", "1");
      const compute = vi.fn().mockResolvedValue({ n: 7 });
      const t0 = Date.now();
      const v = await cachedValue(env, "test.stuck", 60, compute, { singleFlight: { ...SF, waitMs: 50 } });
      expect(v).toEqual({ n: 7 });
      expect(compute).toHaveBeenCalledOnce();
      expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
      // A lock it does not own is left to expire, not deleted.
      expect(kv.store.has("cvlock:test.stuck")).toBe(true);
    });

    it("caps the cold-key wait at SINGLE_FLIGHT_MAX_WAIT_MS", async () => {
      vi.useFakeTimers();
      try {
        kv.store.set("cvlock:test.cap", "1");
        const compute = vi.fn().mockResolvedValue({ n: 1 });
        const p = cachedValue(env, "test.cap", 60, compute, { singleFlight: { ...SF, waitMs: 600_000, pollMs: 1000 } });
        await vi.advanceTimersByTimeAsync(SINGLE_FLIGHT_MAX_WAIT_MS + 1000);
        expect(await p).toEqual({ n: 1 });
        expect(compute).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("fails open on KV errors and releases the lock when compute throws", async () => {
      const compute = vi.fn().mockRejectedValue(new Error("boom"));
      await expect(cachedValue(env, "test.throw", 60, compute, { singleFlight: SF })).rejects.toThrow("boom");
      expect(kv.store.has("cvlock:test.throw")).toBe(false);

      const broken = { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); }, delete: async () => {} };
      const v = await cachedValue({ CACHE: broken } as unknown as Env, "test.kvdown", 60,
        vi.fn().mockResolvedValue({ ok: true }), { singleFlight: SF });
      expect(v).toEqual({ ok: true });
    });
  });
});
