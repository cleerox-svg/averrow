// S2 (Phase 1 PR-A) source-of-truth pin: across the seven staff route
// files that carry both reads and writes, every mutating route
// (POST/PUT/PATCH/DELETE) must be guarded by `requireStaffMutation` (or a
// stricter guard — requireAdmin / requireSuperAdmin), NEVER bare
// `requireStaff`. GET routes legitimately stay on `requireStaff` so the
// read-only `auditor` seat keeps its cross-tenant read visibility.
//
// This is a static grep-style pin over the route registration table (same
// technique as staff-only-routes-gate.test.ts and
// tenant-routes-guard-pin.test.ts). It is the mechanism that makes the fix
// durable: it fails the moment someone adds a new write route on bare
// `requireStaff`, or reverts one of the swapped routes — a change tsc can
// never catch, since requireStaff and requireStaffMutation share a
// signature.
//
// requireAuth is a legitimate guard on mutating routes here (e.g. the
// per-user notification write routes in dashboard.ts), so it is NOT flagged
// — only bare `requireStaff` on a mutation is a violation.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Read the whole routes directory rather than a hardcoded list, so a
// newly-added `src/routes/*.ts` that mounts a mutation on bare requireStaff
// can't reopen the auditor-write hole undetected. (Files with no
// requireStaff/mutation routes at all simply contribute no offenders.)
const ROUTE_FILES = readdirSync(resolve(__dirname, "../src/routes")).filter((f) =>
  f.endsWith(".ts"),
);

// Matches every route registration: router.<method>( "<path>" ...  (allows
// whitespace between the method and the paren, e.g. `router.post  (`).
const ROUTE_RE = /router\.(get|post|put|patch|delete)\s*\(\s*["'](\/[^"']+)["']/g;

// Bare requireStaff( — deliberately does NOT match requireStaffMutation(
// (the char after `requireStaff` there is `M`, not `(`).
const BARE_REQUIRE_STAFF_RE = /\brequireStaff\s*\(/;

interface RouteGuard {
  method: string;
  path: string;
  body: string;
}

function parseRoutes(src: string): RouteGuard[] {
  const matches = [...src.matchAll(ROUTE_RE)];
  const results: RouteGuard[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const start = match.index!;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : src.length;
    results.push({
      method: match[1]!.toUpperCase(),
      path: match[2]!,
      body: src.slice(start, end),
    });
  }
  return results;
}

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// The seven mixed read/write staff files migrated in Phase 1 PR-A. Every one
// must still carry a requireStaffMutation call — an anti-revert pin. (The
// directory-wide scan below is what catches a NEW file reopening the hole;
// this list is what catches a swapped file being reverted.)
const REQUIRE_STAFF_MUTATION_ADOPTERS = [
  "brands.ts",
  "dashboard.ts",
  "threats.ts",
  "agents.ts",
  "investigations.ts",
  "email-security.ts",
  "scan.ts",
];

describe("staff mutation routes — no bare requireStaff on a write", () => {
  const parsed = ROUTE_FILES.map((file) => {
    const src = readFileSync(resolve(__dirname, "../src/routes", file), "utf-8");
    return { file, routes: parseRoutes(src), src };
  });

  it("parsed a non-trivial number of routes per file (parser sanity — no vacuous pass)", () => {
    for (const { file, routes } of parsed) {
      expect(routes.length, `${file} parsed too few routes — ROUTE_RE may be stale`).toBeGreaterThanOrEqual(1);
    }
    const total = parsed.reduce((n, p) => n + p.routes.length, 0);
    expect(total).toBeGreaterThanOrEqual(100);
  });

  it("no POST/PUT/PATCH/DELETE route is bound to bare requireStaff", () => {
    const offenders: string[] = [];
    for (const { file, routes } of parsed) {
      for (const r of routes) {
        if (MUTATION_METHODS.has(r.method) && BARE_REQUIRE_STAFF_RE.test(r.body)) {
          offenders.push(`${file}: ${r.method} ${r.path}`);
        }
      }
    }
    expect(
      offenders,
      `Mutation route(s) still on bare requireStaff (must be requireStaffMutation or stricter):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("each migrated file still carries requireStaffMutation (guards against a wholesale revert)", () => {
    const byFile = new Map(parsed.map((p) => [p.file, p.src]));
    const missing = REQUIRE_STAFF_MUTATION_ADOPTERS.filter(
      (file) => !(byFile.get(file) ?? "").includes("requireStaffMutation("),
    );
    expect(
      missing,
      `Migrated file(s) with no requireStaffMutation call — mutation guard was reverted: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("GET routes remain readable by auditor — at least one GET still on bare requireStaff", () => {
    // The read side must NOT have been over-migrated to requireStaffMutation
    // (that would strip auditor's read access). Confirm reads still use
    // requireStaff somewhere.
    const total = parsed.reduce(
      (n, p) => n + p.routes.filter((r) => r.method === "GET" && BARE_REQUIRE_STAFF_RE.test(r.body)).length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(20);
  });
});
