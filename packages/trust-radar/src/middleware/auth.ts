// Trust Radar v2 — Auth Middleware (JWT + RBAC)

import { verifyJWT } from "../lib/jwt";
import { json } from "../lib/cors";
import { logger } from "../lib/logger";
import { roleHasPermission, type StaffPermission } from "../lib/role-permissions";
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
  /**
   * H-3 (AUTH_AUDIT_2026-06): true when the token carries the
   * `passkey_enroll` scope — a privileged user who signed in without a
   * passkey. Only ever true on contexts returned by
   * `requireAuthAllowEnroll`; `requireAuth` (and every guard built on it)
   * rejects these tokens outright, so a normal protected handler never
   * sees `enrollOnly === true`.
   */
  enrollOnly: boolean;
}

/**
 * Validates JWT access token and returns auth context.
 * Checks for forced logout via KV.
 *
 * H-3 (AUTH_AUDIT_2026-06): rejects enrollment-scoped tokens
 * (`scope === 'passkey_enroll'`) with a 403 `passkey_enrollment_required`.
 * Every guard built on `requireAuth` (requireRole/Admin/Staff/Permission)
 * inherits this gate, so a privileged user who signed in without a passkey
 * cannot reach any protected route. Use `requireAuthAllowEnroll` only on
 * the handful of endpoints that must remain reachable to bootstrap a
 * passkey (register begin/finish, /me, logout, passkey list).
 */
export async function requireAuth(
  request: Request,
  env: Env,
): Promise<AuthContext | Response> {
  return requireAuthInternal(request, env, false);
}

/**
 * Like `requireAuth`, but accepts enrollment-scoped tokens. The returned
 * context's `enrollOnly` flag reflects whether the token was enrollment-
 * scoped, so handlers can branch (e.g. /me surfacing `passkey_required`).
 * Wire this ONLY onto passkey-enrollment bootstrap endpoints.
 */
export async function requireAuthAllowEnroll(
  request: Request,
  env: Env,
): Promise<AuthContext | Response> {
  return requireAuthInternal(request, env, true);
}

async function requireAuthInternal(
  request: Request,
  env: Env,
  allowEnroll: boolean,
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

  // H-3: enrollment-scoped tokens may only touch the passkey-bootstrap
  // endpoints. Everything else gets a 403 the SPA turns into a mandatory
  // "set up your passkey to continue" gate.
  const enrollOnly = payload.scope === "passkey_enroll";
  if (enrollOnly && !allowEnroll) {
    return json({ success: false, error: "passkey_enrollment_required" }, 403, origin);
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
    enrollOnly,
  };
}

/**
 * Role hierarchy used by `requireRole(min)` checks.
 *
 *   super_admin (5)
 *   admin       (4)
 *   {analyst, sales, support, billing} all share level (3) — the
 *     "staff" tier. Hierarchy can't capture their differentiated
 *     permission sets (analyst handles alerts but not pricing;
 *     sales edits pricing but not alerts), so callers needing
 *     finer control should use `roleHasPermission()` from
 *     lib/role-permissions.ts.
 *   client      (1) — customer; never satisfies a staff guard.
 */
const ROLE_HIERARCHY: Record<UserRole, number> = {
  super_admin: 5,
  admin:       4,
  analyst:     3,
  sales:       3,
  support:     3,
  billing:     3,
  // Read-only global seat. Sits at the staff tier (3) so it passes
  // requireStaff but NEVER requireAdmin/requireSuperAdmin — it cannot reach
  // any admin-only mutation gate. Its read reach comes from permission flags
  // (read_customers/view_billing/view_audit) + the global org scope below,
  // not from hierarchy level. (AUTH_AUDIT_2026-06)
  auditor:     3,
  client:      1,
};

/** Roles that see ALL tenants' data unfiltered (no brand scoping). super_admin
 *  by privilege; auditor as a deliberate read-only global seat. */
export function hasGlobalReadScope(role: UserRole): boolean {
  return role === "super_admin" || role === "auditor";
}

/**
 * Require a minimum role level. Roles are hierarchical —
 * super_admin can access admin routes, admin can access analyst routes, etc.
 */
export function requireRole(...allowedRoles: UserRole[]) {
  const levels = allowedRoles.map((r) => ROLE_HIERARCHY[r]);
  const minLevel = Math.min(...levels);

  // Footgun guard (O6): requireRole is a MINIMUM-level gate — the bar is the
  // LOWEST-level role listed, and hierarchy means any higher role also passes.
  // So listing roles from different tiers silently widens access: e.g.
  // requireRole("super_admin","client") sets the bar to client(1) and admits
  // EVERYONE, not just super_admins. Listing multiple roles is only meaningful
  // when they share one tier (e.g. the staff quartet at level 3) — a
  // higher-tier role in a multi-role list is always redundant with hierarchy.
  // This warns on a mixed-tier spread so a future miscall surfaces instead of
  // silently opening the gate. Dev-safe: it never changes the computed bar.
  if (allowedRoles.length > 1 && new Set(levels).size > 1) {
    logger.warn("require_role_mixed_tier", {
      roles: allowedRoles,
      min_level: minLevel,
      note: "min-level semantics — lowest listed role sets the bar",
    });
  }

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
 * analyst, sales, support, billing). Anchors the v3 Phase D D2c
 * rebadge gate — staff-only back-office routes use this guard so
 * customer-tenant users (role='client') get a 403 instead of
 * inadvertent ops access.
 *
 * For per-route adoption: replace `requireAuth` with `requireStaff`
 * on any route that should not be reachable by customers. Tenant
 * data routes already enforce org_id scoping in their handlers; the
 * staff guard is the additional protection for genuinely cross-
 * tenant or admin-only surfaces.
 */
export async function requireStaff(request: Request, env: Env): Promise<AuthContext | Response> {
  // Any role at hierarchy level 3+ qualifies — analyst, sales,
  // support, billing, admin, super_admin. Excludes only 'client'.
  return requireRole("analyst", "sales", "support", "billing")(request, env);
}

/**
 * Permission-flavoured guards for the four staff sub-roles. These
 * collapse to a single role check today but exist as named helpers
 * so call sites read intent ("require sales access") rather than
 * the literal role list. As permission semantics evolve into a
 * finer-grained matrix, these functions become the single
 * call-site each route needs to update.
 *
 * Convention: super_admin + admin always satisfy any specialty
 * guard (they can do everything a sub-role can do).
 */
export async function requireSales(request: Request, env: Env): Promise<AuthContext | Response> {
  const ctx = await requireAuth(request, env);
  if (!isAuthContext(ctx)) return ctx;
  if (ctx.role === "super_admin" || ctx.role === "admin" || ctx.role === "sales") return ctx;
  return json({ success: false, error: "Forbidden: requires sales role or higher" }, 403, request.headers.get("Origin"));
}

export async function requireSupport(request: Request, env: Env): Promise<AuthContext | Response> {
  const ctx = await requireAuth(request, env);
  if (!isAuthContext(ctx)) return ctx;
  if (ctx.role === "super_admin" || ctx.role === "admin" || ctx.role === "support" || ctx.role === "analyst") return ctx;
  return json({ success: false, error: "Forbidden: requires support role or higher" }, 403, request.headers.get("Origin"));
}

export async function requireBilling(request: Request, env: Env): Promise<AuthContext | Response> {
  const ctx = await requireAuth(request, env);
  if (!isAuthContext(ctx)) return ctx;
  if (ctx.role === "super_admin" || ctx.role === "admin" || ctx.role === "billing") return ctx;
  return json({ success: false, error: "Forbidden: requires billing role or higher" }, 403, request.headers.get("Origin"));
}

/**
 * Permission-matrix guard (M4, 2026-06-10 audit). Gates a route on a
 * single StaffPermission flag from lib/role-permissions.ts — the
 * single source of truth for WHO can do WHAT. Prefer this over the
 * role-name guards above when multiple sub-roles legitimately share
 * an endpoint (e.g. pricing: sales AND billing both hold
 * `edit_pricing`).
 *
 * super_admin + admin satisfy every permission via their full-grant
 * rows in ROLE_PERMISSIONS, so the "admins can do everything"
 * convention holds without a special case here.
 *
 * Usage:
 *   const ctx = await requirePermission("edit_pricing")(request, env);
 *   if (!isAuthContext(ctx)) return ctx;
 */
export function requirePermission(permission: StaffPermission) {
  return async (request: Request, env: Env): Promise<AuthContext | Response> => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    if (!roleHasPermission(ctx.role, permission)) {
      return json(
        { success: false, error: `Forbidden: requires '${permission}' permission` },
        403,
        request.headers.get("Origin"),
      );
    }
    return ctx;
  };
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
  // Global-read roles (super_admin, auditor) see everything — no brand filter.
  if (hasGlobalReadScope(ctx.role)) return null;

  // Fast path: JWT-embedded scope (zero D1 queries).
  if (ctx.embeddedScope !== undefined) {
    return ctx.embeddedScope;
  }

  // Legacy fallback: 2 D1 queries. Removed once all tokens have rotated
  // through a refresh after Fix 4 ships (max 30m for access tokens,
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
  // Global-read roles embed no scope (getOrgScope returns null by role).
  if (hasGlobalReadScope(role)) return undefined;

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
 * Route-layer org-membership backstop for `/api/orgs/:orgId/*` tenant
 * routes. Runs `requireAuth` first, then confirms the caller belongs to
 * the org named in the route param before the handler runs.
 *
 * This is defense-in-depth: the per-handler `verifyOrgAccess` /
 * `requireOrgAdmin` checks stay in place as the inner net. This guard is
 * the enforced outer net so a handler that forgets its own check can't
 * leak cross-org data.
 *
 * Membership source: the JWT-derived `ctx.orgId` session scope — the
 * SAME authoritative source every downstream handler compares against
 * (`verifyOrgAccess`/`requireOrgAdmin` both test `ctx.orgId !== orgId`
 * as strings). Keeping the same source guarantees the guard never
 * disagrees with the handler on the common path.
 *
 * Global-read roles (super_admin, auditor — `hasGlobalReadScope`) bypass
 * the membership check; they are cross-tenant seats by design. Note the
 * handlers' own `verifyOrgAccess` only exempts `super_admin`, so an
 * `auditor` that passes this guard is still gated at the handler — the
 * guard is deliberately no stricter than the inner check for real
 * members, and no looser for the global seats it recognizes.
 */
export async function requireOrgMember(
  request: Request & { params?: Record<string, string> },
  env: Env,
  orgIdParam: string = "orgId",
): Promise<AuthContext | Response> {
  const ctx = await requireAuth(request, env);
  if (!isAuthContext(ctx)) return ctx;

  // Global-scope roles (super_admin, auditor) reach any org by design.
  if (hasGlobalReadScope(ctx.role)) return ctx;

  const orgId = request.params?.[orgIdParam];
  if (!orgId) {
    return json({ success: false, error: "Missing organization ID" }, 400, request.headers.get("Origin"));
  }

  // ctx.orgId is the caller's single active-org scope from the JWT.
  // A user with no org (orgId === null) never matches and is rejected.
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
