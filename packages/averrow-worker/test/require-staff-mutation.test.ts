// S2 (Phase 1 PR-A): `requireStaffMutation` is the mutation-side companion
// to `requireStaff`. Read routes stay on `requireStaff` (so the read-only
// `auditor` seat keeps its cross-tenant visibility); write routes move to
// `requireStaffMutation`, which rejects `auditor` and `client` with a 403.
//
// This file locks two properties end-to-end against signed JWTs:
//   1. requireStaffMutation admits every mutating staff role, 403s the two
//      read-only roles (auditor, client).
//   2. requireStaff is UNCHANGED — still admits auditor (reads) + all staff,
//      still 403s client.
//
// Harness mirrors the signed-JWT + D1/CACHE stub pattern from
// test/service-jwt-scope.test.ts.

import { describe, it, expect } from "vitest";
import { requireStaff, requireStaffMutation, isAuthContext } from "../src/middleware/auth";
import { signJWT } from "../src/lib/jwt";
import type { Env, UserRole } from "../src/types";

const SECRET = "test-secret-require-staff-mutation";

// requireAuth reads `SELECT status FROM users` (must be active) and checks
// the forced-logout KV key (must be null). Both stubbed permissively so the
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

async function requestAs(role: UserRole): Promise<Request> {
  const token = await signJWT(
    { sub: `user_${role}`, email: `${role}@averrow.local`, role },
    SECRET,
    300,
  );
  return new Request("https://averrow.com/api/some-mutation", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

const MUTATING_STAFF: UserRole[] = ["analyst", "sales", "support", "billing", "admin", "super_admin"];

describe("requireStaffMutation — mutating staff pass, read-only roles 403", () => {
  for (const role of MUTATING_STAFF) {
    it(`admits ${role}`, async () => {
      const result = await requireStaffMutation(await requestAs(role), makeEnv());
      expect(isAuthContext(result)).toBe(true);
      if (isAuthContext(result)) expect(result.role).toBe(role);
    });
  }

  // auditor clears the staff floor (level 3) so the explicit read-only
  // denylist is what stops it — it 403s with the read-only message.
  it("403s auditor with the read-only error", async () => {
    const result = await requireStaffMutation(await requestAs("auditor"), makeEnv());
    expect(isAuthContext(result)).toBe(false);
    const res = result as Response;
    expect(res.status).toBe(403);
    const body = await res.json<{ success: boolean; error: string }>();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Forbidden: read-only role");
  });

  // client sits below the staff floor, so it is now rejected by the
  // inherited requireStaff tier check (allowlist), NOT the read-only denylist.
  it("403s client via the inherited staff floor (insufficient role)", async () => {
    const result = await requireStaffMutation(await requestAs("client"), makeEnv());
    expect(isAuthContext(result)).toBe(false);
    const res = result as Response;
    expect(res.status).toBe(403);
    const body = await res.json<{ success: boolean; error: string }>();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Forbidden: insufficient role");
  });

  it("rejects a missing/invalid token with 401 (inherits requireAuth)", async () => {
    const req = new Request("https://averrow.com/api/some-mutation", { method: "POST" });
    const result = await requireStaffMutation(req, makeEnv());
    expect(isAuthContext(result)).toBe(false);
    expect((result as Response).status).toBe(401);
  });
});

describe("requireStaff — UNCHANGED read gate (auditor keeps read access)", () => {
  for (const role of [...MUTATING_STAFF, "auditor"] as UserRole[]) {
    it(`still admits ${role}`, async () => {
      const result = await requireStaff(await requestAs(role), makeEnv());
      expect(isAuthContext(result)).toBe(true);
    });
  }

  it("still 403s client", async () => {
    const result = await requireStaff(await requestAs("client"), makeEnv());
    expect(isAuthContext(result)).toBe(false);
    expect((result as Response).status).toBe(403);
  });

  it("auditor passes requireStaff (read) but FAILS requireStaffMutation (write) — the split", async () => {
    const read = await requireStaff(await requestAs("auditor"), makeEnv());
    const write = await requireStaffMutation(await requestAs("auditor"), makeEnv());
    expect(isAuthContext(read)).toBe(true);
    expect(isAuthContext(write)).toBe(false);
    expect((write as Response).status).toBe(403);
  });
});
