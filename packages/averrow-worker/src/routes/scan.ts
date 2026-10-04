import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireStaff, requireStaffMutation, isAuthContext } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { handleScanReport } from "../handlers/scanReport";
import {
  handleBrandScan, handleBrandScanHistory, handlePublicBrandScan,
  handlePublicBrandScanResult, handleLeadCapture,
} from "../handlers/brandScan";
import { handleHealthCheck } from "../handlers/health";

export function registerScanRoutes(router: RouterType<IRequest>): void {
  // ─── Health ─────────────────────────────────────────────────────
  router.get("/health", (request: Request, env: Env) => handleHealthCheck(request, env));

  // ─── Brand Exposure Report (public, rate-limited) ────────────────
  router.post("/api/scan/report", async (request: Request, env: Env) => {
    const limited = await rateLimit(request, env, "scan_report");
    if (limited) return limited;
    return handleScanReport(request, env);
  });

  // ─── URL scan — retired (2026-10-04) ──────────────────────────────
  // POST /api/scan, POST /api/scan/public and GET /api/scan/history wrote
  // and read the `scans` / `domain_cache` tables, which never existed in
  // prod, so every call failed. The only client was the frozen legacy
  // SPA. The paths now 404 via the /api/* catch-all in routes/public.ts.
  // Pinned by test/url-scan-retired.test.ts.

  // ─── Brand Exposure Engine ────────────────────────────────────────
  router.post("/api/brand-scan", async (request: Request, env: Env) => {
    const ctx = await requireStaffMutation(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBrandScan(request, env, ctx.userId);
  });

  router.get("/api/brand-scan/history", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBrandScanHistory(request, env);
  });

  // Public brand scan (no auth, rate-limited)
  router.post("/api/brand-scan/public", async (request: Request, env: Env) => {
    const limited = await rateLimit(request, env, "scan");
    if (limited) return limited;
    return handlePublicBrandScan(request, env);
  });

  // Public brand scan result lookup (no auth)
  router.get("/api/brand-scan/public/:id", (request: Request & { params: Record<string, string> }, env: Env) =>
    handlePublicBrandScanResult(request, env, request.params["id"] ?? "")
  );

  // Lead capture (no auth, rate-limited)
  router.post("/api/leads", async (request: Request, env: Env) => {
    const limited = await rateLimit(request, env, "auth");
    if (limited) return limited;
    return handleLeadCapture(request, env);
  });
}
