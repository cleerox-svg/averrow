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
import type { AuthContext } from "../../middleware/auth";
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

  // Only super_admin can change roles to/from admin/super_admin
  if (role && (role === "super_admin" || role === "admin") && adminRole !== "super_admin") {
    return json({ success: false, error: "Only super admins can assign admin or super_admin roles" }, 403, origin);
  }

  // Prevent self-demotion for super_admins (safety)
  if (targetUserId === adminUserId && role && role !== adminRole) {
    return json({ success: false, error: "Cannot change your own role" }, 400, origin);
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
  await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();

  const user = await env.DB.prepare(
    "SELECT id, email, name, role, status, created_at, last_login FROM users WHERE id = ?",
  ).bind(targetUserId).first();

  if (!user) return json({ success: false, error: "User not found" }, 404, origin);

  await audit(env, {
    action: "user_updated",
    userId: adminUserId,
    resourceType: "user",
    resourceId: targetUserId,
    details: { changes: parsed.data },
    request,
  });

  return json({ success: true, data: user }, 200, origin);
}
