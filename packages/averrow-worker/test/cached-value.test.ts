import { describe, it, expect, beforeEach, vi } from "vitest";
import { cachedValue, SINGLE_FLIGHT_MAX_WAIT_MS } from "../src/lib/cached-value";
import type { Env } from "../src/types";

// Mirrors the MockKV from cached-count.test.ts. Kept inline so each
// test file is self-contained — the helpers are small and the
// duplication is cheaper than coupling tests via shared fixtures.
class MockKV {
  store = new Map<string, string>();
  ttls = new Map<string, number | undefined>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

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
  describe("keepExistingWhen (never overwrite a good entry with a bad refill)", () => {
    const SF = { lockTtlSeconds: 120, waitMs: 400, pollMs: 10 };
    const bad = (v: { degraded?: boolean }) => v.degraded === true;
    const put = (key: string, v: unknown, ageMs: number) => {
      const raw = JSON.stringify({ v, t: Date.now() - ageMs });
      kv.store.set(`cv:${key}`, raw);
      return raw;
    };

    for (const sf of [undefined, SF]) {
      const path = sf ? "single-flight lock holder" : "plain miss";
      it(`${path}: degraded refill over a stale good entry returns it and writes nothing`, async () => {
        const before = put("test.keep", { n: "good" }, 120_000);
        const compute = vi.fn().mockResolvedValue({ n: "partial", degraded: true });
        const v = await cachedValue(env, "test.keep", 60, compute, { keepExistingWhen: bad, singleFlight: sf });
        expect(v).toEqual({ n: "good" });
        expect(compute).toHaveBeenCalledOnce();
        expect(kv.store.get("cv:test.keep")).toBe(before);
        expect(kv.store.has("cvlock:test.keep")).toBe(false);
      });

      it(`${path}: cold key writes the degraded value`, async () => {
        const compute = vi.fn().mockResolvedValue({ n: "partial", degraded: true });
        const v = await cachedValue(env, "test.cold.keep", 60, compute, { keepExistingWhen: bad, singleFlight: sf });
        expect(v).toEqual({ n: "partial", degraded: true });
        expect(JSON.parse(kv.store.get("cv:test.cold.keep")!).v).toEqual({ n: "partial", degraded: true });
      });

      it(`${path}: an existing entry that is itself degraded is replaced`, async () => {
        put("test.bad.old", { n: "old-partial", degraded: true }, 120_000);
        const compute = vi.fn().mockResolvedValue({ n: "new-partial", degraded: true });
        const v = await cachedValue(env, "test.bad.old", 60, compute, { keepExistingWhen: bad, singleFlight: sf });
        expect(v).toEqual({ n: "new-partial", degraded: true });
        expect(JSON.parse(kv.store.get("cv:test.bad.old")!).v).toEqual({ n: "new-partial", degraded: true });
      });

      it(`${path}: a good refill still replaces a stale good entry`, async () => {
        put("test.good.refill", { n: "old" }, 120_000);
        const compute = vi.fn().mockResolvedValue({ n: "new" });
        const v = await cachedValue(env, "test.good.refill", 60, compute, { keepExistingWhen: bad, singleFlight: sf });
        expect(v).toEqual({ n: "new" });
        expect(JSON.parse(kv.store.get("cv:test.good.refill")!).v).toEqual({ n: "new" });
      });
    }

    it("lock holder uses its re-read: a good entry that landed after the first read is kept", async () => {
      // First read sees no entry; another refill lands between it and the lock.
      const origPut = kv.put.bind(kv);
      let landed: string | undefined;
      kv.put = async (k: string, v: string) => {
        await origPut(k, v);
        if (k === "cvlock:test.landed") {
          landed = JSON.stringify({ v: { n: "landed-good" }, t: Date.now() - 120_000 });
          kv.store.set("cv:test.landed", landed);
        }
      };
      const compute = vi.fn().mockResolvedValue({ n: "partial", degraded: true });
      const v = await cachedValue(env, "test.landed", 60, compute, { keepExistingWhen: bad, singleFlight: SF });
      expect(v).toEqual({ n: "landed-good" });
      expect(kv.store.get("cv:test.landed")).toBe(landed);
      expect(kv.store.has("cvlock:test.landed")).toBe(false);
    });

    it("with ttlFor: a kept entry is re-stamped fresh for the back-off, original write time preserved", async () => {
      const before = put("test.backoff", { n: "good" }, 70_000); // ttl 60 → expired, 50s KV life left of 120
      const compute = vi.fn().mockResolvedValue({ n: "partial", degraded: true });
      // remaining = 120 - 70 = 50s < 60 → no re-stamp (would outlive the original entry)
      await cachedValue(env, "test.backoff", 60, compute, { keepExistingWhen: bad, ttlFor: (v) => (bad(v) ? 10 : 60) });
      expect(kv.store.get("cv:test.backoff")).toBe(before);

      // Long-TTL entry with plenty of KV life: re-stamped.
      const longRaw = JSON.stringify({ v: { n: "good" }, t: Date.now() - 400_000 });
      kv.store.set("cv:test.long", longRaw);
      const v = await cachedValue(env, "test.long", 300, compute, { keepExistingWhen: bad, ttlFor: (x) => (bad(x) ? 10 : 300) });
      expect(v).toEqual({ n: "good" });
      const kept = JSON.parse(kv.store.get("cv:test.long")!) as { v: unknown; t: number; w: number };
      expect(kept.v).toEqual({ n: "good" });
      expect(kept.w).toBe(JSON.parse(longRaw).t);
      // Fresh for 10s: stamp = now - (300 - 10)s.
      expect(Date.now() - kept.t).toBeLessThan(291_000);
      expect(Date.now() - kept.t).toBeGreaterThanOrEqual(289_000);
      // KV expiry bounded by the original write: 600s life - 400s age = 200s.
      const firstTtl = kv.ttls.get("cv:test.long")!;
      expect(firstTtl).toBeGreaterThanOrEqual(199);
      expect(firstTtl).toBeLessThanOrEqual(200);
      // A second back-off keeps the ORIGINAL write time, re-stamps t, and the
      // remaining lifetime shrinks rather than resetting.
      const later = Date.now() + 11_000;
      const spy = vi.spyOn(Date, "now").mockReturnValue(later);
      try {
        await cachedValue(env, "test.long", 300, compute, { keepExistingWhen: bad, ttlFor: (x) => (bad(x) ? 10 : 300) });
        const second = JSON.parse(kv.store.get("cv:test.long")!) as { t: number; w: number };
        expect(second.w).toBe(JSON.parse(longRaw).t);
        expect(second.t).toBe(later - 290_000);
        expect(kv.ttls.get("cv:test.long")!).toBeLessThan(firstTtl);
      } finally {
        spy.mockRestore();
      }
    });

    it("back-off never clobbers an entry another caller refilled during compute", async () => {
      kv.store.set("cv:test.race", JSON.stringify({ v: { n: "old-good" }, t: Date.now() - 400_000 }));
      const newer = JSON.stringify({ v: { n: "new-good" }, t: Date.now() });
      // While this caller computes (and degrades), another refill lands.
      const compute = vi.fn().mockImplementation(async () => {
        kv.store.set("cv:test.race", newer);
        return { n: "partial", degraded: true };
      });
      const v = await cachedValue(env, "test.race", 300, compute, { keepExistingWhen: bad, ttlFor: (x) => (bad(x) ? 10 : 300) });
      expect(v).toEqual({ n: "new-good" });
      expect(kv.store.get("cv:test.race")).toBe(newer);
    });

    describe("threatAggregate's unfiltered shape (3h TTL, single-flight, 60s degraded back-off)", () => {
      const TTL = 10_800;
      type Agg = { total: number; degraded_sections?: string[] };
      const isDegraded = (v: Agg) => (v.degraded_sections?.length ?? 0) > 0;
      const opts = {
        singleFlight: SF,
        keepExistingWhen: isDegraded,
        ttlFor: (v: Agg) => (isDegraded(v) ? 60 : TTL),
      };
      const good: Agg = { total: 100 };
      const degraded: Agg = { total: 0, degraded_sections: ["headline"] };
      const stored = (key: string) => JSON.parse(kv.store.get(`cv:${key}`)!) as { v: Agg; t: number; w?: number };

      it("HIGH: a 4h-old good entry survives a degraded refill and the next request within 60s is a hit", async () => {
        const writtenAt = Date.now() - 4 * 3600_000;
        kv.store.set("cv:agg.high", JSON.stringify({ v: good, t: writtenAt }));
        const compute = vi.fn().mockResolvedValue(degraded);

        expect(await cachedValue(env, "agg.high", TTL, compute, opts)).toEqual(good);
        expect(compute).toHaveBeenCalledOnce();
        expect(kv.store.has("cvlock:agg.high")).toBe(false);
        const kept = stored("agg.high");
        expect(kept.v).toEqual(good);
        expect(kept.w).toBe(writtenAt);
        // KV life bounded by the original write: 6h - 4h = 2h left, never extended.
        const ttl = kv.ttls.get("cv:agg.high")!;
        expect(ttl).toBeGreaterThanOrEqual(2 * 3600 - 1);
        expect(ttl).toBeLessThanOrEqual(2 * 3600);

        // 59s later: a plain cache hit, no lock, no recompute.
        const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 59_000);
        try {
          const next = vi.fn().mockResolvedValue(degraded);
          expect(await cachedValue(env, "agg.high", TTL, next, opts)).toEqual(good);
          expect(next).not.toHaveBeenCalled();
          expect(kv.store.has("cvlock:agg.high")).toBe(false);
        } finally {
          spy.mockRestore();
        }

        // After the 60s back-off the next request retries the refill.
        const spy2 = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
        try {
          const retry = vi.fn().mockResolvedValue({ total: 101 });
          expect(await cachedValue(env, "agg.high", TTL, retry, opts)).toEqual({ total: 101 });
          expect(retry).toHaveBeenCalledOnce();
        } finally {
          spy2.mockRestore();
        }
      });

      it("cold key: a degraded result is written fresh for 60s only", async () => {
        const compute = vi.fn().mockResolvedValue(degraded);
        expect(await cachedValue(env, "agg.cold", TTL, compute, opts)).toEqual(degraded);
        const e = stored("agg.cold");
        expect(e.v).toEqual(degraded);
        expect(e.w).toBeUndefined();
        expect(kv.ttls.get("cv:agg.cold")).toBe(120); // max(60 * 2, 60)
        // Pre-aged: readers see it expire after ~60s, not after TTL.
        const age = Date.now() - e.t;
        expect(age).toBeGreaterThanOrEqual((TTL - 60) * 1000 - 50);
        expect(age).toBeLessThanOrEqual((TTL - 60) * 1000 + 50);
      });

      it("a healthy result always overwrites (stale good, back-off-kept, and degraded entries)", async () => {
        const fresh: Agg = { total: 200 };
        const seeds: Array<[string, object]> = [
          ["agg.ok.stale", { v: good, t: Date.now() - 4 * 3600_000 }],
          ["agg.ok.kept", { v: good, t: Date.now() - (TTL + 1) * 1000, w: Date.now() - 4 * 3600_000 }],
          ["agg.ok.bad", { v: degraded, t: Date.now() - (TTL + 1) * 1000 }],
        ];
        for (const [key, entry] of seeds) {
          kv.store.set(`cv:${key}`, JSON.stringify(entry));
          const compute = vi.fn().mockResolvedValue(fresh);
          expect(await cachedValue(env, key, TTL, compute, opts)).toEqual(fresh);
          const e = stored(key);
          expect(e.v).toEqual(fresh);
          expect(e.w).toBeUndefined();
          expect(Date.now() - e.t).toBeLessThan(1000);
          expect(kv.ttls.get(`cv:${key}`)).toBe(TTL * 2);
        }
      });

      it("lock holder: a newer refill landing during compute is not clobbered by the back-off re-stamp", async () => {
        kv.store.set("cv:agg.race", JSON.stringify({ v: good, t: Date.now() - 4 * 3600_000 }));
        const newer = JSON.stringify({ v: { total: 300 }, t: Date.now() });
        const compute = vi.fn().mockImplementation(async () => {
          kv.store.set("cv:agg.race", newer); // e.g. a fail-open caller's write
          return degraded;
        });
        expect(await cachedValue(env, "agg.race", TTL, compute, opts)).toEqual({ total: 300 });
        expect(kv.store.get("cv:agg.race")).toBe(newer);
        expect(kv.store.has("cvlock:agg.race")).toBe(false);
      });

      it("SWR background refill: a degraded result keeps the stale good entry, re-stamped", async () => {
        const writtenAt = Date.now() - 600_000;
        kv.store.set("cv:agg.swr", JSON.stringify({ v: good, t: writtenAt }));
        const pending: Promise<unknown>[] = [];
        const compute = vi.fn().mockResolvedValue(degraded);
        const swrOpts = {
          keepExistingWhen: isDegraded,
          ttlFor: opts.ttlFor,
          staleWhileRevalidate: { freshSeconds: 300, waitUntil: (p: Promise<unknown>) => { pending.push(p); } },
        };
        expect(await cachedValue(env, "agg.swr", TTL, compute, swrOpts)).toEqual(good);
        await Promise.all(pending);
        expect(compute).toHaveBeenCalledOnce();
        expect(stored("agg.swr").v).toEqual(good);
        expect(stored("agg.swr").w).toBe(writtenAt);
      });
    });
  });

  describe("callers without keepExistingWhen are unchanged (master behaviour)", () => {
    // observatoryEvents' shape: ttlFor only, no singleFlight.
    type R = { n: string; degraded?: boolean };
    const ttlFor = (v: R) => (v.degraded ? 60 : 300);

    it("a degraded result overwrites an expired good entry, pre-aged to the short TTL", async () => {
      kv.store.set("cv:plain.deg", JSON.stringify({ v: { n: "good" }, t: Date.now() - 400_000 }));
      const compute = vi.fn().mockResolvedValue({ n: "partial", degraded: true });
      expect(await cachedValue(env, "plain.deg", 300, compute, { ttlFor })).toEqual({ n: "partial", degraded: true });
      const e = JSON.parse(kv.store.get("cv:plain.deg")!) as { v: R; t: number; w?: number; s?: number };
      expect(e.v).toEqual({ n: "partial", degraded: true });
      expect(e.w).toBeUndefined();
      expect(e.s).toBeUndefined();
      expect(kv.ttls.get("cv:plain.deg")).toBe(120);
      expect(Date.now() - e.t).toBeGreaterThanOrEqual(240_000 - 50);
    });

    it("an expired entry is never served on the plain path", async () => {
      kv.store.set("cv:plain.exp", JSON.stringify({ v: { n: "old" }, t: Date.now() - 301_000 }));
      const compute = vi.fn().mockResolvedValue({ n: "new" });
      expect(await cachedValue(env, "plain.exp", 300, compute, { ttlFor })).toEqual({ n: "new" });
      expect(compute).toHaveBeenCalledOnce();
      expect(kv.ttls.get("cv:plain.exp")).toBe(600);
    });

    it("single-flight lock holder writes a degraded result over a stale good entry", async () => {
      kv.store.set("cv:plain.sf", JSON.stringify({ v: { n: "good" }, t: Date.now() - 400_000 }));
      const compute = vi.fn().mockResolvedValue({ n: "partial", degraded: true });
      const v = await cachedValue(env, "plain.sf", 300, compute, {
        ttlFor, singleFlight: { lockTtlSeconds: 120, waitMs: 400, pollMs: 10 },
      });
      expect(v).toEqual({ n: "partial", degraded: true });
      expect(JSON.parse(kv.store.get("cv:plain.sf")!).v).toEqual({ n: "partial", degraded: true });
    });
  });
});
