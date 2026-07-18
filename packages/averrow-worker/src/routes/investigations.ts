import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireStaff, requireStaffMutation, requireAdmin, isAuthContext } from "../middleware/auth";
import {
  handleListTickets, handleGetTicket, handleCreateTicket, handleUpdateTicket,
  handleAddEvidence,
  handleListErasures, handleCreateErasure, handleUpdateErasure,
} from "../handlers/investigations";

export function registerInvestigationRoutes(router: RouterType<IRequest>): void {
  // ─── Investigations ───────────────────────────────────────────────
  router.get("/api/tickets", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListTickets(request, env);
  });
  router.get("/api/tickets/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetTicket(request, env, request.params["id"] ?? "");
  });
  router.post("/api/tickets", async (request: Request, env: Env) => {
    const ctx = await requireStaffMutation(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreateTicket(request, env, ctx.userId);
  });
  router.patch("/api/tickets/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaffMutation(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateTicket(request, env, request.params["id"] ?? "");
  });

  // ─── Evidence Attachment ─────────────────────────────────────────
  router.post("/api/tickets/:id/evidence", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaffMutation(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAddEvidence(request, env, request.params["id"] ?? "", ctx.userId);
  });

  // ─── Erasure Actions (Takedowns) ─────────────────────────────────
  router.get("/api/erasures", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListErasures(request, env);
  });
  router.post("/api/erasures", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreateErasure(request, env, ctx.userId);
  });
  router.patch("/api/erasures/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateErasure(request, env, request.params["id"] ?? "");
  });
}
