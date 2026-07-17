import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireStaff, isAuthContext } from "../middleware/auth";
import { handleExportScans, handleExportSignals, handleExportAlerts } from "../handlers/export";
import { handleSTIXExport, handleSTIXIndicators } from "../handlers/stixExport";

export function registerExportRoutes(router: RouterType<IRequest>): void {
  router.get("/api/export/scans", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleExportScans(request, env, ctx.userId);
  });
  router.get("/api/export/signals", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleExportSignals(request, env);
  });
  router.get("/api/export/alerts", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleExportAlerts(request, env);
  });
  router.get("/api/export/stix/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSTIXExport(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
  router.get("/api/export/stix/:brandId/indicators", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSTIXIndicators(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
}
