// Pins the auth guard on GET /api/signals (appsec, 2026-10).
//
// handleSignals reads the GLOBAL `scans` table — every user's scans plus
// anonymous homepage scans (url, domain, risk) — so the route must reject
// unauthenticated callers (401) and tenant `client` users (403), and admit
// staff, including the read-only `auditor` seat. No first-party UI calls
// this endpoint; if a tenant surface ever needs it, scope the query to the
// caller (scans.user_id) instead of loosening this guard.
//
// Drives the REAL router (registerDashboardRoutes) with signed JWTs, using
// the D1/CACHE stub pattern from test/require-staff-mutation.test.ts.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Router } from "itty-router";
import type { IRequest, RouterType } from "itty-router";
import { registerDashboardRoutes } from "../src/routes/dashboard";
import { signJWT } from "../src/lib/jwt";
import type { Env, UserRole } from "../src/types";

const SECRET = "test-secret-signals-route-gate";

interface Stub {
  env: Env;
  scansQueried: () => boolean;
}

function makeEnv(): Stub {
  const sqls: string[] = [];
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      return {
        bind() {
          return {
            // requireAuth: user must be active.
            async first<T>() {
              return { status: "active" } as unknown as T;
            },
            async run() {
              return { success: true };
            },
            async all<T>() {
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };
  const cache = {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
  };
  return {
    env: { JWT_SECRET: SECRET, DB: db, CACHE: cache } as unknown as Env,
    scansQueried: () => sqls.some((s) => /FROM\s+scans/i.test(s)),
  };
}

function makeRouter(): RouterType<IRequest> {
  const router = Router();
  registerDashboardRoutes(router);
  return router;
}

async function getSignals(role: UserRole | null, stub: Stub): Promise<Response> {
  const headers: Record<string, string> = {};
  if (role) {
    const token = await signJWT(
      { sub: `user_${role}`, email: `${role}@averrow.local`, role },
      SECRET,
      300,
    );
    headers.Authorization = `Bearer ${token}`;
  }
  const req = new Request("https://averrow.com/api/signals?limit=10", { method: "GET", headers });
  const res = (await makeRouter().fetch(req, stub.env)) as Response | undefined;
  if (!res) throw new Error("route did not match");
  return res;
}

describe("GET /api/signals — staff-only guard", () => {
  it("401s with no token and never touches the scans table", async () => {
    const stub = makeEnv();
    const res = await getSignals(null, stub);
    expect(res.status).toBe(401);
    expect(stub.scansQueried()).toBe(false);
  });

  it("403s a tenant client and never touches the scans table", async () => {
    const stub = makeEnv();
    const res = await getSignals("client", stub);
    expect(res.status).toBe(403);
    expect(stub.scansQueried()).toBe(false);
  });

  const STAFF: UserRole[] = ["analyst", "sales", "support", "billing", "auditor", "admin", "super_admin"];
  for (const role of STAFF) {
    it(`admits ${role}`, async () => {
      const stub = makeEnv();
      const res = await getSignals(role, stub);
      expect(res.status).toBe(200);
      const body = await res.json<{ success: boolean; data: unknown[] }>();
      expect(body.success).toBe(true);
      expect(stub.scansQueried()).toBe(true);
    });
  }

  it("source pin: the GET registration goes through requireStaff", () => {
    const src = readFileSync(resolve(__dirname, "../src/routes/dashboard.ts"), "utf-8");
    const block = src.match(/router\.get\("\/api\/signals"[\s\S]*?\}\);/);
    expect(block, "GET /api/signals registration not found").not.toBeNull();
    expect(block?.[0]).toMatch(/requireStaff\(request, env\)/);
  });
});
