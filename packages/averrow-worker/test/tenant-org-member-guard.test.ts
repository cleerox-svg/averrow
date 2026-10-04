// Tenant data-isolation backstop — route-layer org-membership guard
// (requireOrgMember) + billing org-admin gate (requireOrgAdmin).
//
// FIX 1: requireOrgMember is the enforced outer net for every
//   /api/orgs/:orgId/* tenant route. The coverage that was missing:
//   a cross-org request (authed as org A, hitting org B's route) must
//   be rejected 403 at the route layer, independent of whether the
//   downstream handler remembers its own verifyOrgAccess check.
//
// FIX 2: billing checkout/portal now require org-admin (not any member),
//   so a viewer can no longer open the Stripe portal to cancel/see
//   invoices. Enforced via the same requireOrgAdmin used by the
//   api-keys/integrations handlers.

import { describe, it, expect } from "vitest";
import {
  requireOrgMember,
  isAuthContext,
  type AuthContext,
} from "../src/middleware/auth";
import { requireOrgAdmin } from "../src/handlers/organizations";
import {
  handleCreateCheckoutSession,
  handleCreatePortalSession,
} from "../src/handlers/tenantBilling";
import { signJWT } from "../src/lib/jwt";
import type { Env, JWTPayload, UserRole } from "../src/types";

const SECRET = "test-secret-org-member-guard";

// ─── Minimal env that satisfies requireAuth ──────────────────────
// requireAuth: reads CACHE (forced_logout), SELECTs users.status,
// fires a best-effort last_active UPDATE.
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

async function makeRequest(
  payload: Omit<JWTPayload, "iat" | "exp">,
  params: Record<string, string>,
): Promise<Request & { params?: Record<string, string> }> {
  const token = await signJWT(payload, SECRET, 300);
  const req = new Request("https://averrow.com/api/orgs/x", {
    headers: { Authorization: `Bearer ${token}` },
  }) as Request & { params?: Record<string, string> };
  // itty-router attaches route params on the request; emulate that.
  return Object.assign(req, { params });
}

describe("requireOrgMember — route-layer org isolation backstop", () => {
  it("rejects a cross-org request 403 (authed as org A, hitting org B)", async () => {
    const env = makeEnv();
    const req = await makeRequest(
      { sub: "u-a", email: "a@a.co", role: "client", org_id: "10", org_role: "admin" },
      { orgId: "20" }, // org B
    );
    const result = await requireOrgMember(req, env);
    expect(isAuthContext(result)).toBe(false);
    expect((result as Response).status).toBe(403);
    const body = await (result as Response).json<{ error: string }>();
    expect(body.error).toMatch(/Not a member of this organization/);
  });

  it("allows a same-org member through (common path unchanged)", async () => {
    const env = makeEnv();
    const req = await makeRequest(
      { sub: "u-a", email: "a@a.co", role: "client", org_id: "42", org_role: "viewer" },
      { orgId: "42" },
    );
    const result = await requireOrgMember(req, env);
    expect(isAuthContext(result)).toBe(true);
    expect((result as AuthContext).orgId).toBe("42");
    expect((result as AuthContext).userId).toBe("u-a");
  });

  it("lets super_admin reach any org (global scope)", async () => {
    const env = makeEnv();
    const req = await makeRequest(
      { sub: "root", email: "root@averrow.com", role: "super_admin" },
      { orgId: "999" },
    );
    const result = await requireOrgMember(req, env);
    expect(isAuthContext(result)).toBe(true);
    expect((result as AuthContext).role).toBe("super_admin");
  });

  it("lets the global-read auditor seat through the membership check", async () => {
    const env = makeEnv();
    const req = await makeRequest(
      { sub: "aud", email: "aud@averrow.com", role: "auditor" as UserRole },
      { orgId: "999" },
    );
    const result = await requireOrgMember(req, env);
    expect(isAuthContext(result)).toBe(true);
  });

  it("rejects a user with no org membership (org_id absent) 403", async () => {
    const env = makeEnv();
    const req = await makeRequest(
      { sub: "orphan", email: "o@o.co", role: "client" },
      { orgId: "42" },
    );
    const result = await requireOrgMember(req, env);
    expect(isAuthContext(result)).toBe(false);
    expect((result as Response).status).toBe(403);
  });

  it("400s when the route lacks an :orgId param (misconfigured route)", async () => {
    const env = makeEnv();
    const req = await makeRequest(
      { sub: "u-a", email: "a@a.co", role: "client", org_id: "42" },
      {}, // no orgId
    );
    const result = await requireOrgMember(req, env);
    expect(isAuthContext(result)).toBe(false);
    expect((result as Response).status).toBe(400);
  });
});

// ─── FIX 2: billing management requires org-admin ────────────────

function makeCtx(role: UserRole, orgId: string | null, orgRole: string | null): AuthContext {
  return {
    userId: "u-1",
    email: "u@u.co",
    role,
    orgId,
    orgRole,
    embeddedScope: undefined,
    enrollOnly: false,
  };
}

function billingRequest(): Request {
  return new Request("https://averrow.com/api/orgs/42/billing/checkout-session", {
    method: "POST",
    headers: { Origin: "https://averrow.com" },
  });
}

describe("requireOrgAdmin — billing privilege gate", () => {
  it("denies a viewer (below org-admin)", () => {
    const denied = requireOrgAdmin(makeCtx("client", "42", "viewer"), "42", null);
    expect(denied).not.toBeNull();
    expect((denied as Response).status).toBe(403);
  });

  it("allows an org admin", () => {
    expect(requireOrgAdmin(makeCtx("client", "42", "admin"), "42", null)).toBeNull();
  });

  it("allows an org owner", () => {
    expect(requireOrgAdmin(makeCtx("client", "42", "owner"), "42", null)).toBeNull();
  });

  it("still enforces org membership (cross-org admin denied)", () => {
    const denied = requireOrgAdmin(makeCtx("client", "10", "owner"), "42", null);
    expect(denied).not.toBeNull();
    expect((denied as Response).status).toBe(403);
  });
});

describe("billing handlers — viewer blocked, org-admin passes the gate", () => {
  // STRIPE_API_KEY intentionally unset: an org-admin who passes the gate
  // falls through to the 503 "Stripe is not configured" branch, which
  // proves the privilege check let them past. A viewer never reaches it.
  const env = { DB: {}, CACHE: {} } as unknown as Env;

  it("checkout: viewer gets 403", async () => {
    const res = await handleCreateCheckoutSession(
      billingRequest(), env, "42", makeCtx("client", "42", "viewer"),
    );
    expect(res.status).toBe(403);
  });

  it("checkout: org-admin passes the gate (reaches Stripe-config check)", async () => {
    const res = await handleCreateCheckoutSession(
      billingRequest(), env, "42", makeCtx("client", "42", "admin"),
    );
    expect(res.status).toBe(503);
  });

  it("portal: viewer gets 403", async () => {
    const res = await handleCreatePortalSession(
      billingRequest(), env, "42", makeCtx("client", "42", "viewer"),
    );
    expect(res.status).toBe(403);
  });

  it("portal: org-admin passes the gate (reaches Stripe-config check)", async () => {
    const res = await handleCreatePortalSession(
      billingRequest(), env, "42", makeCtx("client", "42", "admin"),
    );
    expect(res.status).toBe(503);
  });
});

// ─── PR-F: ops-global staff do NOT gain tenant-route reach ───────
// PR-F made every staff role global on the OPS surface (getOrgScope → null
// via isPlatformStaff). The tenant backstop deliberately still uses the
// narrower hasGlobalReadScope (super_admin, auditor), so a non-global staff
// role is blocked on another org's /api/orgs/:orgId/* route exactly as before.
describe("PR-F: non-global staff stay blocked on tenant routes", () => {
  const NON_GLOBAL_STAFF: UserRole[] = ["admin", "analyst", "sales", "support", "billing"];

  for (const role of NON_GLOBAL_STAFF) {
    it(`requireOrgMember: org-less ${role} gets 403 on an org route`, async () => {
      const req = await makeRequest({ sub: `u-${role}`, email: `${role}@averrow.com`, role }, { orgId: "20" });
      const result = await requireOrgMember(req, makeEnv());
      expect(isAuthContext(result)).toBe(false);
      expect((result as Response).status).toBe(403);
    });
  }

  it("requireOrgMember: analyst holding a legacy JWT for org 10 is still 403 on org 20", async () => {
    const req = await makeRequest(
      { sub: "u-an", email: "an@averrow.com", role: "analyst", org_id: "10", org_role: "admin",
        org_scope: { org_id: 10, brand_ids: ["b1"] } },
      { orgId: "20" },
    );
    const result = await requireOrgMember(req, makeEnv());
    expect(isAuthContext(result)).toBe(false);
    expect((result as Response).status).toBe(403);
  });

  it("router: GET /api/orgs/:orgId/takedown-authorization — analyst/admin 403, super_admin/auditor reach the handler", async () => {
    const { Router } = await import("itty-router");
    const { registerTenantRoutes } = await import("../src/routes/tenant");
    const router = Router();
    registerTenantRoutes(router);
    const call = async (role: UserRole): Promise<number> => {
      const token = await signJWT({ sub: `u-${role}`, email: `${role}@averrow.com`, role }, SECRET, 300);
      const req = new Request("https://averrow.com/api/orgs/abc/takedown-authorization", {
        headers: { Authorization: `Bearer ${token}` },
      });
      return ((await router.fetch(req, makeEnv())) as Response).status;
    };
    expect(await call("analyst")).toBe(403);
    expect(await call("admin")).toBe(403);
    // Global-read seats pass both nets; the non-numeric org id then 400s
    // inside the handler — proof the guard let them through.
    expect(await call("super_admin")).toBe(400);
    expect(await call("auditor")).toBe(400);
  });
});
