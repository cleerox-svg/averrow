// Pin: org-scoped KV cache keys encode the org AND the full brand set.
//
// Regression for the cross-tenant cache leak (PR-A): five staff handlers
// keyed org-scoped KV entries on `scope.brand_ids.slice(0, 3).join(",")`
// while their queries bound ALL brand_ids. Two orgs whose first three
// brand IDs coincided (org_brands has no ORDER BY; a brand may belong to
// several orgs) read each other's cached payload for the full TTL.
//
// Section 1 unit-tests `scopeCacheSegment`. Section 2 drives the real
// handlers with an in-memory KV and a stub D1 whose answers depend on the
// bound brand IDs: org A (b1,b2,b3) fills the cache, then org B
// (b1,b2,b3,b4) must MISS and get its own data.

import { describe, it, expect, beforeEach } from "vitest";
import { scopeCacheSegment, GLOBAL_SCOPE_SEGMENT } from "../src/lib/scope-cache-key";
import { handleDashboardOverview, handleDashboardTopBrands } from "../src/handlers/dashboard";
import { handleListBrands } from "../src/handlers/brands";
import { handleListThreats } from "../src/handlers/threats";
import { threatAggregate } from "../src/lib/threat-aggregates";
import type { Env } from "../src/types";
import type { OrgScope } from "../src/middleware/auth";

// ─── 1. scopeCacheSegment ──────────────────────────────────────────

describe("scopeCacheSegment", () => {
  it("null / undefined → literal 'global' (Navigator warm keys depend on it)", async () => {
    expect(GLOBAL_SCOPE_SEGMENT).toBe("global");
    expect(await scopeCacheSegment(null)).toBe("global");
    expect(await scopeCacheSegment(undefined)).toBe("global");
  });

  it("two orgs sharing their first 3 brands get different segments", async () => {
    const a = await scopeCacheSegment({ org_id: 1, brand_ids: ["b1", "b2", "b3"] });
    const b = await scopeCacheSegment({ org_id: 2, brand_ids: ["b1", "b2", "b3", "b4"] });
    expect(a).not.toBe(b);
  });

  it("same org_id, superset brand list → different segment (no prefix collision)", async () => {
    const a = await scopeCacheSegment({ org_id: 1, brand_ids: ["b1", "b2", "b3"] });
    const b = await scopeCacheSegment({ org_id: 1, brand_ids: ["b1", "b2", "b3", "b4"] });
    expect(a).not.toBe(b);
  });

  it("same org, shuffled / duplicated brand order → same segment", async () => {
    const a = await scopeCacheSegment({ org_id: 7, brand_ids: ["b3", "b1", "b2"] });
    const b = await scopeCacheSegment({ org_id: 7, brand_ids: ["b2", "b3", "b1", "b1"] });
    expect(a).toBe(b);
  });

  it("different org_id with identical brands → different segment", async () => {
    const a = await scopeCacheSegment({ org_id: 1, brand_ids: ["b1", "b2"] });
    const b = await scopeCacheSegment({ org_id: 2, brand_ids: ["b1", "b2"] });
    expect(a).not.toBe(b);
  });

  it("has the documented shape", async () => {
    expect(await scopeCacheSegment({ org_id: 5, brand_ids: [] })).toBe("org:5:none");
    expect(await scopeCacheSegment({ org_id: 5, brand_ids: ["b1"] })).toMatch(/^org:5:[0-9a-f]{16}$/);
  });
});

// ─── 2. Handler-level cross-org isolation ──────────────────────────

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

const BRAND_RE = /^b\d+$/;

/**
 * Stub D1 whose answers are a function of the brand IDs bound to the
 * statement: every `.first()` numeric field equals the number of distinct
 * brand IDs bound, and `.all()` returns one row per bound brand ID. So a
 * response for (b1,b2,b3) is observably different from (b1,b2,b3,b4).
 */
class StubD1 {
  queries = 0;
  private stmt(sql: string, args: unknown[]) {
    const brands = Array.from(new Set(args.filter((a): a is string => typeof a === "string" && BRAND_RE.test(a))));
    const n = brands.length;
    const self = this;
    return {
      bind: (...next: unknown[]) => self.stmt(sql, next),
      first: async () => {
        self.queries++;
        return {
          n, cnt: n, total: n, tracked: n, new_7d: n, active: n, confirmed: n,
          correlated_by_campaign: n, addressed: n, new_24h: n, attributed: n,
        };
      },
      all: async () => {
        self.queries++;
        return {
          results: brands.map((id) => ({
            id, target_brand_id: id, brand_id: id, name: id, brand_name: id,
            count: 1, threat_count: 1, daily_count: 1, day: "2026-10-01",
          })),
          meta: { rows_read: n },
        };
      },
      run: async () => ({ success: true, meta: {} }),
    };
  }
  prepare(sql: string) { return this.stmt(sql, []); }
  withSession() {
    return { prepare: (sql: string) => this.prepare(sql), getBookmark: () => null };
  }
}

const ORG_A: OrgScope = { org_id: 1, brand_ids: ["b1", "b2", "b3"] };
const ORG_B: OrgScope = { org_id: 2, brand_ids: ["b1", "b2", "b3", "b4"] };

function req(path: string): Request {
  return new Request(`https://averrow.test${path}`);
}

async function body<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("org-scoped handler caches do not leak across orgs", () => {
  let kv: MockKV;
  let db: StubD1;
  let env: Env;

  beforeEach(() => {
    kv = new MockKV();
    db = new StubD1();
    env = { CACHE: kv, DB: db } as unknown as Env;
  });

  it("dashboard overview: org B misses org A's entry and gets its own counts", async () => {
    const a = await body<{ data: { brands_tracked: number } }>(
      await handleDashboardOverview(req("/api/dashboard/overview"), env, ORG_A));
    expect(a.data.brands_tracked).toBe(3);
    const afterA = db.queries;

    const b = await body<{ data: { brands_tracked: number } }>(
      await handleDashboardOverview(req("/api/dashboard/overview"), env, ORG_B));
    expect(db.queries).toBeGreaterThan(afterA);          // cache MISS
    expect(b.data.brands_tracked).toBe(4);               // B's data, not A's

    // Same org, shuffled brand order → cache HIT, no new D1 reads.
    const afterB = db.queries;
    const a2 = await body<{ data: { brands_tracked: number } }>(
      await handleDashboardOverview(req("/api/dashboard/overview"), env,
        { org_id: 1, brand_ids: ["b3", "b2", "b1"] }));
    expect(db.queries).toBe(afterB);
    expect(a2.data.brands_tracked).toBe(3);
  });

  it("dashboard overview: empty-scope org is not cached and returns zeros", async () => {
    const res = await body<{ data: { brands_tracked: number } }>(
      await handleDashboardOverview(req("/api/dashboard/overview"), env, { org_id: 9, brand_ids: [] }));
    expect(res.data.brands_tracked).toBe(0);
    expect(kv.store.size).toBe(0);
  });

  it("dashboard overview: global (null scope) key stays `dashboard_overview:global`", async () => {
    await handleDashboardOverview(req("/api/dashboard/overview"), env, null);
    expect(kv.store.has("dashboard_overview:global")).toBe(true);
  });

  it("dashboard top-brands: org B misses org A's entry", async () => {
    const a = await body<{ data: unknown[] }>(
      await handleDashboardTopBrands(req("/api/dashboard/top-brands?limit=10"), env, ORG_A));
    expect(a.data).toHaveLength(3);
    const b = await body<{ data: unknown[] }>(
      await handleDashboardTopBrands(req("/api/dashboard/top-brands?limit=10"), env, ORG_B));
    expect(b.data).toHaveLength(4);
  });

  it("brands list (default view): org B misses org A's entry and gets its own brands", async () => {
    const path = "/api/brands?tab=all&sort=threats&limit=50&offset=0";
    const a = await body<{ data: Array<{ id: string }>; total: number }>(
      await handleListBrands(req(path), env, ORG_A));
    expect(a.data.map((r) => r.id)).toEqual(["b1", "b2", "b3"]);
    expect(a.total).toBe(3);

    const b = await body<{ data: Array<{ id: string }>; total: number }>(
      await handleListBrands(req(path), env, ORG_B));
    expect(b.data.map((r) => r.id)).toEqual(["b1", "b2", "b3", "b4"]);
    expect(b.total).toBe(4);
  });

  it("brands list (filtered view): org B misses org A's entry", async () => {
    const path = "/api/brands?tab=all&sort=name&limit=50&offset=50&q=acme";
    await handleListBrands(req(path), env, ORG_A);
    const b = await body<{ total: number }>(await handleListBrands(req(path), env, ORG_B));
    expect(b.total).toBe(4);
  });

  it("brands list: global (null scope) default key keeps the `global` suffix", async () => {
    await handleListBrands(req("/api/brands?view=top&limit=8&offset=0&range=7d"), env, null);
    expect(kv.store.has("brand_list:all:threats:8:global")).toBe(true);
  });

  it("threats list: org B misses org A's entry and gets its own rows", async () => {
    const path = "/api/threats?limit=50&offset=0";
    const a = await body<{ data: { threats: Array<{ id: string }>; total: number } }>(
      await handleListThreats(req(path), env, ORG_A));
    expect(a.data.total).toBe(3);
    const b = await body<{ data: { threats: Array<{ id: string }>; total: number } }>(
      await handleListThreats(req(path), env, ORG_B));
    expect(b.data.total).toBe(4);
    expect(b.data.threats.map((t) => t.id)).toEqual(["b1", "b2", "b3", "b4"]);
  });

  it("threatAggregate (cachedValue): org B misses org A's entry", async () => {
    const a = await threatAggregate(env, {}, ORG_A);
    expect(a.total).toBe(3);
    const b = await threatAggregate(env, {}, ORG_B);
    expect(b.total).toBe(4);
  });
});
