// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Session Handlers

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import type { Env } from "../types";

// ─── Admin: list active sessions ─────────────────────────────────

export async function handleListSessionEvents(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const userId = url.searchParams.get("user_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  let sql = `SELECT s.id, s.user_id, s.issued_at, s.expires_at, s.revoked_at, s.ip_address, s.user_agent,
                    u.email
             FROM sessions s
             LEFT JOIN users u ON u.id = s.user_id
             WHERE 1=1`;
  const params: unknown[] = [];

  if (userId) {
    sql += " AND s.user_id = ?";
    params.push(userId);
  }

  sql += " ORDER BY s.issued_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const { results } = await env.DB.prepare(sql).bind(...params).all();

  const countSql = userId
    ? "SELECT COUNT(*) as total FROM sessions WHERE user_id = ?"
    : "SELECT COUNT(*) as total FROM sessions";
  const countRow = userId
    ? await env.DB.prepare(countSql).bind(userId).first<{ total: number }>()
    : await env.DB.prepare(countSql).first<{ total: number }>();

  return json({ success: true, data: results, total: countRow?.total ?? 0 }, 200, origin);
}

// ─── Admin: force-logout a user ──────────────────────────────────
// Stores a "forced_logout_at" timestamp in KV. The auth middleware
// rejects tokens issued before this timestamp.

export async function handleForceLogout(
  request: Request,
  env: Env,
  targetUserId: string,
  adminUserId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  const user = await env.DB.prepare("SELECT id, email FROM users WHERE id = ?")
    .bind(targetUserId)
    .first<{ id: string; email: string }>();

  if (!user) {
    return json({ success: false, error: "User not found" }, 404, origin);
  }

  // Store forced-logout timestamp in KV (TTL = 30 days to cover absolute session limit)
  const now = Math.floor(Date.now() / 1000);
  await env.CACHE.put(`forced_logout:${targetUserId}`, String(now), { expirationTtl: 60 * 60 * 24 * 30 });

  // Revoke all active sessions in DB
  await env.DB.prepare(
    "UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
  ).bind(targetUserId).run();

  await audit(env, {
    action: "force_logout",
    userId: adminUserId,
    resourceType: "user",
    resourceId: targetUserId,
    details: { target_email: user.email },
    request,
  });

  return json({ success: true, data: { message: `User ${user.email} sessions invalidated` } }, 200, origin);
}
