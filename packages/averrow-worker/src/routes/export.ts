import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireStaff, isAuthContext } from "../middleware/auth";
import { handleExportAlerts } from "../handlers/export";
import { handleSTIXExport, handleSTIXIndicators } from "../handlers/stixExport";

export function registerExportRoutes(router: RouterType<IRequest>): void {
  // /api/export/scans and /api/export/signals exported `scans` rows; both
  // were retired with the URL-scan feature (2026-10-04) and now 404 via the
  // /api/* catch-all. Pinned by test/url-scan-retired.test.ts.
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
