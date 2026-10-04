// PR-F (owner decision 2026-10-03): every Averrow staff role is global on
// the ops surface. A customer's people are always `client` users in the
// tenant app; staff are never tenant-affiliated.
//
// Pins:
//   1. `isPlatformStaff` is exactly the set `requireStaff` admits (driven
//      through the real guard with a signed JWT for every role, so the two
//      cannot drift).
//   2. `getOrgScope` returns null for every staff role — including a token
//      minted before PR-F that still embeds an `org_scope` — WITHOUT a D1
//      read. `client` keeps its scope (embedded fast path + legacy lookup).
//   3. `loadOrgScopeForToken` embeds nothing for staff; `client` unchanged.
//   4. `hasGlobalReadScope` (the TENANT-route exemption) is unchanged:
//      exactly super_admin + auditor.

import { describe, it, expect } from "vitest";
import {
  getOrgScope,
  loadOrgScopeForToken,
  hasGlobalReadScope,
  isPlatformStaff,
  requireStaff,
  isAuthContext,
  type AuthContext,
} from "../src/middleware/auth";
import { signJWT } from "../src/lib/jwt";
import type { Env, UserRole } from "../src/types";

const ALL_ROLES: UserRole[] = [
  "super_admin", "admin", "analyst", "sales", "support", "billing", "auditor", "client",
];
const STAFF_ROLES: UserRole[] = ALL_ROLES.filter((r) => r !== "client");

const EMBEDDED = { org_id: 7, brand_ids: ["b1", "b2"] };

function ctxFor(role: UserRole, embeddedScope: AuthContext["embeddedScope"]): AuthContext {
  return {
    userId: `u_${role}`,
    email: `${role}@averrow.local`,
    role,
    orgId: embeddedScope ? String(embeddedScope.org_id) : null,
    orgRole: embeddedScope ? "viewer" : null,
    embeddedScope,
    enrollOnly: false,
  };
}

/** D1 that fails the test if touched — staff paths must not read D1. */
function forbiddenDb(): D1Database {
  return {
    prepare(sql: string) {
      throw new Error(`unexpected D1 query: ${sql}`);
    },
  } as unknown as D1Database;
}

/** D1 answering the two scope-lookup queries for a member of org 42. */
function memberDb(log: string[]): D1Database {
  return {
    prepare(sql: string) {
      log.push(sql);
      return {
        bind() {
          return {
            async first<T>() {
              return (sql.includes("org_members") ? { org_id: 42 } : null) as unknown as T;
            },
            async all<T>() {
              return { results: [{ brand_id: "bx" }, { brand_id: "by" }] as unknown as T[] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("isPlatformStaff", () => {
  it("is true for every staff role and false for client", () => {
    for (const role of STAFF_ROLES) expect(isPlatformStaff(role), role).toBe(true);
    expect(isPlatformStaff("client")).toBe(false);
  });

  it("fails closed for unknown / empty values (raw users.role strings)", () => {
    expect(isPlatformStaff("owner")).toBe(false);
    expect(isPlatformStaff("viewer")).toBe(false);
    expect(isPlatformStaff("")).toBe(false);
    expect(isPlatformStaff(null)).toBe(false);
    expect(isPlatformStaff(undefined)).toBe(false);
  });

  it("matches requireStaff exactly for every role (no drift)", async () => {
    const SECRET = "test-secret-platform-staff";
    const env = {
      JWT_SECRET: SECRET,
      CACHE: { async get() { return null; } },
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first<T>() { return { status: "active" } as unknown as T; },
                async run() { return { success: true }; },
              };
            },
          };
        },
      },
    } as unknown as Env;
    for (const role of ALL_ROLES) {
      const token = await signJWT({ sub: `u_${role}`, email: "x@y.z", role }, SECRET, 300);
      const req = new Request("https://averrow.com/x", { headers: { Authorization: `Bearer ${token}` } });
      const admitted = isAuthContext(await requireStaff(req, env));
      expect(admitted, role).toBe(isPlatformStaff(role));
    }
  });
});

describe("getOrgScope — PR-F", () => {
  for (const role of STAFF_ROLES) {
    it(`${role}: null with no embedded scope, zero D1 reads`, async () => {
      expect(await getOrgScope(ctxFor(role, undefined), forbiddenDb())).toBeNull();
    });
    it(`${role}: null even when a legacy JWT embeds org_scope`, async () => {
      expect(await getOrgScope(ctxFor(role, EMBEDDED), forbiddenDb())).toBeNull();
    });
  }

  it("client: embedded scope is returned verbatim (fast path unchanged)", async () => {
    expect(await getOrgScope(ctxFor("client", EMBEDDED), forbiddenDb())).toEqual(EMBEDDED);
  });

  it("client: legacy token falls back to the org_members lookup (unchanged)", async () => {
    const log: string[] = [];
    const scope = await getOrgScope(ctxFor("client", undefined), memberDb(log));
    expect(scope).toEqual({ org_id: 42, brand_ids: ["bx", "by"] });
    expect(log.some((q) => q.includes("org_members"))).toBe(true);
  });
});

describe("loadOrgScopeForToken — PR-F", () => {
  for (const role of STAFF_ROLES) {
    it(`${role}: embeds no scope, zero D1 reads`, async () => {
      expect(await loadOrgScopeForToken(forbiddenDb(), `u_${role}`, role)).toBeUndefined();
    });
  }

  it("client: still resolves its org's brands", async () => {
    const log: string[] = [];
    expect(await loadOrgScopeForToken(memberDb(log), "u_client", "client"))
      .toEqual({ org_id: 42, brand_ids: ["bx", "by"] });
  });
});

describe("hasGlobalReadScope — tenant-route exemption is NOT widened", () => {
  it("is exactly super_admin + auditor", () => {
    const globalRoles = ALL_ROLES.filter((r) => hasGlobalReadScope(r));
    expect(globalRoles.sort()).toEqual(["auditor", "super_admin"]);
  });
});
