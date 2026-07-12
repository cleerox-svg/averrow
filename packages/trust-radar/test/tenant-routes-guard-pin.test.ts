// Source-of-truth pin: every /api/orgs/:orgId/* tenant route in
// tenant.ts must be guarded by requireOrgMember (the route-layer
// org-isolation backstop wired in 37f4702), never bare requireAuth.
//
// This is a static grep-style pin over the route registration table
// itself (same technique as staff-only-routes-gate.test.ts), not a
// live-request test — test/tenant-org-member-guard.test.ts already
// covers the runtime 403 behavior of requireOrgMember. This test's
// job is narrower and more mechanical: catch a future revert where
// someone swaps requireOrgMember back to requireAuth on a tenant
// route (or copy-pastes a new route without the guard) — a change
// tsc would never flag, since requireAuth and requireOrgMember have
// compatible signatures.
//
// The one documented exception is POST /api/admin/orgs/:orgId/takedown-
// authorization — it's an /api/admin/* route (not /api/orgs/*), and
// its handler (handleAdminRecordAuthorization) enforces super_admin
// itself, so it intentionally keeps bare requireAuth. The other three
// /api/admin/orgs/* routes (modules write endpoints) use
// requireSuperAdmin. Both are pinned explicitly below so a change to
// either also trips this test.
//
// v3 Phase D D2c follow-up — tenant org-isolation audit (37f4702).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TENANT_ROUTES_PATH = resolve(__dirname, "../src/routes/tenant.ts");

// Matches every route registration: router.<method>("<path>", ...
const ROUTE_RE = /router\.(get|post|put|patch|delete)\(\s*"(\/api\/[^"]+)"/g;

// Matches the first require*(...) guard call inside a handler body.
const GUARD_RE = /\brequire(OrgMember|Auth|SuperAdmin|OrgAdmin)\s*\(/;

interface RouteGuard {
  method: string;
  path: string;
  guard: string | null;
}

function parseRouteGuards(src: string): RouteGuard[] {
  const matches = [...src.matchAll(ROUTE_RE)];
  const results: RouteGuard[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const start = match.index!;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : src.length;
    const body = src.slice(start, end);
    const guardMatch = body.match(GUARD_RE);
    results.push({
      method: match[1]!.toUpperCase(),
      path: match[2]!,
      guard: guardMatch ? guardMatch[1]! : null,
    });
  }
  return results;
}

// The only /api/admin/orgs/* routes that legitimately deviate from
// requireOrgMember, and exactly what each must use instead.
const ADMIN_ORGS_EXCEPTIONS: Record<string, string> = {
  "POST /api/admin/orgs/:orgId/modules": "SuperAdmin",
  "POST /api/admin/orgs/:orgId/sync-plan-modules": "SuperAdmin",
  "POST /api/admin/orgs/sync-all-plan-modules": "SuperAdmin",
  "POST /api/admin/orgs/:orgId/takedown-authorization": "Auth",
};

describe("tenant routes — /api/orgs/:orgId/* guard pin", () => {
  const src = readFileSync(TENANT_ROUTES_PATH, "utf-8");
  const routes = parseRouteGuards(src);

  it("parsed a non-trivial number of route registrations (parser sanity check)", () => {
    // Guards against the regex silently matching nothing (e.g. after
    // a router API change) and every assertion below vacuously passing.
    expect(routes.length).toBeGreaterThanOrEqual(80);
  });

  it("every /api/orgs/:orgId/* route uses requireOrgMember, never requireAuth or anything else", () => {
    const tenantRoutes = routes.filter((r) => r.path.startsWith("/api/orgs/:orgId"));

    expect(tenantRoutes.length).toBeGreaterThanOrEqual(77);

    const offenders = tenantRoutes
      .filter((r) => r.guard !== "OrgMember")
      .map((r) => `${r.method} ${r.path} -> ${r.guard ?? "NO GUARD FOUND"}`);

    expect(
      offenders,
      `Tenant route(s) not guarded by requireOrgMember (defense-in-depth backstop from 37f4702):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every /api/admin/orgs/* route matches the documented exception list exactly", () => {
    const adminOrgsRoutes = routes.filter((r) => r.path.startsWith("/api/admin/orgs"));

    const seen = new Set<string>();
    const offenders: string[] = [];
    for (const r of adminOrgsRoutes) {
      const key = `${r.method} ${r.path}`;
      seen.add(key);
      const expected = ADMIN_ORGS_EXCEPTIONS[key];
      if (expected === undefined) {
        offenders.push(`${key} -> unexpected route not in ADMIN_ORGS_EXCEPTIONS (guard: ${r.guard ?? "NONE"})`);
      } else if (r.guard !== expected) {
        offenders.push(`${key} -> expected require${expected}, found require${r.guard ?? "NONE"}`);
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);

    // Also fail if a documented exception disappeared from the file
    // entirely (route removed/renamed without updating this pin).
    const missing = Object.keys(ADMIN_ORGS_EXCEPTIONS).filter((k) => !seen.has(k));
    expect(missing, `Documented admin/orgs route(s) no longer found in tenant.ts: ${missing.join(", ")}`).toEqual([]);
  });
});
