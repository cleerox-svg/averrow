import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireAuth, isAuthContext } from "../middleware/auth";
import {
  handleListThreatActors,
  handleThreatActorStats,
  handleGetThreatActor,
  handleThreatActorsByBrand,
  handleThreatActorThreats,
} from "../handlers/threatActors";

export function registerThreatActorRoutes(router: RouterType<IRequest>): void {
  router.get("/api/threat-actors/stats", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleThreatActorStats(request, env);
  });

  router.get("/api/threat-actors/by-brand/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleThreatActorsByBrand(request, env, request.params["brandId"] ?? "");
  });

  router.get("/api/threat-actors/:id/threats", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleThreatActorThreats(request, env, request.params["id"] ?? "");
  });

  router.get("/api/threat-actors/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetThreatActor(request, env, request.params["id"] ?? "");
  });

  router.get("/api/threat-actors", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListThreatActors(request, env);
  });
}
