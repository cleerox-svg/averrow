// PR-F router-level check: org-less staff (and staff holding a legacy JWT
// that embeds an `org_scope`) get the GLOBAL answer from the ops read routes
// that thread `getOrgScope` into their handler — /api/brands, /api/threats,
// /api/threats/aggregate, /api/dashboard/overview, /api/dashboard/top-brands.
//
// Before PR-F only super_admin/auditor got `null`; an org-less admin or
// analyst got `{org_id:0, brand_ids:[]}` and saw an EMPTY platform.
//
// Real router + real guards + real handlers. D1 is a stub that answers
// `users.status = 'active'` for requireAuth and records every bound value,
// so the test can prove no brand filter was bound; KV is in-memory so the
// test can read back the cache key the handler wrote (the `global` segment
// is what Navigator pre-warms — see scope-cache-key.test.ts).

import { describe, it, expect } from "vitest";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { registerBrandRoutes } from "../src/routes/brands";
import { registerThreatRoutes } from "../src/routes/threats";
import { registerDashboardRoutes } from "../src/routes/dashboard";
import { signJWT } from "../src/lib/jwt";
import type { Env, JWTPayload, UserRole } from "../src/types";

const SECRET = "test-secret-platform-staff-ops-routes";
const LEGACY_BRANDS = ["b1", "b2"];

class StubD1 {
  bound: unknown[] = [];
  private stmt(sql: string, args: unknown[]) {
    const self = this;
    return {
      bind: (...next: unknown[]) => {
        self.bound.push(...next);
        return self.stmt(sql, next);
      },
      first: async () => ({
        status: "active",
        n: 5, cnt: 5, total: 5, tracked: 5, new_7d: 5, active: 5, confirmed: 5,
        correlated_by_campaign: 5, addressed: 5, new_24h: 5, attributed: 5,
      }),
      all: async () => ({ results: [], meta: { rows_read: 0 } }),
      run: async () => ({ success: true, meta: {} }),
    };
  }
  prepare(sql: string) { return this.stmt(sql, []); }
  withSession() {
    return { prepare: (sql: string) => this.prepare(sql), getBookmark: () => null };
  }
}

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

function buildRouter(): RouterType<IRequest> {
  const router = Router();
  registerBrandRoutes(router);
  registerThreatRoutes(router);
  registerDashboardRoutes(router);
  return router;
}

interface Caller { label: string; payload: Omit<JWTPayload, "iat" | "exp"> }

function caller(role: UserRole, legacyScope: boolean): Caller {
  const payload: Omit<JWTPayload, "iat" | "exp"> = {
    sub: `u_${role}`, email: `${role}@averrow.local`, role,
  };
  if (legacyScope) {
    payload.org_id = "7";
    payload.org_role = "viewer";
    payload.org_scope = { org_id: 7, brand_ids: LEGACY_BRANDS };
  }
  return { label: legacyScope ? `${role} (legacy JWT with org_scope)` : `org-less ${role}`, payload };
}

const STAFF_CALLERS: Caller[] = [
  caller("admin", false),
  caller("analyst", false),
  caller("sales", false),
  caller("analyst", true),
  caller("admin", true),
];

async function get(path: string, payload: Caller["payload"]): Promise<{ res: Response; db: StubD1; kv: MockKV }> {
  const db = new StubD1();
  const kv = new MockKV();
  const env = { JWT_SECRET: SECRET, DB: db, CACHE: kv } as unknown as Env;
  const token = await signJWT(payload, SECRET, 300);
  const req = new Request(`https://averrow.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const res = (await buildRouter().fetch(req, env)) as Response;
  return { res, db, kv };
}

const ROUTES: Array<{ path: string; key: (keys: string[]) => boolean; desc: string }> = [
  { path: "/api/brands?view=top&limit=8&offset=0&range=7d", desc: "brand_list:all:threats:8:global",
    key: (k) => k.includes("brand_list:all:threats:8:global") },
  { path: "/api/threats?limit=50&offset=0", desc: "threats_list:…:global",
    key: (k) => k.some((x) => x.startsWith("threats_list:") && x.endsWith(":global")) },
  { path: "/api/dashboard/overview", desc: "dashboard_overview:global",
    key: (k) => k.includes("dashboard_overview:global") },
];

describe("PR-F: ops read routes return the global answer to every staff caller", () => {
  for (const c of STAFF_CALLERS) {
    for (const r of ROUTES) {
      it(`${c.label} GET ${r.path} → 200, ${r.desc}, no brand filter bound`, async () => {
        const { res, db, kv } = await get(r.path, c.payload);
        expect(res.status).toBe(200);
        const body = await res.json<{ success: boolean }>();
        expect(body.success).toBe(true);
        const keys = [...kv.store.keys()];
        expect(r.key(keys), `keys written: ${keys.join(", ")}`).toBe(true);
        // No org-scoped key, and the legacy brand ids never reached a query.
        expect(keys.some((k) => k.includes(":org:"))).toBe(false);
        for (const b of LEGACY_BRANDS) expect(db.bound).not.toContain(b);
        expect(db.bound).not.toContain("__none__");
      });
    }

    it(`${c.label} GET /api/dashboard/top-brands and /api/threats/aggregate → 200, no brand filter`, async () => {
      for (const path of ["/api/dashboard/top-brands?limit=10", "/api/threats/aggregate"]) {
        const { res, db, kv } = await get(path, c.payload);
        expect(res.status, path).toBe(200);
        expect([...kv.store.keys()].some((k) => k.includes(":org:")), path).toBe(false);
        for (const b of LEGACY_BRANDS) expect(db.bound, path).not.toContain(b);
      }
    });
  }

  it("client is still refused at requireStaff (403) — tenant users never reach these routes", async () => {
    for (const r of ROUTES) {
      const { res } = await get(r.path, {
        sub: "u_client", email: "c@cust.co", role: "client",
        org_id: "7", org_role: "admin", org_scope: { org_id: 7, brand_ids: LEGACY_BRANDS },
      });
      expect(res.status, r.path).toBe(403);
    }
  });
});
