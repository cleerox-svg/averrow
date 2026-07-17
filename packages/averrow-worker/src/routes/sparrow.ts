import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireAdmin, isAuthContext } from "../middleware/auth";
import {
  handleScanCapture, handleScanBatch, handleScanResults,
  handleMaliciousResults, handleProviders,
  handleAssembleEvidence, handleGetEvidence,
  handleResolveProvider, handleGenerateDraft,
} from "../handlers/sparrow";

export function registerSparrowRoutes(router: RouterType<IRequest>): void {
  router.post("/api/admin/sparrow/scan-capture/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleScanCapture(request.params["id"] ?? "")(request, env);
  });

  router.post("/api/admin/sparrow/scan-batch", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleScanBatch(request, env);
  });

  router.get("/api/admin/sparrow/results/:captureId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleScanResults(request.params["captureId"] ?? "")(request, env);
  });

  router.get("/api/admin/sparrow/malicious", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleMaliciousResults(request, env);
  });

  router.get("/api/admin/sparrow/providers", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleProviders(request, env);
  });

  router.post("/api/admin/sparrow/assemble-evidence/:takedownId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAssembleEvidence(request.params["takedownId"] ?? "")(request, env);
  });

  router.get("/api/admin/sparrow/evidence/:takedownId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetEvidence(request.params["takedownId"] ?? "")(request, env);
  });

  router.get("/api/admin/sparrow/resolve-provider/:domain", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleResolveProvider(request.params["domain"] ?? "")(request, env);
  });

  router.post("/api/admin/sparrow/generate-draft/:takedownId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGenerateDraft(request.params["takedownId"] ?? "")(request, env);
  });
}
