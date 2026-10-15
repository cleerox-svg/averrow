// Pin: every /api/observatory/* route is staff-only.
//
// These routes used to be unauthenticated. `/live` returned the most
// recent malicious domains/URLs together with the targeted brand's
// name, `/arcs` carried `brand_name` per corridor, and
// `/brand-arcs?brand_id=` accepted any brand id — so an anonymous
// caller could learn which customer brands were under attack.
//
// The only legitimate callers are the staff ops SPA (Bearer JWT), the
// frozen legacy SPA (sends its Bearer token), the MCP smoke probe
// (service JWT, `auditor` role) and Navigator's KV pre-warm (calls the
// handlers directly, bypassing the router). No public or tenant
// surface calls them, so each route is wrapped in requireStaff.
//
// What this pins:
//   1. No Authorization header       → 401, and the handler never runs
//      (no `observatory_*` KV read), so a cached staff payload can
//      never be served to an anonymous caller.
//   2. A tenant `client` JWT          → 403, same no-handler guarantee.
//   3. Staff roles (analyst, auditor) → reach the handler (200).
//   4. The route table registers exactly the seventeen known paths, so a
//      new observatory route can't slip in without this test noticing.
//   5. Takedown effectiveness needs `manage_takedowns` (same gate as
//      /api/admin/takedowns/metrics): takedowns-geo is 403 for sales /
//      support / billing / auditor without running the handler, and 200
//      for analyst / admin / super_admin.
//   6. The event rail (/events) is requireStaff only; the route hands the
//      caller's role to the handler, which drops the `takedown` kind (and
//      keys the cache separately) for roles without manage_takedowns.

import { describe, it, expect } from "vitest";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerDashboardRoutes } from "../src/routes/dashboard";
import { signJWT } from "../src/lib/jwt";
import type { Env, JWTPayload, UserRole } from "../src/types";

const SECRET = "test-secret-observatory-routes";

const OBSERVATORY_PATHS = [
  "/api/observatory/nodes?period=7d",
  "/api/observatory/arcs?period=7d",
  "/api/observatory/live?limit=20",
  "/api/observatory/brand-arcs?brand_id=brand_acme&period=7d",
  "/api/observatory/stats?period=7d",
  "/api/observatory/heatmap?period=7d",
  "/api/observatory/operations?limit=5",
  // Phase B lens endpoints (handlers/observatoryLenses.ts)
  "/api/observatory/operations-geo?status=active&limit=10",
  "/api/observatory/movements?period=7d",
  "/api/observatory/providers-geo?limit=50",
  "/api/observatory/overindex?period=7d",
  "/api/observatory/campaigns-geo",
  "/api/observatory/timeline?period=24h",
  "/api/observatory/actors",
  "/api/observatory/actors?actor_id=ta_apt28",
  "/api/observatory/takedowns-geo?period=30d&by=country",
  "/api/observatory/velocity-nodes?period=7d&flag=very_fast",
  // Event rail (handlers/observatoryEvents.ts)
  "/api/observatory/events?period=1h&limit=40",
] as const;

/** Routes that additionally require a StaffPermission (routes/dashboard.ts). */
const PERMISSION_GATED = new Set(["/api/observatory/takedowns-geo"]);

/** Observatory cache keys: Phase A raw `observatory_*` + Phase B cachedValue `cv:observatory_lens.*`. */
const isObservatoryKey = (k: string) => k.startsWith("observatory_") || k.startsWith("cv:observatory_");

// A cached payload that would leak a customer brand if it were ever
// served to the wrong audience. Returned by CACHE.get for every
// `observatory_*` key so the staff path short-circuits on cache.
const LEAKY_CACHED = JSON.stringify({
  success: true,
  data: [{ malicious_domain: "acme-login.example", target_brand: "Acme Corp", brand_name: "Acme Corp" }],
});

interface Harness {
  env: Env;
  cacheReads: string[];
}

function makeHarness(): Harness {
  const cacheReads: string[] = [];

  const stmt = (sql: string) => {
    const bound = {
      async first<T>(): Promise<T | null> {
        if (/FROM users/i.test(sql)) return { status: "active" } as unknown as T;
        if (/FROM brands/i.test(sql)) {
          return { id: "brand_acme", name: "Acme Corp", canonical_domain: "acme.example" } as unknown as T;
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[]; meta: Record<string, unknown> }> {
        return { results: [], meta: {} };
      },
      async run() {
        return { success: true, meta: {} };
      },
    };
    return { bind: () => bound, ...bound };
  };

  const db = {
    prepare: (sql: string) => stmt(sql),
    withSession: () => ({ prepare: (sql: string) => stmt(sql), getBookmark: () => null }),
  };

  const cache = {
    async get(key: string): Promise<string | null> {
      cacheReads.push(key);
      if (key.startsWith("observatory_")) return LEAKY_CACHED;
      if (key.startsWith("cv:observatory_")) return JSON.stringify({ v: JSON.parse(LEAKY_CACHED), t: Date.now() });
      return null;
    },
    async put(): Promise<void> {},
  };

  const env = {
    JWT_SECRET: SECRET,
    DB: db,
    CACHE: cache,
  } as unknown as Env;

  return { env, cacheReads };
}

function makeRouter(): RouterType<IRequest> {
  const router = Router();
  registerDashboardRoutes(router);
  return router;
}

async function bearer(role: UserRole): Promise<string> {
  const payload: Omit<JWTPayload, "iat" | "exp"> = { sub: `u-${role}`, email: `${role}@averrow.com`, role };
  return `Bearer ${await signJWT(payload, SECRET, 300)}`;
}

async function call(path: string, env: Env, auth?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (auth) headers["Authorization"] = auth;
  const res = (await makeRouter().fetch(new Request(`https://averrow.com${path}`, { headers }), env)) as
    | Response
    | undefined;
  if (!res) throw new Error(`no route matched ${path}`);
  return res;
}

describe("/api/observatory/* — staff-only", () => {
  for (const path of OBSERVATORY_PATHS) {
    it(`${path} rejects anonymous callers 401 without running the handler`, async () => {
      const h = makeHarness();
      const res = await call(path, h.env);
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).not.toContain("Acme");
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect(body).not.toHaveProperty("data");
      expect(h.cacheReads.filter(isObservatoryKey)).toEqual([]);
    });

    it(`${path} rejects a tenant client JWT 403 without running the handler`, async () => {
      const h = makeHarness();
      const res = await call(path, h.env, await bearer("client"));
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain("Acme");
      expect(h.cacheReads.filter(isObservatoryKey)).toEqual([]);
    });

    it(`${path} rejects a forged/invalid token 401`, async () => {
      const h = makeHarness();
      const res = await call(path, h.env, "Bearer not-a-real-jwt");
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("Acme");
    });

    const staffRoles: UserRole[] = PERMISSION_GATED.has(path.split("?")[0]!)
      ? ["analyst", "admin", "super_admin"]
      : ["analyst", "auditor", "super_admin"];
    for (const role of staffRoles) {
      it(`${path} lets staff role '${role}' through to the handler`, async () => {
        const h = makeHarness();
        const res = await call(path, h.env, await bearer(role));
        expect(res.status).toBe(200);
      });
    }
  }

  for (const role of ["sales", "support", "billing", "auditor"] as UserRole[]) {
    it(`/api/observatory/takedowns-geo rejects '${role}' (no manage_takedowns) 403 without running the handler`, async () => {
      const h = makeHarness();
      const res = await call("/api/observatory/takedowns-geo?period=30d&by=country", h.env, await bearer(role));
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect(String(body.error)).toContain("manage_takedowns");
      expect(h.cacheReads.filter(isObservatoryKey)).toEqual([]);
    });
  }

  it("providers-geo passes the caller's role: non-holders never read the takedown cache entry", async () => {
    for (const role of ["sales", "support", "billing", "auditor"] as UserRole[]) {
      const h = makeHarness();
      const res = await call("/api/observatory/providers-geo?limit=50", h.env, await bearer(role));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ takedown: unknown }> };
      expect(body.data.every((p) => p.takedown === null)).toBe(true);
      expect(h.cacheReads).toContain("cv:observatory_lens.providers_geo_base:50:bp0");
      expect(h.cacheReads.some((k) => k.includes("providers_geo_takedown"))).toBe(false);
    }
    for (const role of ["analyst", "admin", "super_admin"] as UserRole[]) {
      const h = makeHarness();
      const res = await call("/api/observatory/providers-geo?limit=50", h.env, await bearer(role));
      expect(res.status).toBe(200);
      expect(h.cacheReads).toContain("cv:observatory_lens.providers_geo_takedown:90d");
    }
  });

  it("events passes the caller's role: takedown-less roles read the `g-none` key, holders the `g-takedown` key", async () => {
    for (const role of ["sales", "support", "billing", "auditor"] as UserRole[]) {
      const h = makeHarness();
      const res = await call("/api/observatory/events?period=1h&limit=40", h.env, await bearer(role));
      expect(res.status).toBe(200);
      expect(h.cacheReads.filter(isObservatoryKey)).toEqual(["cv:observatory_events.1h:all:g-none"]);
    }
    for (const role of ["analyst", "admin", "super_admin"] as UserRole[]) {
      const h = makeHarness();
      const res = await call("/api/observatory/events?period=1h&limit=40", h.env, await bearer(role));
      expect(res.status).toBe(200);
      expect(h.cacheReads.filter(isObservatoryKey)).toEqual(["cv:observatory_events.1h:all:g-takedown"]);
    }
  });

  it("takedowns-geo is the only permission-gated observatory route, gated on manage_takedowns", () => {
    const src = readFileSync(resolve(__dirname, "../src/routes/dashboard.ts"), "utf-8");
    const gated = [...src.matchAll(/\["(\/api\/observatory\/[a-z-]+)",\s*\w+,\s*"([a-z_]+)"\]/g)].map((m) => [m[1], m[2]]);
    expect(gated).toEqual([["/api/observatory/takedowns-geo", "manage_takedowns"]]);
  });

  it("registers exactly the seventeen known observatory paths, all behind requireStaff", () => {
    const src = readFileSync(resolve(__dirname, "../src/routes/dashboard.ts"), "utf-8");
    const registered = [...src.matchAll(/"(\/api\/observatory\/[a-z-]+)"/g)].map((m) => m[1]).sort();
    expect(registered).toEqual([...new Set(OBSERVATORY_PATHS.map((p) => p.split("?")[0]))].sort());
    // No observatory route may be registered directly against a handler
    // (the pre-fix `router.get("/api/observatory/...", (req, env) => handle…)`).
    expect(src).not.toMatch(/router\.get\(\s*"\/api\/observatory\//);
  });
});
