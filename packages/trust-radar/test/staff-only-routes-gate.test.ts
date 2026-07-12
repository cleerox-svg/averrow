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

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STAFF_ONLY_FILES = [
  "agents.ts",
  "feeds.ts",
  "investigations.ts",
  "email-security.ts",
  "export.ts",
  "spam-trap.ts",
  "search.ts",
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
