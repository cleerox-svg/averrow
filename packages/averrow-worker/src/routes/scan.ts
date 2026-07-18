import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireStaff, requireStaffMutation, isAuthContext } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { handleScan, handleScanHistory } from "../handlers/scan";
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

  // ─── Public Scan (unauthenticated, rate-limited) ─────────────────
  router.post("/api/scan/public", async (request: Request, env: Env) => {
    const limited = await rateLimit(request, env, "scan");
    if (limited) return limited;
    return handleScan(request, env);
  });

  // ─── Authenticated Scan ──────────────────────────────────────────
  // Auth is optional here (public scans allowed, rate-limited). When a
  // Bearer token is present, only staff tokens get the scan attributed
  // to their userId (H1, 2026-06-10 audit) — a client-role token is
  // treated like an anonymous caller, not rejected.
  router.post("/api/scan", async (request: Request, env: Env) => {
    const limited = await rateLimit(request, env, "scan");
    if (limited) return limited;
    const authHeader = request.headers.get("Authorization");
    let userId: string | undefined;
    if (authHeader?.startsWith("Bearer ")) {
      const ctx = await requireStaffMutation(request, env);
      if (isAuthContext(ctx)) userId = ctx.userId;
    }
    return handleScan(request, env, userId);
  });

  router.get("/api/scan/history", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleScanHistory(request, env, ctx.userId);
  });

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
