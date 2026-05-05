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
});
