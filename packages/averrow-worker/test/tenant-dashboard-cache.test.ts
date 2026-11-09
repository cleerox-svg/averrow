// GET /api/orgs/:orgId/dashboard — perf PR 3.
//
// Pins:
//   1. The social-profile counts are restricted to the ORG's brands before
//      grouping (they used to GROUP BY the whole social_profiles table on
//      every load), on the fully migrated schema: the plan seeks
//      social_profiles by brand_id instead of scanning it, and another org's
//      profiles never leak into the counts.
//   2. The payload is KV-cached (~60s) under a key that carries the route
//      org AND scopeCacheSegment over the org's CURRENT brand set — two orgs
//      never share a key, and adding a brand changes the key at once.

import { describe, it, expect, beforeEach } from "vitest";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import {
  handleTenantDashboard,
  tenantDashboardCacheKey,
  TENANT_DASHBOARD_BRANDS_SQL,
  TENANT_DASHBOARD_TTL_S,
} from "../src/handlers/tenantData";
import { scopeCacheSegment } from "../src/lib/scope-cache-key";
import type { AuthContext } from "../src/middleware/auth";
import type { Env } from "../src/types";

function member(orgId: string): AuthContext {
  return {
    userId: "u_member",
    email: "m@cust.example",
    role: "client",
    orgId,
    orgRole: "viewer",
    embeddedScope: undefined,
    enrollOnly: false,
  };
}

function seed(db: SqliteDb): void {
  db.exec(`
    INSERT INTO brands (id, name, canonical_domain) VALUES
      ('b1', 'One', 'one.example'), ('b2', 'Two', 'two.example'), ('b9', 'Nine', 'nine.example');
    INSERT INTO org_brands (org_id, brand_id) VALUES (7, 'b1'), (7, 'b2'), (8, 'b9');
  `);
  const sp = db.prepare(
    "INSERT INTO social_profiles (id, brand_id, platform, handle, classification, status) VALUES (?, ?, 'twitter', ?, ?, ?)",
  );
  // org 7: b1 → 2 active (1 impersonation) + 1 inactive; b2 → 1 active impersonation.
  sp.run("sp1", "b1", "h1", "official", "active");
  sp.run("sp2", "b1", "h2", "impersonation", "active");
  sp.run("sp3", "b1", "h3", "impersonation", "inactive");
  sp.run("sp4", "b2", "h4", "impersonation", "active");
  // org 8's brand — must never be counted for org 7.
  for (let i = 0; i < 5; i++) sp.run(`sp9_${i}`, "b9", `h9_${i}`, "impersonation", "active");
}

interface DashBody {
  success: boolean;
  data: {
    total_brands: number;
    total_social_profiles: number;
    total_impersonation_alerts: number;
    brands: Array<{ id: string; social_profiles_count: number; impersonation_count: number }>;
  };
}

describe.skipIf(!hasSqlite())("tenant dashboard: org-filtered social_profiles + scoped KV cache", () => {
  let raw: SqliteDb;
  let env: Env;
  let kv: ReturnType<typeof fakeKv>;

  beforeEach(() => {
    raw = openMigratedDb();
    seed(raw);
    kv = fakeKv();
    env = { DB: d1FromSqlite(raw), CACHE: kv } as unknown as Env;
  });

  const load = async (orgId: string) =>
    (await handleTenantDashboard(new Request(`https://averrow.com/api/orgs/${orgId}/dashboard`), env, orgId, member(orgId))).json<DashBody>();

  it("counts only the org's own brands' active profiles", async () => {
    const body = await load("7");
    expect(body.success).toBe(true);
    expect(body.data.total_brands).toBe(2);
    const byId = Object.fromEntries(body.data.brands.map((b) => [b.id, b]));
    expect(byId.b1).toMatchObject({ social_profiles_count: 2, impersonation_count: 1 });
    expect(byId.b2).toMatchObject({ social_profiles_count: 1, impersonation_count: 1 });
    expect(body.data.total_social_profiles).toBe(3);
    expect(body.data.total_impersonation_alerts).toBe(2);
  });

  it("plan: social_profiles is searched by brand_id (no full-table scan / GROUP BY of every brand)", () => {
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${TENANT_DASHBOARD_BRANDS_SQL}`).all(7, 7) as Array<{ detail: string }>)
      .map((r) => r.detail);
    const sp = plan.filter((d) => /social_profiles/.test(d));
    expect(sp.length, plan.join("\n")).toBeGreaterThan(0);
    for (const d of sp) {
      expect(d, plan.join("\n")).toMatch(/^SEARCH social_profiles USING (COVERING )?INDEX \S+ \(brand_id=\?/);
    }
  });

  it("caches the payload ~60s under the org + brand-set key; a repeat load reads KV", async () => {
    expect(TENANT_DASHBOARD_TTL_S).toBe(60);
    await load("7");
    const key = `cv:${await tenantDashboardCacheKey("7", ["b1", "b2"])}`;
    expect(kv.store.has(key)).toBe(true);
    expect(key).toContain(await scopeCacheSegment({ org_id: 7, brand_ids: ["b2", "b1"] }));

    // Out-of-band change inside the TTL: served from cache.
    raw.prepare("UPDATE social_profiles SET status = 'inactive' WHERE id = 'sp4'").run();
    expect((await load("7")).data.total_social_profiles).toBe(3);
  });

  it("two orgs never share a key", async () => {
    await load("7");
    await load("8");
    const keys = [...kv.store.keys()].filter((k) => k.startsWith("cv:tenant_dashboard:"));
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.includes(":7:org:7:"))).toBe(true);
    expect(keys.some((k) => k.includes(":8:org:8:"))).toBe(true);
    // Brand-set digest is order-independent; different sets differ.
    expect(await tenantDashboardCacheKey("7", ["b2", "b1"])).toBe(await tenantDashboardCacheKey("7", ["b1", "b2"]));
    expect(await tenantDashboardCacheKey("7", ["b1"])).not.toBe(await tenantDashboardCacheKey("7", ["b1", "b2"]));
  });

  it("adding a brand to the org changes the key, so the next load is not the stale brand set", async () => {
    expect((await load("7")).data.total_brands).toBe(2);
    raw.exec("INSERT INTO brands (id, name, canonical_domain) VALUES ('b3', 'Three', 'three.example')");
    raw.exec("INSERT INTO org_brands (org_id, brand_id) VALUES (7, 'b3')");
    expect((await load("7")).data.total_brands).toBe(3);
  });

  it("a non-member is refused before any read", async () => {
    const res = await handleTenantDashboard(new Request("https://averrow.com/api/orgs/7/dashboard"), env, "7", member("8"));
    expect(res.status).toBe(403);
    expect([...kv.store.keys()]).toEqual([]);
  });
});
