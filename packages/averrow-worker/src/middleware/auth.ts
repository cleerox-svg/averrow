// Averrow — Auth Middleware (JWT + RBAC)

import { verifyJWT } from "../lib/jwt";
import { json } from "../lib/cors";
import { logger } from "../lib/logger";
import { roleHasPermission, type StaffPermission } from "../lib/role-permissions";
import { forcedLogoutKey, isForcedOut, parseForcedLogout } from "../lib/forced-logout";
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
   * fall back to a DB lookup. Ignored for staff roles: getOrgScope()
   * returns null for every `isPlatformStaff` role before reading it (PR-F).
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
  /**
   * The token's `sid` claim (sessions.id it was minted for), or null for
   * tokens without one (preview/service tokens, pre-sid tokens). Optional so
   * hand-built contexts in tests and helpers stay valid.
   */
  sessionId?: string | null;
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

  // Forced-logout gate: one KV read carries both the blanket per-user stamp
  // (iat <= ts) and the per-session revocations (sid listed) — see
  // lib/forced-logout.ts. Tokens without a `sid` claim only face the stamp.
  const forced = parseForcedLogout(await env.CACHE.get(forcedLogoutKey(payload.sub)));
  if (isForcedOut(forced, payload.iat, payload.sid)) {
    return json({ success: false, error: "Session invalidated" }, 401, origin);
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
    sessionId: typeof payload.sid === "string" && payload.sid ? payload.sid : null,
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

/**
 * The staff-tier roles `requireStaff` lists. Every role at or above the
 * lowest of these levels is Averrow staff (today: analyst, sales, support,
 * billing, auditor, admin, super_admin); only `client` sits below.
 */
const STAFF_TIER_ROLES = ["analyst", "sales", "support", "billing"] as const satisfies readonly UserRole[];

/** Hierarchy floor for "is Averrow staff". Derived from the same role list
 *  `requireStaff` passes to `requireRole`, so the two can't drift. */
const STAFF_MIN_LEVEL = Math.min(...STAFF_TIER_ROLES.map((r) => ROLE_HIERARCHY[r]));

/**
 * PR-F (owner decision 2026-10-03): true for every Averrow staff role — the
 * exact set `requireStaff` admits (every non-`client` role). Staff are never
 * tenant-affiliated, so on the ops surface they all see ALL platform data:
 * `getOrgScope` / `loadOrgScopeForToken` return null (global) for them, and
 * ops READ paths use this as their single "global" predicate.
 *
 * NOT the tenant-route exemption. `/api/orgs/:orgId/*` (`requireOrgMember`,
 * `verifyOrgAccess`) keep using `hasGlobalReadScope` (super_admin, auditor)
 * — tenant isolation for the customer app is unchanged.
 *
 * Accepts a raw string so handlers that read `users.role` from D1 can call it
 * directly; an unknown value maps to level 0 and fails closed.
 */
export function isPlatformStaff(role: string | null | undefined): boolean {
  if (!role) return false;
  const level = (ROLE_HIERARCHY as Record<string, number | undefined>)[role] ?? 0;
  return level >= STAFF_MIN_LEVEL;
}

/** Every `UserRole` for which `isPlatformStaff` is true — for SQL predicates
 *  that must agree with it (lib/lead-conversion-placeholder.ts). */
export const PLATFORM_STAFF_ROLES: readonly UserRole[] = (Object.keys(ROLE_HIERARCHY) as UserRole[])
  .filter((r) => isPlatformStaff(r));

/** Roles that bypass org-membership checks on the TENANT routes
 *  (`/api/orgs/:orgId/*` — `requireOrgMember`, `verifyOrgAccess`).
 *  super_admin by privilege; auditor as a deliberate read-only global seat.
 *  Ops-surface data scoping uses the wider `isPlatformStaff` instead (PR-F). */
export function hasGlobalReadScope(role: UserRole): boolean {
  return role === "super_admin" || role === "auditor";
}

/** Global-scope roles that have visibility but NO write authority — currently
 *  just the minted `auditor` seat (AUTH_AUDIT_2026-06 / requireStaffMutation).
 *  A WRITE handler whose ONLY org gate is `verifyOrgAccess` must reject these
 *  before mutating: `verifyOrgAccess` now exempts every `hasGlobalReadScope`
 *  role (S3.1), so without this block a read-only auditor would sail past the
 *  org check into the mutation. `super_admin` is deliberately NOT here — it is
 *  a full-privilege seat and keeps its write access. */
export function isReadOnlyGlobalRole(role: UserRole): boolean {
  return role === "auditor";
}

/**
 * Per-handler org-isolation check — the INNER net behind `requireOrgMember`
 * (S3.1: collapsed from 14 verbatim copies across the tenant handlers).
 *
 * Returns `null` when the caller may act on `orgId`, or a human-readable
 * error string (which the caller renders as a 403) when they may not.
 *
 * Exemption uses the single canonical global-read predicate
 * (`hasGlobalReadScope`) — super_admin AND the read-only auditor seat — so
 * the inner net honors auditor exactly as the outer `requireOrgMember` does.
 * Previously each copy exempted only `super_admin`, which 403'd auditor at the
 * handler and contradicted CLAUDE.md §7 ("auditor sees ALL … tenant data").
 *
 * For every non-global role the membership rule is unchanged, byte-for-byte:
 * the caller's JWT-derived active-org scope (`ctx.orgId`) must equal the
 * route's `orgId`; a caller with no org (`orgId === null`) never matches.
 *
 * READ-GUARD SEMANTICS: this exempts read-only auditor into the handler.
 * Handlers that WRITE and whose only org gate is this function must ALSO call
 * `isReadOnlyGlobalRole(ctx.role)` and 403 before mutating (see the abuse-
 * mailbox status updaters). Most write handlers already carry a stricter
 * org-role gate (canPerformHITL / canManageAssets / requireOrgAdmin /
 * canMutateAuthorization) that blocks auditor's null org-role independently.
 */
export function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (hasGlobalReadScope(ctx.role)) return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

/**
 * Human-in-the-loop authorization gate — the shared org-role predicate for
 * tenant HITL mutations (status writes, investigation/case edits, abuse-mailbox
 * triage). Analyst+ in the org hierarchy (viewer < analyst < admin < owner);
 * `super_admin` is exempt as a full-privilege seat.
 *
 * Consolidated (follow-up #36) from three byte-identical local copies that had
 * drifted across `handlers/tenantData.ts`, `handlers/tenantInvestigations.ts`,
 * and `handlers/tenantAbuseMailboxModule.ts`. Single source of truth, mirroring
 * the S3.1 `verifyOrgAccess` dedup. Reads the canonical `ORG_ROLE_HIERARCHY`
 * below, so a future threshold tweak can no longer silently diverge per handler.
 *
 * NOTE: unlike `verifyOrgAccess`, `super_admin` is the ONLY global-read role
 * exempted here — `auditor` (read-only) is intentionally NOT: it holds no org
 * role, so `ORG_ROLE_HIERARCHY[null] ?? 0 = 0 < analyst`, and every HITL write
 * stays closed to it. This preserves the old copies' exact truth table.
 */
export function canPerformHITL(ctx: AuthContext): boolean {
  if (ctx.role === "super_admin") return true;
  return (ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0) >= (ORG_ROLE_HIERARCHY["analyst"] ?? 2);
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
  // support, billing, auditor, admin, super_admin. Excludes only 'client'.
  // Shares STAFF_TIER_ROLES with isPlatformStaff so the two can't drift.
  return requireRole(...STAFF_TIER_ROLES)(request, env);
}

/**
 * Require a staff role that is allowed to MUTATE. Runs `requireAuth`
 * first, then rejects the two read-only roles — `auditor` (global
 * read-only seat, AUTH_AUDIT_2026-06) and `client` — with a 403.
 * Everyone else who clears the staff tier (analyst, sales, support,
 * billing, admin, super_admin) passes.
 *
 * This is the mutation-side companion to `requireStaff`: GET routes stay
 * on `requireStaff` (so `auditor` keeps its read visibility), while
 * POST/PUT/PATCH/DELETE routes move to `requireStaffMutation` so the
 * read-only seat can never reach a write path (S2, Phase 1 PR-A).
 *
 * Deliberately NOT implemented by lowering `auditor` in ROLE_HIERARCHY:
 * that would also break its `requireStaff` READ access.
 *
 * Fail-closed by construction: it inherits `requireStaff`'s level>=3 floor
 * (which rejects `client` and any future sub-staff role), then explicitly
 * denies the one read-only role that clears that floor — `auditor`. A new
 * role added below the staff tier is rejected by the floor; a new role added
 * AT the staff tier is admitted only if it is genuinely mutation-capable,
 * which is the correct default (add it to the denylist here if not). This is
 * an allowlist of "cleared staff minus read-only", not a denylist of two
 * hard-coded names.
 */
export async function requireStaffMutation(request: Request, env: Env): Promise<AuthContext | Response> {
  // Inherit the staff floor: rejects client + any sub-staff/unknown role,
  // and applies requireAuth (401 on bad token, enrollment-scope gate, etc.).
  const ctx = await requireStaff(request, env);
  if (!isAuthContext(ctx)) return ctx;
  // Deny the read-only global seat that clears the staff floor.
  if (ctx.role === "auditor") {
    return json({ success: false, error: "Forbidden: read-only role" }, 403, request.headers.get("Origin"));
  }
  return ctx;
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
 * Every Averrow staff role (`isPlatformStaff`) gets null (no filter) — PR-F,
 * owner decision 2026-10-03: staff are never tenant-affiliated and see ALL
 * platform data. The role check runs FIRST, so a staff token minted before
 * PR-F with an embedded `org_scope` is global immediately. `client` users
 * get their org's brand_ids (unchanged).
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
  // Every staff role sees everything — no brand filter. Checked before the
  // embedded-scope fast path so legacy staff tokens carrying org_scope are
  // ignored rather than honoured.
  if (isPlatformStaff(ctx.role)) return null;

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
 * Returns undefined for every staff role (`isPlatformStaff` — their scope
 * is global by role, so the JWT omits the field). For `client` users it
 * returns their first active org's brand_ids, or `{org_id:0, brand_ids:[]}`
 * when they have no active membership.
 */
export async function loadOrgScopeForToken(
  db: D1Database,
  userId: string,
  role: UserRole,
): Promise<{ org_id: number; brand_ids: string[] } | undefined> {
  // Staff embed no scope (getOrgScope returns null by role).
  if (isPlatformStaff(role)) return undefined;

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
 * the membership check; they are cross-tenant seats by design. Since S3.1
 * the handlers' own `verifyOrgAccess` shares this same `hasGlobalReadScope`
 * exemption, so an `auditor` that passes this guard also passes the inner
 * net on READS — the two layers agree. WRITES stay closed to auditor: each
 * mutation handler either carries a stricter org-role gate auditor fails
 * (canPerformHITL / canManageAssets / canMutateAuthorization /
 * requireOrgAdmin) or, for the two abuse-mailbox status writers whose only
 * org gate is `verifyOrgAccess`, an explicit `isReadOnlyGlobalRole` 403
 * block. The guard is deliberately no stricter than the inner check for
 * real members, and no looser for the global seats it recognizes.
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
 * Org role hierarchy: viewer < analyst < admin < owner.
 * Canonical single source of truth — exported so tenant handlers reuse it
 * (follow-up #36) instead of maintaining scattered local copies.
 */
export const ORG_ROLE_HIERARCHY: Record<string, number> = {
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
