// Averrow — Handler Utilities (Phase 6: Handler Consolidation)
// Eliminates boilerplate origin extraction, try/catch, error responses,
// org access checks, and pagination from every handler.

import { json } from "./cors";
import { logger } from "./logger";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";

/**
 * Sanitize error for client response — never expose stack traces,
 * SQL details, file paths, or env variable names.
 */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    logger.error("handler_error", { message: err.message, stack: err.stack?.substring(0, 500) });
  }
  return "An internal error occurred";
}

// ─── Handler Context Types ──────────────────────────────────────

export interface HandlerContext {
  origin: string | null;
}

export type OrgHandlerContext = AuthContext & HandlerContext;

// ─── Handler Wrappers ───────────────────────────────────────────

/**
 * Standard handler wrapper — eliminates boilerplate origin extraction,
 * try/catch, and error responses from every handler.
 */
export function handler(
  fn: (request: Request, env: Env, ctx: HandlerContext) => Promise<Response>
) {
  return async (request: Request, env: Env): Promise<Response> => {
    const origin = request.headers.get("Origin");
    try {
      return await fn(request, env, { origin });
    } catch (err) {
      return json({ success: false, error: safeErrorMessage(err) }, 500, origin);
    }
  };
}

/**
 * Check org access — returns an error Response if denied, null if allowed.
 * Use this in handlers that can't use the orgHandler wrapper (extra params).
 */
export function checkOrgAccess(ctx: AuthContext, orgId: string, origin: string | null, options?: { minRole?: string }): Response | null {
  if (ctx.role !== "super_admin" && ctx.orgId !== orgId) {
    return json({ success: false, error: "Not a member of this organization" }, 403, origin);
  }
  if (options?.minRole) {
    const hierarchy: Record<string, number> = { viewer: 1, analyst: 2, admin: 3, owner: 4 };
    const required = hierarchy[options.minRole] ?? 0;
    const actual = ctx.role === "super_admin" ? 99 : (hierarchy[ctx.orgRole ?? ""] ?? 0);
    if (actual < required) {
      return json({ success: false, error: `Requires role: ${options.minRole} or higher` }, 403, origin);
    }
  }
  return null;
}

/**
 * Org-scoped handler wrapper — verifies org membership, extracts origin,
 * wraps in try/catch.
 */
export function orgHandler(
  fn: (request: Request, env: Env, orgId: string, ctx: OrgHandlerContext) => Promise<Response>,
  options?: { minRole?: string }
) {
  return async (request: Request, env: Env, orgId: string, ctx: AuthContext): Promise<Response> => {
    const origin = request.headers.get("Origin");
    try {
      if (ctx.role !== "super_admin" && ctx.orgId !== orgId) {
        return json({ success: false, error: "Not a member of this organization" }, 403, origin);
      }
      if (options?.minRole) {
        const hierarchy: Record<string, number> = { viewer: 1, analyst: 2, admin: 3, owner: 4 };
        const required = hierarchy[options.minRole] ?? 0;
        const actual = ctx.role === "super_admin" ? 99 : (hierarchy[ctx.orgRole ?? ""] ?? 0);
        if (actual < required) {
          return json({ success: false, error: `Requires role: ${options.minRole} or higher` }, 403, origin);
        }
      }
      return await fn(request, env, orgId, { ...ctx, origin });
    } catch (err) {
      return json({ success: false, error: safeErrorMessage(err) }, 500, origin);
    }
  };
}


// ─── Pagination ─────────────────────────────────────────────────

/**
 * Parse pagination params from URL — replaces 59 inline implementations.
 */
export function parsePagination(request: Request, defaults?: { limit?: number; maxLimit?: number }): {
  limit: number;
  offset: number;
  page: number;
} {
  const url = new URL(request.url);
  const maxLimit = defaults?.maxLimit ?? 100;
  const defaultLimit = defaults?.limit ?? 50;
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? String(defaultLimit), 10), maxLimit);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const page = Math.floor(offset / limit) + 1;
  return { limit, offset, page };
}

// ─── Filtering ──────────────────────────────────────────────────

/**
 * Parse filter params from URL — common pattern in list handlers.
 */
export function parseFilters(request: Request, allowedFilters: string[]): Record<string, string> {
  const url = new URL(request.url);
  const filters: Record<string, string> = {};
  for (const key of allowedFilters) {
    const val = url.searchParams.get(key);
    if (val) filters[key] = val;
  }
  return filters;
}

/**
 * Build WHERE clause from filters — eliminates repeated condition building.
 */
export function buildWhereClause(filters: Record<string, string>, columnMap: Record<string, string>): {
  clause: string;
  bindings: unknown[];
} {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  for (const [key, value] of Object.entries(filters)) {
    const column = columnMap[key];
    if (column) {
      conditions.push(`${column} = ?`);
      bindings.push(value);
    }
  }
  return {
    clause: conditions.length ? conditions.join(" AND ") : "1=1",
    bindings,
  };
}

// ─── Response Helpers ───────────────────────────────────────────

/**
 * Standard paginated response — replaces repeated response assembly.
 */
export function paginatedResponse<T>(
  data: T[],
  total: number,
  origin: string | null,
  extra?: Record<string, unknown>
): Response {
  return json({ success: true, data, total, ...extra }, 200, origin);
}

/**
 * Parse and validate JSON body with type.
 */
export async function parseBody<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

/**
 * Standard success response.
 */
export function success(data: unknown, origin: string | null, status = 200): Response {
  return json({ success: true, data }, status, origin);
}

/**
 * Standard error response.
 */
export function error(message: string, status: number, origin: string | null): Response {
  return json({ success: false, error: message }, status, origin);
}

/**
 * Require a field exists or return 400.
 */
export function requireFields(body: Record<string, unknown>, fields: string[], origin: string | null): Response | null {
  const missing = fields.filter(f => !body[f]);
  if (missing.length > 0) {
    return json({ success: false, error: `Missing required fields: ${missing.join(", ")}` }, 400, origin);
  }
  return null;
}
