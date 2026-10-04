// Averrow — Admin handlers: users
// Split from handlers/admin.ts (S3.4a). Behavior-preserving move.

import { z } from "zod";
import { json, corsHeaders } from "../../lib/cors";
import { audit } from "../../lib/audit";
import type { Env, UserRole, UserStatus } from "../../types";
import { runSyncAgent } from "../../lib/agentRunner";
import { adminClassifyAgent, type AdminClassifyOutput } from "../../agents/admin-classify";
import { callAnthropicJSON } from "../../lib/anthropic";
import { estimateCost } from "../../lib/budgetManager";
import { HOT_PATH_HAIKU } from "../../lib/ai-models";
import { enrichThreatsGeo, PRIVATE_IP_SQL_FILTER } from "../../lib/geoip";
import { fuzzyMatchBrand } from "../../lib/brandDetect";
import { cachedCount } from "../../lib/cached-count";
import { cachedValue } from "../../lib/cached-value";
import { getReadSession, getDbContext } from "../../lib/db";
import { computeFeedSeverity } from "../../lib/feed-severity";
import { isPlatformStaff, type AuthContext } from "../../middleware/auth";
import { ABSOLUTE_SESSION_TTL } from "../../lib/jwt";
import { PLACEHOLDER_EXEMPT_SQL, deactivateUserPlaceholdersStmt } from "../../lib/lead-conversion-placeholder";
import { classifySaasTechnique } from "../../lib/saas-classifier";
import { BudgetManager, type BudgetStatus } from "../../lib/budgetManager";
import {
  buildGeoCubeForHour,
  buildProviderCubeForHour,
  buildBrandCubeForHour,
  buildStatusCubeForHour,
  buildArcsCubeForHour,
  countGeoCubeForHour,
  countProviderCubeForHour,
  countBrandCubeForHour,
  countStatusCubeForHour,
  countArcsCubeForHour,
} from "../../lib/cube-builder";


const UpdateUserSchema = z.object({
  role: z.enum(["super_admin", "admin", "analyst", "client"] as const).optional(),
  status: z.enum(["active", "suspended", "deactivated"] as const).optional(),
});

export async function handleAdminListUsers(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0");
  const roleFilter = url.searchParams.get("role");
  const statusFilter = url.searchParams.get("status");
  const q = url.searchParams.get("q")?.trim() ?? "";

  // Shared WHERE so the total respects the active filters (the old
  // unfiltered COUNT made pagination lie whenever a filter was set).
  let where = " WHERE 1=1";
  const whereParams: unknown[] = [];

  if (roleFilter) {
    where += " AND role = ?";
    whereParams.push(roleFilter);
  }
  if (statusFilter) {
    where += " AND status = ?";
    whereParams.push(statusFilter);
  }
  if (q) {
    where += " AND (email LIKE ? OR name LIKE ?)";
    const like = `%${q.replace(/[%_]/g, "")}%`;
    whereParams.push(like, like);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, email, name, role, status, created_at, last_login, last_active, invited_by
     FROM users${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...whereParams, limit, offset).all();
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users${where}`)
    .bind(...whereParams).first<{ n: number }>();

  return json({ success: true, data: { users: results, total: total?.n ?? 0 } }, 200, origin);
}

export async function handleAdminUpdateUser(
  request: Request,
  env: Env,
  targetUserId: string,
  adminUserId: string,
  adminRole: UserRole,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  const body = await request.json().catch(() => null);
  const parsed = UpdateUserSchema.safeParse(body);
  if (!parsed.success) return json({ success: false, error: parsed.error.flatten().fieldErrors }, 400, origin);

  const { role, status } = parsed.data;
  if (role === undefined && status === undefined) {
    return json({ success: false, error: "Nothing to update" }, 400, origin);
  }

  // Prevent self-demotion for super_admins (safety)
  if (targetUserId === adminUserId && role && role !== adminRole) {
    return json({ success: false, error: "Cannot change your own role" }, 400, origin);
  }

  const current = await env.DB.prepare("SELECT role FROM users WHERE id = ?")
    .bind(targetUserId).first<{ role: string }>();
  if (!current) return json({ success: false, error: "User not found" }, 404, origin);
  const roleChanged = role !== undefined && role !== current.role;

  // Only super_admin may touch a privileged account. Checked against BOTH the
  // requested role and the target's CURRENT role: checking only the new role
  // let an `admin` demote a super_admin (or another admin) to analyst/client.
  // Covers status changes too — an admin suspending/deactivating a
  // super_admin is the same lockout. (Appsec review of #1765.)
  const isPrivileged = (r: string | undefined): boolean => r === "super_admin" || r === "admin";
  if (adminRole !== "super_admin" && (isPrivileged(role) || isPrivileged(current.role))) {
    return json({ success: false, error: "Only super admins can change the role or status of an admin or super_admin account, or assign those roles" }, 403, origin);
  }

  // PR-F — no tenant-affiliated staff (owner decision 2026-10-03). Staff roles
  // see ALL platform data (getOrgScope → null), so a customer org member must
  // never be promoted into one: refuse a non-staff → staff change while the
  // user holds an ACTIVE org_members row (removal flips status to 'removed',
  // organizations.ts). Status-only PATCHes and re-sending the current role
  // never trip this. A lead-conversion placeholder row is exempt only while
  // its user is staff (PLACEHOLDER_EXEMPT_SQL) — here the user is a client,
  // so a leftover placeholder counts as a real membership.
  if (roleChanged && isPlatformStaff(role) && !isPlatformStaff(current.role)) {
    const membership = await env.DB.prepare(
      `SELECT om.org_id FROM org_members om
       WHERE om.user_id = ? AND om.status = 'active' AND NOT (${PLACEHOLDER_EXEMPT_SQL})
       LIMIT 1`,
    ).bind(targetUserId).first<{ org_id: number }>();
    if (membership) {
      return json({
        success: false,
        error: "Cannot assign a staff role to a user who is an active member of a customer organization. Remove them from the organization first; Averrow staff cannot be tenant-affiliated.",
      }, 400, origin);
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  if (role !== undefined) {
    sets.push("role = ?");
    params.push(role);
  }
  if (status !== undefined) {
    sets.push("status = ?");
    params.push(status);
  }

  params.push(targetUserId);
  const updateUser = env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...params);

  // Staff → client: the user's lead-conversion placeholder owner rows would
  // otherwise stay active and, on the next refresh, be embedded as
  // org_id/org_role=owner — a former staff member becoming a customer owner
  // of a real tenant. Deactivate them in the SAME batch as the role write so
  // neither lands without the other.
  const demotedToClient = roleChanged && role === "client" && isPlatformStaff(current.role);
  let placeholdersRemoved = 0;
  if (demotedToClient) {
    const results = await env.DB.batch([updateUser, deactivateUserPlaceholdersStmt(env.DB, targetUserId)]);
    placeholdersRemoved = Number(results[1]?.meta?.changes ?? 0);
  } else {
    await updateUser.run();
  }

  const user = await env.DB.prepare(
    "SELECT id, email, name, role, status, created_at, last_login FROM users WHERE id = ?",
  ).bind(targetUserId).first();

  if (!user) return json({ success: false, error: "User not found" }, 404, origin);

  if (placeholdersRemoved > 0) {
    await audit(env, {
      action: "lead_conversion_placeholder_removed",
      userId: adminUserId,
      resourceType: "user",
      resourceId: targetUserId,
      details: { reason: "staff_demoted_to_client", previous_role: current.role, placeholders_removed: placeholdersRemoved },
      request,
    });
  }

  // A role change alters what every live token for this user may reach (the
  // JWT embeds role + org_scope), so revoke them: requireAuth and the refresh
  // path reject tokens/sessions issued at or before this stamp. Same key and
  // TTL convention as handleForceLogout (sessions.ts) / refresh-reuse.
  //
  // The stamp must postdate the role write (iat comparison), so it runs after
  // it. A KV failure must not turn a committed role change into a 500 the
  // caller retries blind: record it (audit, outcome failure) and return 200
  // with `revocation_pending: true` + a warning so the operator can re-run
  // the force-logout (POST /api/admin/users/:id/force-logout).
  let revocationPending = false;
  if (roleChanged) {
    try {
      await env.CACHE.put(
        `forced_logout:${targetUserId}`,
        String(Math.floor(Date.now() / 1000)),
        { expirationTtl: ABSOLUTE_SESSION_TTL },
      );
    } catch (err) {
      revocationPending = true;
      await audit(env, {
        action: "user_role_change_revocation_failed",
        userId: adminUserId,
        resourceType: "user",
        resourceId: targetUserId,
        details: { new_role: role, previous_role: current.role, error: err instanceof Error ? err.message : String(err) },
        outcome: "failure",
        request,
      });
    }
  }

  await audit(env, {
    action: "user_updated",
    userId: adminUserId,
    resourceType: "user",
    resourceId: targetUserId,
    details: { changes: parsed.data, previous_role: current.role },
    request,
  });

  if (revocationPending) {
    return json({
      success: true,
      data: user,
      revocation_pending: true,
      warning: "Role updated, but existing sessions could not be revoked. Force-logout this user to end their current sessions.",
    }, 200, origin);
  }
  return json({ success: true, data: user }, 200, origin);
}
