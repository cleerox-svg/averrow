import { describe, it, expect, beforeEach, vi } from "vitest";
import { cachedCount, getCachedCountStats } from "../src/lib/cached-count";
import type { Env } from "../src/types";

// ─── Minimal in-memory KV mock ────────────────────────────────────
// Mirrors the subset of KVNamespace the helper actually uses (get,
// put). put options are ignored — TTL is enforced by the helper's
// own ageSeconds check, not the mock. Designed to be drop-in for
// happy-path tests; the failure-mode tests substitute a throwing
// version inline.
class MockKV {
  store = new Map<string, string>();
  getCalls = 0;
  putCalls = 0;

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.putCalls += 1;
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function makeEnv(kv: MockKV): Env {
  return { CACHE: kv } as unknown as Env;
}

describe("cachedCount", () => {
  let kv: MockKV;
  let env: Env;
  let compute: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    kv = new MockKV();
    env = makeEnv(kv);
    compute = vi.fn().mockResolvedValue(42);
  });

  it("computes on cold cache and writes the value", async () => {
    const v = await cachedCount(env, "test.cold", 60, compute);
    expect(v).toBe(42);
    expect(compute).toHaveBeenCalledOnce();
    // Value cache + stats ring write.
    expect(kv.putCalls).toBeGreaterThanOrEqual(1);
    const stored = kv.store.get("cc:test.cold");
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed.v).toBe(42);
    expect(typeof parsed.t).toBe("number");
  });

  it("returns cached value on warm cache without computing", async () => {
    await cachedCount(env, "test.warm", 60, compute);
    expect(compute).toHaveBeenCalledTimes(1);

    const v2 = await cachedCount(env, "test.warm", 60, compute);
    expect(v2).toBe(42);
    // compute should NOT run again — cache is fresh.
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes when cached entry is stale", async () => {
    await cachedCount(env, "test.stale", 60, compute);

    // Manually backdate the stored entry to before TTL.
    const raw = kv.store.get("cc:test.stale")!;
    const parsed = JSON.parse(raw);
    parsed.t = Date.now() - 120_000; // 120s ago, beyond 60s TTL
    kv.store.set("cc:test.stale", JSON.stringify(parsed));

    const v2 = await cachedCount(env, "test.stale", 60, compute);
    expect(v2).toBe(42);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("bypasses cache entirely when ttlSeconds is 0", async () => {
    await cachedCount(env, "test.bypass", 0, compute);
    await cachedCount(env, "test.bypass", 0, compute);
    expect(compute).toHaveBeenCalledTimes(2);
    // Bypass mode never writes the value to KV (only stats).
    expect(kv.store.has("cc:test.bypass")).toBe(false);
  });

  it("treats negative TTL as bypass", async () => {
    const v = await cachedCount(env, "test.neg", -5, compute);
    expect(v).toBe(42);
    expect(compute).toHaveBeenCalledOnce();
    expect(kv.store.has("cc:test.neg")).toBe(false);
  });

  it("falls through to compute when KV.get throws", async () => {
    const throwingKv = {
      get: vi.fn().mockRejectedValue(new Error("kv outage")),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const throwingEnv = { CACHE: throwingKv } as unknown as Env;

    const v = await cachedCount(throwingEnv, "test.kvget.throws", 60, compute);
    expect(v).toBe(42);
    expect(compute).toHaveBeenCalledOnce();
  });

  it("returns the computed value when KV.put throws", async () => {
    const partiallyThrowingKv = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockRejectedValue(new Error("kv put outage")),
    };
    const env2 = { CACHE: partiallyThrowingKv } as unknown as Env;

    const v = await cachedCount(env2, "test.kvput.throws", 60, compute);
    expect(v).toBe(42);
    expect(compute).toHaveBeenCalledOnce();
  });

  it("caches zero values correctly (not treated as missing)", async () => {
    const zeroCompute = vi.fn().mockResolvedValue(0);
    await cachedCount(env, "test.zero", 60, zeroCompute);
    const v2 = await cachedCount(env, "test.zero", 60, zeroCompute);
    expect(v2).toBe(0);
    expect(zeroCompute).toHaveBeenCalledOnce();
  });

  it("caches negative values correctly", async () => {
    const negCompute = vi.fn().mockResolvedValue(-5);
    await cachedCount(env, "test.neg.value", 60, negCompute);
    const v2 = await cachedCount(env, "test.neg.value", 60, negCompute);
    expect(v2).toBe(-5);
    expect(negCompute).toHaveBeenCalledOnce();
  });

  it("uses isolated keys (no cross-contamination)", async () => {
    const aCompute = vi.fn().mockResolvedValue(1);
    const bCompute = vi.fn().mockResolvedValue(2);
    await cachedCount(env, "test.a", 60, aCompute);
    await cachedCount(env, "test.b", 60, bCompute);
    const a2 = await cachedCount(env, "test.a", 60, aCompute);
    const b2 = await cachedCount(env, "test.b", 60, bCompute);
    expect(a2).toBe(1);
    expect(b2).toBe(2);
    expect(aCompute).toHaveBeenCalledOnce();
    expect(bCompute).toHaveBeenCalledOnce();
  });

  it("does not crash when compute throws — surfaces the error", async () => {
    const throwingCompute = vi.fn().mockRejectedValue(new Error("d1 outage"));
    await expect(
      cachedCount(env, "test.compute.throws", 60, throwingCompute),
    ).rejects.toThrow("d1 outage");
  });
});

describe("getCachedCountStats", () => {
  it("returns zeroed stats when ring is empty", async () => {
    const env = makeEnv(new MockKV());
    const s = await getCachedCountStats(env);
    expect(s).toEqual({
      hits: 0,
      misses: 0,
      bypasses: 0,
      ring_size: 0,
      hit_rate: null,
    });
  });

  it("computes hit_rate from a populated ring", async () => {
    const kv = new MockKV();
    kv.store.set("cc:_stats", JSON.stringify(["hit", "hit", "miss", "miss", "miss"]));
    const env = makeEnv(kv);
    const s = await getCachedCountStats(env);
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(3);
    expect(s.hit_rate).toBe(40);
    expect(s.ring_size).toBe(5);
  });

  it("counts bypasses separately and excludes them from hit_rate", async () => {
    const kv = new MockKV();
    kv.store.set(
      "cc:_stats",
      JSON.stringify(["hit", "hit", "miss", "bypass", "bypass"]),
    );
    const env = makeEnv(kv);
    const s = await getCachedCountStats(env);
    expect(s.bypasses).toBe(2);
    // hit_rate = hits / (hits + misses) — bypass excluded from denom
    expect(s.hit_rate).toBe(Math.round((2 / 3) * 1000) / 10);
  });

  it("returns zeros gracefully when KV throws", async () => {
    const throwingKv = {
      get: vi.fn().mockRejectedValue(new Error("kv outage")),
      put: vi.fn(),
    };
    const env = { CACHE: throwingKv } as unknown as Env;
    const s = await getCachedCountStats(env);
    expect(s.hit_rate).toBeNull();
    expect(s.ring_size).toBe(0);
  });
});

describe("cachedCount stats integration", () => {
  it("records hit/miss in the stats ring", async () => {
    const kv = new MockKV();
    const env = makeEnv(kv);
    const compute = vi.fn().mockResolvedValue(7);

    // First call: miss
    await cachedCount(env, "test.stats", 60, compute);
    // Second call: hit
    await cachedCount(env, "test.stats", 60, compute);

    const s = await getCachedCountStats(env);
    expect(s.misses).toBeGreaterThanOrEqual(1);
    expect(s.hits).toBeGreaterThanOrEqual(1);
  });
});
