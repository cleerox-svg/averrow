import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireStaff, isAuthContext } from "../middleware/auth";
import { handleUnifiedSearch } from "../handlers/search";

export function registerSearchRoutes(router: RouterType<IRequest>): void {
  // Unified staff type-ahead search. requireStaff rejects role='client';
  // staff seats see all entities (global scope, no org filter) by design.
  router.get("/api/search", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUnifiedSearch(request, env);
  });
}
