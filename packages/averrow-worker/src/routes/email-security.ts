import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireStaff, requireStaffMutation, requireAdmin, isAuthContext } from "../middleware/auth";
import {
  handleGetEmailSecurity,
  handleGetEmailSecurityHistory,
  handleScanBrandEmailSecurity,
  handleScanAllEmailSecurity,
  handleEmailSecurityStats,
} from "../handlers/emailSecurity";
import {
  handleGetDmarcOverview,
  handleGetDmarcReports,
  handleGetDmarcStats,
  handleGetDmarcSources,
} from "../handlers/dmarcReports";

export function registerEmailSecurityRoutes(router: RouterType<IRequest>): void {
  // ─── Email Security Posture ───────────────────────────────────────
  router.get("/api/email-security/stats", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleEmailSecurityStats(request, env);
  });
  router.get("/api/email-security/scan-all", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleScanAllEmailSecurity(request, env);
  });
  // Note: /history must be registered BEFORE the bare /:brandId catch-all.
  router.get("/api/email-security/:brandId/history", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetEmailSecurityHistory(request, env, request.params["brandId"] ?? "");
  });
  router.get("/api/email-security/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetEmailSecurity(request, env, request.params["brandId"] ?? "");
  });
  router.post("/api/email-security/scan/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaffMutation(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleScanBrandEmailSecurity(request, env, request.params["brandId"] ?? "");
  });

  // ─── DMARC Report endpoints ───────────────────────────────────────
  // overview must be registered before :brandId to avoid route collision
  router.get("/api/dmarc-reports/overview", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetDmarcOverview(request, env);
  });
  router.get("/api/dmarc-reports/:brandId/stats", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetDmarcStats(request, env, request.params["brandId"] ?? "");
  });
  router.get("/api/dmarc-reports/:brandId/sources", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetDmarcSources(request, env, request.params["brandId"] ?? "");
  });
  router.get("/api/dmarc-reports/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetDmarcReports(request, env, request.params["brandId"] ?? "");
  });
}
