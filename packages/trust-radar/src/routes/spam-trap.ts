import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireStaff, requireAdmin, isAuthContext } from "../middleware/auth";
import {
  handleSpamTrapStats, handleSpamTrapCaptures, handleSpamTrapCapturesByBrand,
  handleSpamTrapCaptureDetail, handleSpamTrapSources, handleSpamTrapCampaigns,
  handleCreateSpamTrapCampaign, handleExecuteSpamTrapCampaign,
  handleUpdateSpamTrapCampaign, handleSpamTrapAddresses, handleInitialSeed,
  handleRunStrategist, handleSpamTrapReparseAuth, handleSpamTrapSeedingSources,
  handleRetireSeedAddress,
} from "../handlers/spamTrap";

export function registerSpamTrapRoutes(router: RouterType<IRequest>): void {
  router.get("/api/spam-trap/stats", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSpamTrapStats(request, env);
  });
  router.get("/api/spam-trap/captures", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSpamTrapCaptures(request, env);
  });
  router.get("/api/spam-trap/captures/brand/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSpamTrapCapturesByBrand(request, env, request.params["brandId"] ?? "");
  });
  router.get("/api/spam-trap/captures/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSpamTrapCaptureDetail(request, env, request.params["id"] ?? "");
  });
  router.get("/api/spam-trap/sources", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSpamTrapSources(request, env);
  });
  router.get("/api/spam-trap/campaigns", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSpamTrapCampaigns(request, env);
  });
  router.post("/api/spam-trap/campaigns", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreateSpamTrapCampaign(request, env);
  });
  router.post("/api/spam-trap/campaigns/:id/execute", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleExecuteSpamTrapCampaign(request, env, request.params["id"] ?? "");
  });
  router.put("/api/spam-trap/campaigns/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateSpamTrapCampaign(request, env, request.params["id"] ?? "");
  });
  router.get("/api/spam-trap/seeding-sources", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSpamTrapSeedingSources(request, env);
  });
  router.get("/api/spam-trap/addresses", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSpamTrapAddresses(request, env);
  });
  router.post("/api/spam-trap/seed/initial", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleInitialSeed(request, env);
  });
  router.post("/api/spam-trap/strategist/run", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRunStrategist(request, env);
  });
  router.post("/api/spam-trap/reparse-auth", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSpamTrapReparseAuth(request, env);
  });
  // Wave-1 PR-AB: operator-driven REPLANT — soft-retire a dead seed
  // address. Auto-seeder picks up retired locations on its next tick.
  router.post("/api/spam-trap/seeds/:id/retire", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRetireSeedAddress(request, env);
  });
}
