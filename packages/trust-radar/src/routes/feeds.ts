import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireStaff, requireAdmin, isAuthContext } from "../middleware/auth";
import { json } from "../lib/cors";
import {
  handleListFeeds, handleGetFeed, handleUpdateFeed, handleTriggerFeed,
  handleTriggerAll, handleTriggerTier, handleFeedStats, handleIngestionJobs,
  handleResetCircuit, handleFeedQuota, handleFeedsOverview, handleFeedPullHistory,
  handleFeedsAggregateStats, handleUnpauseFeed, handlePauseFeed,
} from "../handlers/feeds";

export function registerFeedRoutes(router: RouterType<IRequest>): void {
  // ─── Feeds page endpoints (aggregated overview) ──────────────
  router.get("/api/feeds/overview", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleFeedsOverview(request, env);
  });
  router.get("/api/feeds/aggregate-stats", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleFeedsAggregateStats(request, env);
  });
  router.get("/api/feeds/:id/history", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleFeedPullHistory(request, env, request.params["id"] ?? "");
  });

  // ─── Existing feed endpoints ─────────────────────────────────
  router.get("/api/feeds", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListFeeds(request, env);
  });
  router.get("/api/feeds/stats", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleFeedStats(request, env);
  });
  router.get("/api/feeds/jobs", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleIngestionJobs(request, env);
  });
  router.get("/api/feeds/quota", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleFeedQuota(request, env);
  });
  router.get("/api/feeds/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetFeed(request, env, request.params["id"] ?? "");
  });
  router.patch("/api/feeds/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateFeed(request, env, request.params["id"] ?? "");
  });
  router.post("/api/feeds/:id/trigger", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTriggerFeed(request, env, request.params["id"] ?? "");
  });
  router.post("/api/feeds/:id/reset", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleResetCircuit(request, env, request.params["id"] ?? "");
  });
  router.post("/api/feeds/:id/unpause", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUnpauseFeed(request, env, request.params["id"] ?? "");
  });
  router.post("/api/feeds/:id/pause", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handlePauseFeed(request, env, request.params["id"] ?? "");
  });
  router.post("/api/feeds", async (request: Request, env: Env) => {
    const origin = request.headers.get("Origin");
    return json({ success: false, error: "Feed creation via API deferred to v2 admin module" }, 501, origin);
  });
  router.delete("/api/feeds/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const origin = request.headers.get("Origin");
    return json({ success: false, error: "Feed deletion via API deferred to v2 admin module" }, 501, origin);
  });
  router.post("/api/feeds/trigger-all", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTriggerAll(request, env);
  });
  router.post("/api/feeds/trigger-tier/:tier", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTriggerTier(request, env, request.params["tier"] ?? "");
  });
}
