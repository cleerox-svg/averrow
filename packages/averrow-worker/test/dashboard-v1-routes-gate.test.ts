// Router-level check: the legacy v1 dashboard aggregates
// (/api/dashboard/stats|sources|trend) and the scan heatmap
// (/api/heatmap) are staff-only.
//
// All four were registered with no auth check. Nothing calls them: ops,
// tenant, marketing, shared, mcp, the worker templates, Navigator and the
// legacy public/app.js were all checked. /api/heatmap also exposes the
// requester-IP geolocation of scan submitters (handlers/scan.ts
// resolveGeo(CF-Connecting-IP)), so these routes are gated rather than
// left public. Public aggregates live at /api/stats/public and
// /api/v1/public/stats.
//
// The harness matches test/staff-only-routes-gate.test.ts. The handlers
// are stubbed so a request that gets past the guard returns a sentinel
// 200 without touching D1. The guard runs for real against a signed JWT.

import { describe, it, expect, vi } from "vitest";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { registerDashboardRoutes } from "../src/routes/dashboard";
import { signJWT } from "../src/lib/jwt";
import type { Env, UserRole } from "../src/types";

const handlerCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/handlers/stats", () => {
  const ok = async (): Promise<Response> => {
    handlerCalls.count++;
    return new Response(JSON.stringify({ success: true, data: "handler-reached" }), { status: 200 });
  };
  return {
    handleStats: ok,
    handleSourceMix: ok,
    handleQualityTrend: ok,
    handlePublicStats: ok,
  };
});

vi.mock("../src/handlers/heatmap", () => ({
  handleHeatmap: async (): Promise<Response> => {
    handlerCalls.count++;
    return new Response(JSON.stringify({ success: true, data: "handler-reached" }), { status: 200 });
  },
}));

const SECRET = "test-secret-dashboard-v1-routes-gate";

// requireAuth reads `SELECT status FROM users` (must be active) and the
// forced-logout KV key (must be null). Both are stubbed to pass so that
// only the role check is under test.
function makeEnv(): Env {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async first<T>() {
              return { status: "active" } as unknown as T;
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  };
  const cache = {
    async get() {
      return null;
    },
    async put() {},
  };
  return { JWT_SECRET: SECRET, DB: db, CACHE: cache } as unknown as Env;
}

async function getAs(role: UserRole, path: string): Promise<Request> {
  const token = await signJWT(
    { sub: `user_${role}`, email: `${role}@averrow.local`, role },
    SECRET,
    300,
  );
  return new Request(`https://averrow.com${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

function buildRouter(): RouterType<IRequest> {
  const router = Router();
  registerDashboardRoutes(router);
  return router;
}

const GATED_PATHS = [
  "/api/dashboard/stats",
  "/api/dashboard/sources",
  "/api/dashboard/trend",
  "/api/heatmap",
  "/api/heatmap?hours=24&filter=phishing",
];

describe("v1 dashboard + scan heatmap routes — staff-only at the router", () => {
  for (const path of GATED_PATHS) {
    it(`GET ${path}: no token gets 401 and the handler never runs`, async () => {
      handlerCalls.count = 0;
      const req = new Request(`https://averrow.com${path}`, { method: "GET" });
      const res = (await buildRouter().fetch(req, makeEnv())) as Response;
      expect(res.status).toBe(401);
      expect(handlerCalls.count).toBe(0);
    });

    it(`GET ${path}: client gets 403 and the handler never runs`, async () => {
      handlerCalls.count = 0;
      const res = (await buildRouter().fetch(await getAs("client", path), makeEnv())) as Response;
      expect(res.status).toBe(403);
      const body = await res.json<{ success: boolean; error: string }>();
      expect(body.success).toBe(false);
      expect(body.error).toBe("Forbidden: insufficient role");
      expect(handlerCalls.count).toBe(0);
    });

    for (const role of ["analyst", "support", "auditor", "admin", "super_admin"] as UserRole[]) {
      it(`GET ${path}: ${role} reaches the handler`, async () => {
        const res = (await buildRouter().fetch(await getAs(role, path), makeEnv())) as Response;
        expect(res.status).toBe(200);
        const body = await res.json<{ success: boolean; data: string }>();
        expect(body.data).toBe("handler-reached");
      });
    }
  }
});
