// Trust Radar v2 — Auth Middleware (JWT + RBAC)

import { verifyJWT } from "../lib/jwt";
import { json } from "../lib/cors";
import type { Env, JWTPayload, UserRole } from "../types";

export interface AuthContext {
  userId: string;
  email: string;
  role: UserRole;
  orgId: string | null;
  orgRole: string | null;
  /**
   * Pre-resolved org scope from the JWT payload, if present.
   * `undefined` means the token predates Fix 4 and getOrgScope() must
   * fall back to a DB lookup. `null` is reserved for super_admins via
   * the role check inside getOrgScope().
   */
  embeddedScope: { org_id: number; brand_ids: string[] } | undefined;
}

/**
 * Validates JWT access token and returns auth context.
 * Checks for forced logout via KV.
 */
export async function requireAuth(
  request: Request,
  env: Env,
): Promise<AuthContext | Response> {
  const authHeader = request.headers.get("Authorization");
  const origin = request.headers.get("Origin");

  if (!authHeader?.startsWith("Bearer ")) {
    return json({ success: false, error: "Missing or invalid Authorization header" }, 401, origin);
  }

  const token = authHeader.slice(7);
  const payload = await verifyJWT(token, env.JWT_SECRET);

  if (!payload) {
    return json({ success: false, error: "Invalid or expired token" }, 401, origin);
  }

  // Check for forced logout (admin-initiated session invalidation)
  const forcedAt = await env.CACHE.get(`forced_logout:${payload.sub}`);
  if (forcedAt && payload.iat <= parseInt(forcedAt, 10)) {
    return json({ success: false, error: "Session invalidated by administrator" }, 401, origin);
  }

  // Verify user still active in DB
  const user = await env.DB.prepare("SELECT status FROM users WHERE id = ?")
    .bind(payload.sub).first<{ status: string }>();

  if (!user || user.status !== "active") {
    return json({ success: false, error: "Account is not active" }, 403, origin);
  }

  // Update last_active timestamp (fire-and-forget)
  env.DB.prepare("UPDATE users SET last_active = datetime('now') WHERE id = ?")
    .bind(payload.sub).run().catch(() => {});

  return {
    userId: payload.sub,
    email: payload.email,
    role: payload.role,
    orgId: payload.org_id ?? null,
    orgRole: payload.org_role ?? null,
    embeddedScope: payload.org_scope,
  };
}

/**
 * Role hierarchy: super_admin > admin > analyst > client
 */
const ROLE_HIERARCHY: Record<UserRole, number> = {
  super_admin: 4,
  admin: 3,
  analyst: 2,
  client: 1,
};

/**
 * Require a minimum role level. Roles are hierarchical —
 * super_admin can access admin routes, admin can access analyst routes, etc.
 */
export function requireRole(...allowedRoles: UserRole[]) {
  const minLevel = Math.min(...allowedRoles.map((r) => ROLE_HIERARCHY[r]));

  return async (request: Request, env: Env): Promise<AuthContext | Response> => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;

    const userLevel = ROLE_HIERARCHY[ctx.role] ?? 0;
    if (userLevel < minLevel) {
      return json({ success: false, error: "Forbidden: insufficient role" }, 403, request.headers.get("Origin"));
    }

    return ctx;
  };
}

/**
 * Shorthand: require admin or super_admin role.
 */
export async function requireAdmin(request: Request, env: Env): Promise<AuthContext | Response> {
  return requireRole("admin")(request, env);
}

/**
 * Shorthand: require super_admin role.
 */
export async function requireSuperAdmin(request: Request, env: Env): Promise<AuthContext | Response> {
  return requireRole("super_admin")(request, env);
}

/**
 * Shorthand: require any Averrow staff role (super_admin, admin,
 * analyst). Anchors the v3 Phase D D2c rebadge gate — staff-only
 * back-office routes use this guard so customer-tenant users
 * (role='client') get a 403 instead of inadvertent ops access.
 *
 * For per-route adoption: replace `requireAuth` with `requireStaff`
 * on any route that should not be reachable by customers. Tenant
 * data routes already enforce org_id scoping in their handlers; the
 * staff guard is the additional protection for genuinely cross-
 * tenant or admin-only surfaces.
 */
export async function requireStaff(request: Request, env: Env): Promise<AuthContext | Response> {
  return requireRole("analyst")(request, env);
}

export function isAuthContext(val: AuthContext | Response): val is AuthContext {
  return !(val instanceof Response);
}

// ─── Org Scope ─────────────────────────────────────────────────

export interface OrgScope {
  org_id: number;
  brand_ids: string[];
}

/**
 * Resolve the org scope for the authenticated user.
 * Super admins get null (no filter). Brand admins get their org's brand_ids.
 *
 * Hot-path optimization: if the JWT carries org_scope (issued via
 * loadOrgScopeForToken at login/refresh), we return it immediately with
 * zero D1 queries. Older tokens fall back to the DB lookup so this
 * change is safe to roll out without invalidating existing sessions.
 */
export async function getOrgScope(
  ctx: AuthContext,
  db: D1Database,
): Promise<OrgScope | null> {
  if (ctx.role === "super_admin") return null;

  // Fast path: JWT-embedded scope (zero D1 queries).
  if (ctx.embeddedScope !== undefined) {
    return ctx.embeddedScope;
  }

  // Legacy fallback: 2 D1 queries. Removed once all tokens have rotated
  // through a refresh after Fix 4 ships (max 12h for access tokens,
  // 7 days for refresh tokens).
  const membership = await db.prepare(
    "SELECT org_id FROM org_members WHERE user_id = ? AND status = 'active' LIMIT 1"
  ).bind(ctx.userId).first<{ org_id: number }>();

  if (!membership) return { org_id: 0, brand_ids: [] };

  const brands = await db.prepare(
    "SELECT brand_id FROM org_brands WHERE org_id = ?"
  ).bind(membership.org_id).all<{ brand_id: string }>();

  return {
    org_id: membership.org_id,
    brand_ids: brands.results.map((b) => b.brand_id),
  };
}

/**
 * Compute the org scope for embedding in a freshly-issued JWT.
 * Called only at login and refresh — not on the request hot path.
 *
 * Returns null for super_admins (whose scope is implicit by role) and
 * undefined when the user has no active org membership (so the JWT omits
 * the field, matching the legacy code path).
 */
export async function loadOrgScopeForToken(
  db: D1Database,
  userId: string,
  role: UserRole,
): Promise<{ org_id: number; brand_ids: string[] } | undefined> {
  if (role === "super_admin") return undefined;

  const membership = await db.prepare(
    "SELECT org_id FROM org_members WHERE user_id = ? AND status = 'active' LIMIT 1"
  ).bind(userId).first<{ org_id: number }>();

  if (!membership) return { org_id: 0, brand_ids: [] };

  const brands = await db.prepare(
    "SELECT brand_id FROM org_brands WHERE org_id = ?"
  ).bind(membership.org_id).all<{ brand_id: string }>();

  return {
    org_id: membership.org_id,
    brand_ids: brands.results.map((b) => b.brand_id),
  };
}

/**
 * Build a SQL IN clause placeholder for brand_ids filtering.
 * Returns { clause, params } for use in prepared statements.
 */
export function buildBrandFilter(
  scope: OrgScope | null,
  column: string,
): { clause: string; params: string[] } {
  if (!scope) return { clause: "", params: [] };
  if (scope.brand_ids.length === 0) return { clause: `AND ${column} = '__none__'`, params: [] };
  const placeholders = scope.brand_ids.map(() => "?").join(", ");
  return { clause: `AND ${column} IN (${placeholders})`, params: scope.brand_ids };
}

/**
 * Verify authenticated user belongs to a specific org.
 * Superadmins bypass the check.
 */
export async function requireOrgMember(
  request: Request & { params?: Record<string, string> },
  env: Env,
  orgIdParam: string = "orgId",
): Promise<AuthContext | Response> {
  const ctx = await requireAuth(request, env);
  if (!isAuthContext(ctx)) return ctx;

  // Superadmins can access any org
  if (ctx.role === "super_admin") return ctx;

  const orgId = request.params?.[orgIdParam];
  if (!orgId) {
    return json({ success: false, error: "Missing organization ID" }, 400, request.headers.get("Origin"));
  }

  if (ctx.orgId !== orgId) {
    return json({ success: false, error: "Not a member of this organization" }, 403, request.headers.get("Origin"));
  }

  return ctx;
}

/**
 * Org role hierarchy: viewer < analyst < admin < owner
 */
const ORG_ROLE_HIERARCHY: Record<string, number> = {
  viewer: 1,
  analyst: 2,
  admin: 3,
  owner: 4,
};

/**
 * Require a minimum org role level. Superadmins bypass.
 */
export async function requireOrgRole(
  request: Request & { params?: Record<string, string> },
  env: Env,
  minRole: string,
): Promise<AuthContext | Response> {
  const ctx = await requireAuth(request, env);
  if (!isAuthContext(ctx)) return ctx;

  // Superadmins bypass org role check
  if (ctx.role === "super_admin") return ctx;

  const userLevel = ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0;
  const requiredLevel = ORG_ROLE_HIERARCHY[minRole] ?? 0;
  if (userLevel < requiredLevel) {
    return json({ success: false, error: `Requires org role: ${minRole} or higher` }, 403, request.headers.get("Origin"));
  }

  return ctx;
}
