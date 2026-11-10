/**
 * The three legacy whole-table threat endpoints are gone (2026-11-10, D1
 * spike follow-up): /api/threats/stats, /api/threats/geo-clusters and
 * /api/threats/attack-flows had no caller in any package (ops, tenant,
 * marketing, MCP, Navigator warms, tests) and each fanned out full scans of
 * `threats` on a cache miss. Pins that no route is registered for them, so
 * a request falls through to `/api/threats/:id` (one primary-key lookup →
 * 404) and that the handlers are no longer exported.
 */

import { describe, it, expect } from "vitest";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { registerThreatRoutes } from "../src/routes/threats";
import * as threatHandlers from "../src/handlers/threats";

const REMOVED = ["/api/threats/stats", "/api/threats/geo-clusters", "/api/threats/attack-flows"];

describe("legacy threat endpoints removed", () => {
  it("registers no exact route for the removed paths", () => {
    const router = Router() as RouterType<IRequest> & { routes: Array<[string, RegExp, unknown[], string]> };
    registerThreatRoutes(router);
    const paths = router.routes.map((r) => r[3]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of REMOVED) expect(paths).not.toContain(p);
    // Live siblings are still registered.
    expect(paths).toContain("/api/threats/aggregate");
    expect(paths).toContain("/api/threats/:id");
  });

  it("no longer exports the removed handlers", () => {
    const names = Object.keys(threatHandlers);
    for (const n of ["handleThreatStats", "handleGeoClusters", "handleAttackFlows"]) {
      expect(names).not.toContain(n);
    }
    expect(names).toContain("handleThreatsAggregate");
  });
});
