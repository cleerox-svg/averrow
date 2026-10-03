// Router-level check: the audit-log routes (/api/admin/audit and
// /api/admin/audit/export) are gated on the `view_audit` permission from
// lib/role-permissions.ts, the source of truth for staff permissions.
//
// They used to be requireAdmin, which locked out analyst and the read-only
// auditor even though the matrix grants both `view_audit`. The ops Audit tab
// is gated on the same flag (features/governance/GovernanceWorkspace.tsx).
//
// The harness matches test/dashboard-v1-routes-gate.test.ts. The handlers
// are stubbed so a request that gets past the guard returns a sentinel 200
// without touching AUDIT_DB. The guard runs for real against a signed JWT.

import { describe, it, expect, vi } from "vitest";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { registerAdminRoutes } from "../src/routes/admin";
import { signJWT } from "../src/lib/jwt";
import { roleHasPermission } from "../src/lib/role-permissions";
import type { Env, UserRole } from "../src/types";

const handlerCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/handlers/audit", () => {
  const ok = async (): Promise<Response> => {
    handlerCalls.count++;
    return new Response(JSON.stringify({ success: true, data: "handler-reached" }), { status: 200 });
  };
  return { handleListAuditLog: ok, handleExportAuditLog: ok };
});

const SECRET = "test-secret-audit-routes-permission";

// requireAuth reads `SELECT status FROM users` (must be active) and the
// forced-logout KV key (must be null). Both are stubbed to pass so that
// only the permission check is under test.
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
  registerAdminRoutes(router);
  return router;
}

const PATHS = ["/api/admin/audit", "/api/admin/audit?window=24h", "/api/admin/audit/export"];
const ALLOWED: UserRole[] = ["super_admin", "admin", "analyst", "auditor"];
const DENIED: UserRole[] = ["sales", "support", "billing", "client"];

describe("audit-log routes — gated on view_audit", () => {
  it("the test's role lists match the permission matrix", () => {
    for (const role of ALLOWED) expect(roleHasPermission(role, "view_audit")).toBe(true);
    for (const role of DENIED) expect(roleHasPermission(role, "view_audit")).toBe(false);
  });

  for (const path of PATHS) {
    it(`GET ${path}: no token gets 401 and the handler never runs`, async () => {
      handlerCalls.count = 0;
      const req = new Request(`https://averrow.com${path}`, { method: "GET" });
      const res = (await buildRouter().fetch(req, makeEnv())) as Response;
      expect(res.status).toBe(401);
      expect(handlerCalls.count).toBe(0);
    });

    for (const role of DENIED) {
      it(`GET ${path}: ${role} gets 403 and the handler never runs`, async () => {
        handlerCalls.count = 0;
        const res = (await buildRouter().fetch(await getAs(role, path), makeEnv())) as Response;
        expect(res.status).toBe(403);
        const body = await res.json<{ success: boolean; error: string }>();
        expect(body.success).toBe(false);
        expect(handlerCalls.count).toBe(0);
      });
    }

    for (const role of ALLOWED) {
      it(`GET ${path}: ${role} reaches the handler`, async () => {
        const res = (await buildRouter().fetch(await getAs(role, path), makeEnv())) as Response;
        expect(res.status).toBe(200);
        const body = await res.json<{ success: boolean; data: string }>();
        expect(body.data).toBe("handler-reached");
      });
    }
  }
});
