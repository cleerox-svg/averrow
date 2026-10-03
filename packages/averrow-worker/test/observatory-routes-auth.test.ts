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
//   4. The route table registers exactly the seven known paths, so a
//      new observatory route can't slip in without this test noticing.

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
] as const;

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
      return key.startsWith("observatory_") ? LEAKY_CACHED : null;
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
    it(`${path.split("?")[0]} rejects anonymous callers 401 without running the handler`, async () => {
      const h = makeHarness();
      const res = await call(path, h.env);
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).not.toContain("Acme");
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect(body).not.toHaveProperty("data");
      expect(h.cacheReads.filter((k) => k.startsWith("observatory_"))).toEqual([]);
    });

    it(`${path.split("?")[0]} rejects a tenant client JWT 403 without running the handler`, async () => {
      const h = makeHarness();
      const res = await call(path, h.env, await bearer("client"));
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain("Acme");
      expect(h.cacheReads.filter((k) => k.startsWith("observatory_"))).toEqual([]);
    });

    it(`${path.split("?")[0]} rejects a forged/invalid token 401`, async () => {
      const h = makeHarness();
      const res = await call(path, h.env, "Bearer not-a-real-jwt");
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("Acme");
    });

    for (const role of ["analyst", "auditor", "super_admin"] as UserRole[]) {
      it(`${path.split("?")[0]} lets staff role '${role}' through to the handler`, async () => {
        const h = makeHarness();
        const res = await call(path, h.env, await bearer(role));
        expect(res.status).toBe(200);
      });
    }
  }

  it("registers exactly the seven known observatory paths, all behind requireStaff", () => {
    const src = readFileSync(resolve(__dirname, "../src/routes/dashboard.ts"), "utf-8");
    const registered = [...src.matchAll(/"(\/api\/observatory\/[a-z-]+)"/g)].map((m) => m[1]).sort();
    expect(registered).toEqual(OBSERVATORY_PATHS.map((p) => p.split("?")[0]).sort());
    // No observatory route may be registered directly against a handler
    // (the pre-fix `router.get("/api/observatory/...", (req, env) => handle…)`).
    expect(src).not.toMatch(/router\.get\(\s*"\/api\/observatory\//);
  });
});
