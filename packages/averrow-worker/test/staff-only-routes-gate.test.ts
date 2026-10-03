// Source-of-truth pin: every staff-only routes file must use
// requireStaff (or stricter — requireAdmin / requireSuperAdmin)
// and never plain requireAuth, since plain requireAuth lets
// role='client' (any tenant user) hit cross-tenant or admin-only
// data.
//
// This test fails when someone adds a `requireAuth(request, env)`
// call to a staff-only routes file. They can fix by either using
// requireStaff (analyst+) or requireAdmin (admin+) per the route's
// access tier. Adding a NEW staff-only routes file means appending
// it to STAFF_ONLY_FILES below.
//
// Tenant routes (tenant.ts) are a separate family, out of scope
// here: every /api/orgs/:orgId/* route is guarded by requireOrgMember
// (route-layer org-isolation backstop, 37f4702), not requireAuth —
// pinned separately by tenant-routes-guard-pin.test.ts. Auth flow
// (auth.ts) legitimately keeps requireAuth.
//
// v3 Phase D D2c follow-up.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { registerThreatActorRoutes } from "../src/routes/threatActors";
import { signJWT } from "../src/lib/jwt";
import type { Env, UserRole } from "../src/types";

// Behavioral pin for the threat-actor routes (below): the handlers are
// stubbed so a request that clears the route guard returns a sentinel 200
// without touching D1. The guard itself runs for real against a signed JWT.
vi.mock("../src/handlers/threatActors", () => {
  const ok = async (): Promise<Response> =>
    new Response(JSON.stringify({ success: true, data: "handler-reached" }), { status: 200 });
  return {
    handleListThreatActors: ok,
    handleThreatActorStats: ok,
    handleGetThreatActor: ok,
    handleThreatActorsByBrand: ok,
    handleThreatActorThreats: ok,
  };
});

const STAFF_ONLY_FILES = [
  "agents.ts",
  "feeds.ts",
  "investigations.ts",
  "email-security.ts",
  "export.ts",
  "spam-trap.ts",
  "search.ts",
  // Cross-tenant: /:id/threats spans ALL brands, /by-brand/:brandId takes
  // any brand id. Tenants use /api/orgs/:orgId/modules/threat-actor.
  "threatActors.ts",
];

const REQUIRE_AUTH_CALL_RE = /\brequireAuth\s*\(\s*request\s*,\s*env\s*\)/g;

describe("staff-only routes — no requireAuth calls", () => {
  for (const file of STAFF_ONLY_FILES) {
    it(`${file} uses requireStaff (or stricter), never requireAuth`, () => {
      const path = resolve(__dirname, "../src/routes", file);
      const src = readFileSync(path, "utf-8");
      const matches = src.match(REQUIRE_AUTH_CALL_RE) ?? [];
      expect(matches, `requireAuth(...) call found in ${file} — staff-only routes must use requireStaff or stricter`).toEqual([]);
    });
  }

  it("each staff-only file imports a role-gating helper", () => {
    for (const file of STAFF_ONLY_FILES) {
      const path = resolve(__dirname, "../src/routes", file);
      const src = readFileSync(path, "utf-8");
      const usesRoleGate =
        src.includes("requireStaff") ||
        src.includes("requireAdmin") ||
        src.includes("requireSuperAdmin");
      expect(usesRoleGate, `${file} imports a role-gating helper`).toBe(true);
    }
  });
});

// ─── Router-level pin: /api/threat-actors* are staff-only ──────────────
// Exercises the real route registrations + requireStaff against signed
// JWTs (harness mirrors test/require-staff-mutation.test.ts). client must
// 403 on every route; analyst / auditor (read-only global seat, level 3)
// / super_admin must reach the handler.

const SECRET = "test-secret-staff-only-routes-gate";

// requireAuth reads `SELECT status FROM users` (must be active) and the
// forced-logout KV key (must be null) — both stubbed permissively so the
// role check is the only thing under test.
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
  registerThreatActorRoutes(router);
  return router;
}

const THREAT_ACTOR_PATHS = [
  "/api/threat-actors",
  "/api/threat-actors/stats",
  "/api/threat-actors/by-brand/brand_other_tenant",
  "/api/threat-actors/ta_123/threats",
  "/api/threat-actors/ta_123",
];

describe("threat-actor routes — staff-only at the router", () => {
  for (const path of THREAT_ACTOR_PATHS) {
    it(`GET ${path} — client gets 403`, async () => {
      const res = (await buildRouter().fetch(await getAs("client", path), makeEnv())) as Response;
      expect(res.status).toBe(403);
      const body = await res.json<{ success: boolean; error: string }>();
      expect(body.success).toBe(false);
      expect(body.error).toBe("Forbidden: insufficient role");
    });

    for (const role of ["analyst", "auditor", "super_admin"] as UserRole[]) {
      it(`GET ${path} — ${role} reaches the handler`, async () => {
        const res = (await buildRouter().fetch(await getAs(role, path), makeEnv())) as Response;
        expect(res.status).toBe(200);
        const body = await res.json<{ success: boolean; data: string }>();
        expect(body.data).toBe("handler-reached");
      });
    }

    it(`GET ${path} — missing token gets 401`, async () => {
      const req = new Request(`https://averrow.com${path}`, { method: "GET" });
      const res = (await buildRouter().fetch(req, makeEnv())) as Response;
      expect(res.status).toBe(401);
    });
  }
});
