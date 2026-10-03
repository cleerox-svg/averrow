import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireStaff, isAuthContext } from "../middleware/auth";
import {
  handleListThreatActors,
  handleThreatActorStats,
  handleGetThreatActor,
  handleThreatActorsByBrand,
  handleThreatActorThreats,
} from "../handlers/threatActors";

// Staff-only (analyst+, incl. the read-only `auditor` seat). These routes
// are cross-tenant: `/:id/threats` returns threats across ALL brands and
// `/by-brand/:brandId` accepts any brand id, so a tenant `client` must never
// reach them. Tenants use the org-scoped
// `/api/orgs/:orgId/modules/threat-actor` routes instead. Pinned by
// test/staff-only-routes-gate.test.ts.
export function registerThreatActorRoutes(router: RouterType<IRequest>): void {
  router.get("/api/threat-actors/stats", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleThreatActorStats(request, env);
  });

  router.get("/api/threat-actors/by-brand/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleThreatActorsByBrand(request, env, request.params["brandId"] ?? "");
  });

  router.get("/api/threat-actors/:id/threats", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleThreatActorThreats(request, env, request.params["id"] ?? "");
  });

  router.get("/api/threat-actors/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetThreatActor(request, env, request.params["id"] ?? "");
  });

  router.get("/api/threat-actors", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListThreatActors(request, env);
  });
}
