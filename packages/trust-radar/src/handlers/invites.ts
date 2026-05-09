// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Invitation Handlers (hash-based tokens, email-bound)

import { json } from "../lib/cors";
import { generateInviteToken, hashToken } from "../lib/hash";
import { sendInviteEmail } from "../lib/invite-email";
import { audit } from "../lib/audit";
import type { Env, UserRole } from "../types";

const VALID_ROLES: UserRole[] = [
  "super_admin", "admin", "analyst", "sales", "support", "billing", "client",
];
const INVITE_EXPIRY_HOURS = 72;

// ─── Create invitation (admin/super_admin only) ─────────────────

export async function handleCreateInvite(
  request: Request,
  env: Env,
  adminUserId: string,
  adminRole: UserRole,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const body = await request.json().catch(() => null) as {
    email?: string;
    role?: UserRole;
  } | null;

  if (!body?.email) return json({ success: false, error: "Email is required" }, 400, origin);

  const role = body.role ?? "analyst";
  if (!VALID_ROLES.includes(role)) {
    return json({ success: false, error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` }, 400, origin);
  }

  // Permission: only super_admin can invite admins/super_admins
  if ((role === "super_admin" || role === "admin") && adminRole !== "super_admin") {
    await audit(env, {
      action: "invite_create_denied",
      userId: adminUserId,
      details: { target_email: body.email, target_role: role, reason: "insufficient_role" },
      outcome: "denied",
      request,
    });
    return json({ success: false, error: "Only super admins can invite admin or super_admin roles" }, 403, origin);
  }

  // Generate secure token — only the hash is stored
  const rawToken = generateInviteToken();
  const tokenHash = await hashToken(rawToken);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO invitations (id, email, role, token_hash, invited_by, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', '+${INVITE_EXPIRY_HOURS} hours'))`,
  ).bind(id, body.email.toLowerCase(), role, tokenHash, adminUserId).run();

  await audit(env, {
    action: "invite_created",
    userId: adminUserId,
    resourceType: "invitation",
    resourceId: id,
    details: { email: body.email, role },
    request,
  });

  // Return the raw token once — it will never be retrievable again
  const inviteUrl = `${new URL(request.url).origin}/invite?token=${rawToken}`;

  // Send invitation email via Resend
  let emailSent = false;
  if (env.RESEND_API_KEY) {
    const inviterRow = await env.DB.prepare("SELECT name, email FROM users WHERE id = ?")
      .bind(adminUserId).first<{ name: string; email: string }>();

    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

    const emailResult = await sendInviteEmail(env.RESEND_API_KEY, {
      recipientEmail: body.email.toLowerCase(),
      orgName: "Averrow",
      role,
      invitedByName: inviterRow?.name ?? inviterRow?.email ?? "An administrator",
      acceptUrl: inviteUrl,
      expiresAt,
    });
    emailSent = emailResult.ok;
  }

  return json({
    success: true,
    data: {
      id,
      email: body.email,
      role,
      invite_url: inviteUrl,
      email_sent: emailSent,
      expires_in_hours: INVITE_EXPIRY_HOURS,
    },
  }, 201, origin);
}

// ─── List invitations (admin only) ──────────────────────────────

export async function handleListInvites(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  let sql = `SELECT i.id, i.email, i.role, i.status, i.created_at, i.expires_at, i.accepted_at,
                    u.email as invited_by_email
             FROM invitations i
             LEFT JOIN users u ON u.id = i.invited_by
             WHERE 1=1`;
  const params: unknown[] = [];

  if (status) {
    sql += " AND i.status = ?";
    params.push(status);
  }

  sql += " ORDER BY i.created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const { results } = await env.DB.prepare(sql).bind(...params).all();

  return json({ success: true, data: results }, 200, origin);
}

// ─── Validate invite token (public — used by frontend) ──────────

export async function handleValidateInvite(request: Request, env: Env, rawToken: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  const tokenHash = await hashToken(rawToken);

  const invite = await env.DB.prepare(
    "SELECT id, email, role, status, expires_at FROM invitations WHERE token_hash = ?",
  ).bind(tokenHash).first<{ id: string; email: string; role: string; status: string; expires_at: string }>();

  if (!invite) return json({ success: false, error: "Invalid invite token" }, 404, origin);
  if (invite.status !== "pending") return json({ success: false, error: `Invite already ${invite.status}` }, 410, origin);
  if (new Date(invite.expires_at) < new Date()) {
    await env.DB.prepare("UPDATE invitations SET status = 'expired' WHERE id = ?").bind(invite.id).run();
    return json({ success: false, error: "Invite has expired" }, 410, origin);
  }

  return json({
    success: true,
    data: {
      email: invite.email,
      role: invite.role,
      expires_at: invite.expires_at,
    },
  }, 200, origin);
}

// ─── Revoke invitation (admin only) ─────────────────────────────

export async function handleRevokeInvite(
  request: Request,
  env: Env,
  inviteId: string,
  adminUserId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  const result = await env.DB.prepare(
    "UPDATE invitations SET status = 'revoked' WHERE id = ? AND status = 'pending'",
  ).bind(inviteId).run();

  if (!result.meta.changes) {
    return json({ success: false, error: "Invite not found or not pending" }, 404, origin);
  }

  await audit(env, {
    action: "invite_revoked",
    userId: adminUserId,
    resourceType: "invitation",
    resourceId: inviteId,
    request,
  });

  return json({ success: true, data: { message: "Invite revoked" } }, 200, origin);
}
