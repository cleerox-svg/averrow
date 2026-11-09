// lib/swr-cache.ts — long-lived KV entry, short live freshness, background refresh.

import { describe, it, expect } from "vitest";
import { swrCache, writeSwrEntry } from "../src/lib/swr-cache";
import { markCacheRefresh, refreshAfterSeconds } from "../src/lib/cache-refresh";
import { fakeKv } from "./sqlite-d1-harness";

const NOW = 1_800_000_000_000;
const OPTS = { ttlSeconds: 1200, freshSeconds: 75, now: () => NOW };
const req = () => new Request("https://averrow.com/x");

function seed(kv: ReturnType<typeof fakeKv>, value: string, ageS: number): void {
  kv.store.set("k", JSON.stringify({ v: value, t: NOW - ageS * 1000 }));
}

function counter(): { compute: () => Promise<string>; calls: () => number } {
  let n = 0;
  return { compute: async () => `computed-${++n}`, calls: () => n };
}

describe("swrCache", () => {
  it("miss → computes, stores the envelope, returns it", async () => {
    const kv = fakeKv();
    const c = counter();
    const r = await swrCache(req(), kv, "k", OPTS, c.compute);
    expect(r).toEqual({ value: "computed-1", source: "computed" });
    expect(JSON.parse(kv.store.get("k")!)).toEqual({ v: "computed-1", t: NOW });
  });

  it("live: an entry younger than freshSeconds is served, nothing computed", async () => {
    const kv = fakeKv();
    seed(kv, "cached", 74);
    const c = counter();
    expect(await swrCache(req(), kv, "k", OPTS, c.compute)).toEqual({ value: "cached", source: "fresh" });
    expect(c.calls()).toBe(0);
  });

  it("live + waitUntil: a stale entry is served at once and refreshed in the background", async () => {
    const kv = fakeKv();
    seed(kv, "cached", 600);
    const c = counter();
    const pending: Promise<unknown>[] = [];
    const r = await swrCache(req(), kv, "k", { ...OPTS, waitUntil: (p) => pending.push(p) }, c.compute);
    expect(r).toEqual({ value: "cached", source: "stale" });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(JSON.parse(kv.store.get("k")!).v).toBe("computed-1");
  });

  it("live + waitUntil: a failing background refresh is swallowed and the stale entry kept", async () => {
    const kv = fakeKv();
    seed(kv, "cached", 600);
    const pending: Promise<unknown>[] = [];
    const r = await swrCache(req(), kv, "k", { ...OPTS, waitUntil: (p) => pending.push(p) }, async () => {
      throw new Error("D1 overloaded");
    });
    expect(r.value).toBe("cached");
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(JSON.parse(kv.store.get("k")!).v).toBe("cached");
  });

  it("live without waitUntil: a stale entry is recomputed inline (old TTL semantics)", async () => {
    const kv = fakeKv();
    seed(kv, "cached", 76);
    expect(await swrCache(req(), kv, "k", OPTS, counter().compute)).toEqual({ value: "computed-1", source: "computed" });
  });

  it("inline compute errors propagate and nothing is cached", async () => {
    const kv = fakeKv();
    await expect(swrCache(req(), kv, "k", OPTS, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(kv.store.has("k")).toBe(false);
  });

  it("refresh-marked warm: keeps an entry younger than refreshAfterSeconds(ttl), recomputes an older one", async () => {
    const threshold = refreshAfterSeconds(OPTS.ttlSeconds); // 540s for 1200s
    expect(threshold).toBe(540);
    const young = fakeKv();
    seed(young, "cached", threshold - 1);
    expect((await swrCache(markCacheRefresh(req()), young, "k", OPTS, counter().compute)).source).toBe("fresh");
    const old = fakeKv();
    seed(old, "cached", threshold + 1);
    expect((await swrCache(markCacheRefresh(req()), old, "k", OPTS, counter().compute)).source).toBe("computed");
    // A warm ignores the (short) live freshness: 100s old is still fresh for it.
    const live = fakeKv();
    seed(live, "cached", 100);
    expect((await swrCache(markCacheRefresh(req()), live, "k", OPTS, counter().compute)).source).toBe("fresh");
  });

  it("a legacy (non-envelope) value or a KV read error is a miss", async () => {
    const kv = fakeKv({ k: JSON.stringify({ success: true, data: {} }) });
    expect((await swrCache(req(), kv, "k", OPTS, counter().compute)).source).toBe("computed");
    const broken = { get: async () => { throw new Error("kv down"); }, put: async () => {} } as unknown as KVNamespace;
    expect((await swrCache(req(), broken, "k", OPTS, counter().compute)).source).toBe("computed");
  });

  it("writeSwrEntry passes an expirationTtl ≥ 60 and never throws", async () => {
    const puts: Array<{ ttl: number | undefined }> = [];
    const kv = { put: async (_k: string, _v: string, o?: { expirationTtl?: number }) => { puts.push({ ttl: o?.expirationTtl }); } } as unknown as KVNamespace;
    await writeSwrEntry(kv, "k", 1, 30);
    await writeSwrEntry(kv, "k", 1, 1200);
    expect(puts).toEqual([{ ttl: 60 }, { ttl: 1200 }]);
    const failing = { put: async () => { throw new Error("429"); } } as unknown as KVNamespace;
    await expect(writeSwrEntry(failing, "k", 1, 1200)).resolves.toBeUndefined();
  });
});
