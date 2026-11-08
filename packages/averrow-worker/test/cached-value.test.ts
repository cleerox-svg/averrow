import { describe, it, expect, beforeEach, vi } from "vitest";
import { cachedValue } from "../src/lib/cached-value";
import type { Env } from "../src/types";

// Mirrors the MockKV from cached-count.test.ts. Kept inline so each
// test file is self-contained — the helpers are small and the
// duplication is cheaper than coupling tests via shared fixtures.
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

  describe("singleFlight (best-effort refill lock)", () => {
    const SF = { lockTtlSeconds: 120, waitMs: 400, pollMs: 10 };

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

    it("concurrent misses: only the lock holder computes, the waiter reads its write", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const compute = vi.fn(async () => { await gate; return { n: 42 }; });
      const holder = cachedValue(env, "test.herd", 60, compute, { singleFlight: SF });
      await new Promise((r) => setTimeout(r, 5)); // holder has taken the lock
      const waiter = cachedValue(env, "test.herd", 60, compute, { singleFlight: SF });
      await new Promise((r) => setTimeout(r, 20));
      release();
      expect(await holder).toEqual({ n: 42 });
      expect(await waiter).toEqual({ n: 42 });
      expect(compute).toHaveBeenCalledTimes(1);
    });

    it("fails open: a lock whose holder never writes falls through to compute after waitMs", async () => {
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
