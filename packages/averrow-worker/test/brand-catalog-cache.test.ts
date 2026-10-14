/**
 * loadBrandsCached (lib/brandDetect.ts): isolate memo → KV → D1, never
 * throwing because of the cache; enrichBrands skips the catalog when there
 * is nothing to match.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  BRAND_CATALOG_KV_KEY,
  decodeBrandCatalog,
  encodeBrandCatalog,
  enrichBrands,
  loadBrandsCached,
  resetBrandCatalogCacheForTest,
  type BrandRow,
} from "../src/lib/brandDetect";

beforeEach(() => resetBrandCatalogCacheForTest());

const CATALOG: BrandRow[] = [
  { id: "brand_paypal", name: "PayPal", canonical_domain: "paypal.com", tier: "monitored", tranco_rank: 150 },
  { id: "brand_word", name: "Word", canonical_domain: "word.tips", tier: "tracked", tranco_rank: null },
  { id: "brand_x", name: "X", canonical_domain: "x.com", tier: null, tranco_rank: 12 },
];

function fakeDb(brands: BrandRow[] = CATALOG, threats: unknown[] = []) {
  const sqls: string[] = [];
  const stmt = (sql: string) => ({
    bind: () => stmt(sql),
    all: async () => {
      sqls.push(sql);
      return { results: sql.includes("FROM brands") ? brands : sql.includes("FROM threats") ? threats : [] };
    },
    run: async () => {
      sqls.push(sql);
      return { meta: { changes: 0 } };
    },
  });
  const db = { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
  return { db, sqls, brandLoads: () => sqls.filter((s) => s.includes("FROM brands")).length };
}

function fakeKv(initial: Record<string, string> = {}, opts: { throwGet?: boolean; throwPut?: boolean } = {}) {
  const store = new Map(Object.entries(initial));
  const puts: Array<{ key: string; ttl?: number }> = [];
  const kv = {
    get: vi.fn(async (key: string) => {
      if (opts.throwGet) throw new Error("kv down");
      return store.get(key) ?? null;
    }),
    put: vi.fn(async (key: string, value: string | Uint8Array, o?: { expirationTtl?: number }) => {
      if (opts.throwPut) throw new Error("kv down");
      store.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
      puts.push({ key, ttl: o?.expirationTtl });
    }),
  } as unknown as KVNamespace;
  return { kv, store, puts };
}

describe("brand catalog encoding", () => {
  it("round-trips, including null tier/rank", () => {
    expect(decodeBrandCatalog(encodeBrandCatalog(CATALOG))).toEqual(CATALOG);
  });
  it("rejects malformed payloads instead of returning partial rows", () => {
    expect(decodeBrandCatalog("not json")).toBeNull();
    expect(decodeBrandCatalog("{}")).toBeNull();
    expect(decodeBrandCatalog('[["a","b","c",null]]')).toBeNull();
    expect(decodeBrandCatalog('[["a",1,"c",null,null]]')).toBeNull();
  });
});

describe("loadBrandsCached", () => {
  it("D1 miss populates KV (with TTL) and the isolate memo", async () => {
    const { db, brandLoads } = fakeDb();
    const { kv, store, puts } = fakeKv();
    expect(await loadBrandsCached({ DB: db, CACHE: kv })).toEqual(CATALOG);
    expect(await loadBrandsCached({ DB: db, CACHE: kv })).toEqual(CATALOG);
    expect(brandLoads()).toBe(1);
    expect(puts).toEqual([{ key: BRAND_CATALOG_KV_KEY, ttl: 3600 }]);
    expect(decodeBrandCatalog(store.get(BRAND_CATALOG_KV_KEY)!)).toEqual(CATALOG);
    expect((kv.get as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1); // second call: memo
  });

  it("a KV hit skips D1 entirely", async () => {
    const { db, brandLoads } = fakeDb();
    const { kv } = fakeKv({ [BRAND_CATALOG_KV_KEY]: encodeBrandCatalog(CATALOG) });
    expect(await loadBrandsCached({ DB: db, CACHE: kv })).toEqual(CATALOG);
    expect(brandLoads()).toBe(0);
  });

  it("falls through to D1 on KV errors and corrupt payloads, never throwing", async () => {
    for (const { kv } of [fakeKv({}, { throwGet: true, throwPut: true }), fakeKv({ [BRAND_CATALOG_KV_KEY]: "[[1" })]) {
      resetBrandCatalogCacheForTest();
      const { db, brandLoads } = fakeDb();
      expect(await loadBrandsCached({ DB: db, CACHE: kv })).toEqual(CATALOG);
      expect(brandLoads()).toBe(1);
    }
  });

  it("works with no KV binding", async () => {
    const { db } = fakeDb();
    expect(await loadBrandsCached({ DB: db })).toEqual(CATALOG);
  });

  it("the shared catalog is frozen", async () => {
    const { db } = fakeDb();
    expect(Object.isFrozen(await loadBrandsCached({ DB: db }))).toBe(true);
  });

  it("concurrent callers share one load", async () => {
    const { db, brandLoads } = fakeDb();
    const [a, b] = await Promise.all([loadBrandsCached({ DB: db }), loadBrandsCached({ DB: db })]);
    expect(a).toBe(b);
    expect(brandLoads()).toBe(1);
  });

  it("does not memoize an empty catalog", async () => {
    const empty = fakeDb([]);
    expect(await loadBrandsCached({ DB: empty.db })).toEqual([]);
    const full = fakeDb();
    expect(await loadBrandsCached({ DB: full.db })).toEqual(CATALOG);
  });

  it("the memo expires after 10 minutes", async () => {
    vi.useFakeTimers();
    try {
      const { db, brandLoads } = fakeDb();
      await loadBrandsCached({ DB: db });
      vi.advanceTimersByTime(9 * 60 * 1000);
      await loadBrandsCached({ DB: db });
      expect(brandLoads()).toBe(1);
      vi.advanceTimersByTime(2 * 60 * 1000);
      await loadBrandsCached({ DB: db });
      expect(brandLoads()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("enrichBrands", () => {
  it("returns before loading the catalog when no threat needs a brand", async () => {
    const { db, brandLoads } = fakeDb(CATALOG, []);
    expect(await enrichBrands(db)).toEqual({ matched: 0, total: 0 });
    expect(brandLoads()).toBe(0);
  });

  it("loads the catalog only when candidates exist", async () => {
    const { db, brandLoads } = fakeDb(CATALOG, [
      { id: "t1", malicious_domain: "unrelated-host.example", malicious_url: null, technique: null },
    ]);
    const r = await enrichBrands(db);
    expect(r.total).toBe(1);
    expect(brandLoads()).toBe(1);
  });
});
