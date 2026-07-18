import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireStaff, requireStaffMutation, requireAdmin, isAuthContext } from "../middleware/auth";
import {
  handleListAgents, handleGetAgent, handleTriggerAgent, handleTriggerAllAgents, handleAgentRuns,
  handleAgentTokenUsage, handleListApprovals, handleResolveApproval, handleTrustBotChat,
  handleAgentStats, handleAgentOutputs, handleAgentOutputsByName, handleAgentHealth,
  handleAgentApiUsage, handleAgentConfig,
  handleResetAgentCircuit, handleUpdateAgentThreshold, handleToggleAgent,
} from "../handlers/agents";

export function registerAgentRoutes(router: RouterType<IRequest>): void {
  router.get("/api/agents", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListAgents(request, env);
  });
  router.get("/api/agents/stats", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAgentStats(request, env);
  });
  router.get("/api/admin/agents/api-usage", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAgentApiUsage(request, env);
  });
  router.get("/api/admin/agents/config", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAgentConfig(request, env);
  });
  router.get("/api/agents/runs", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAgentRuns(request, env);
  });
  router.get("/api/agents/token-usage", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAgentTokenUsage(request, env);
  });
  router.get("/api/agents/outputs", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAgentOutputs(request, env);
  });
  router.get("/api/agents/approvals", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListApprovals(request, env);
  });
  router.get("/api/agents/:name/outputs", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAgentOutputsByName(request, env, request.params["name"] ?? "");
  });
  router.get("/api/agents/:name/health", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAgentHealth(request, env, request.params["name"] ?? "");
  });
  router.get("/api/agents/:name", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetAgent(request, env, request.params["name"] ?? "");
  });
  router.post("/api/agents/trigger-all", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTriggerAllAgents(request, env, ctx.userId);
  });
  router.post("/api/agents/:name/trigger", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTriggerAgent(request, env, request.params["name"] ?? "", ctx.userId);
  });
  router.post("/api/agents/:name/reset-circuit", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleResetAgentCircuit(request, env, request.params["name"] ?? "");
  });
  router.put("/api/agents/:name/threshold", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateAgentThreshold(request, env, request.params["name"] ?? "");
  });
  router.post("/api/agents/:name/toggle", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleToggleAgent(request, env, request.params["name"] ?? "");
  });
  router.post("/api/agents/approvals/:id/resolve", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleResolveApproval(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/trustbot/chat", async (request: Request, env: Env) => {
    const ctx = await requireStaffMutation(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTrustBotChat(request, env, ctx.userId);
  });
}
