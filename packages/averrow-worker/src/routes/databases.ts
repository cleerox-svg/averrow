import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireStaff, isAuthContext } from "../middleware/auth";
import { handleDatabases } from "../handlers/databases";

export function registerDatabaseRoutes(router: RouterType<IRequest>): void {
  // ─── Databases page (ops) — same read gate as /api/feeds*, /api/agents* ──
  router.get("/api/databases", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleDatabases(request, env);
  });
}
