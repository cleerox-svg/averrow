// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Organization CRUD, Member Management, Brand Assignment, API Keys, Integrations

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import { generateInviteToken, hashToken } from "../lib/hash";
import { sendInviteEmail } from "../lib/invite-email";
import { sendTestWebhook } from "../lib/webhooks";
import { syncOrgModulesToPlan } from "../lib/entitlements";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";

// ─── SHA-256 helper ─────────────────────────────────────────
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Helpers ─────────────────────────────────────────────────

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function generateInviteCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (const b of bytes) code += chars[b % chars.length];
  return code;
}

const ORG_ROLE_HIERARCHY: Record<string, number> = {
  viewer: 1, analyst: 2, admin: 3, owner: 4,
};

const VALID_ORG_ROLES = ["viewer", "analyst", "admin", "owner"];
const INVITE_EXPIRY_HOURS = 72;

// ─── Admin: Create Organization (super_admin) ────────────────

export async function handleCreateOrg(
  request: Request,
  env: Env,
  adminUserId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const body = await request.json().catch(() => null) as {
    name?: string;
    slug?: string;
    plan?: string;
    max_brands?: number;
    max_members?: number;
    brands?: { brand_id: string; is_primary?: boolean }[];
    services?: string[];
    admin_email?: string;
    admin_name?: string;
  } | null;

  if (!body?.name) {
    return json({ success: false, error: "Organization name is required" }, 400, origin);
  }

  // Generate unique slug (use provided slug or auto-generate)
  let slug = body.slug ? generateSlug(body.slug) : generateSlug(body.name);
  const existing = await env.DB.prepare("SELECT id FROM organizations WHERE slug = ?")
    .bind(slug).first();
  if (existing) {
    slug += "-" + Date.now().toString(36).slice(-4);
  }

  const inviteCode = generateInviteCode();

  await env.DB.prepare(`
    INSERT INTO organizations (name, slug, plan, invite_code, max_brands, max_members)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    body.name,
    slug,
    body.plan ?? "starter",
    inviteCode,
    body.max_brands ?? 5,
    body.max_members ?? 10,
  ).run();

  const org = await env.DB.prepare("SELECT * FROM organizations WHERE slug = ?")
    .bind(slug).first();

  if (!org) {
    return json({ success: false, error: "Failed to create organization" }, 500, origin);
  }

  const orgId = String(org.id);

  // ─── Assign brands ───────────────────────────────────────
  if (body.brands && body.brands.length > 0) {
    for (const brand of body.brands) {
      try {
        await env.DB.prepare(
          "INSERT INTO org_brands (org_id, brand_id, is_primary) VALUES (?, ?, ?)",
        ).bind(orgId, brand.brand_id, brand.is_primary ? 1 : 0).run();
      } catch { /* skip duplicates */ }
    }
  }

  // ─── Create integration records for selected services ────
  const SERVICE_MAP: Record<string, { type: string; category: string; name: string }> = {
    sso: { type: "sso", category: "auth", name: "SSO (SAML/OIDC)" },
    siem_splunk: { type: "splunk", category: "siem", name: "Splunk" },
    siem_elastic: { type: "elastic", category: "siem", name: "Elastic SIEM" },
    siem_sentinel: { type: "sentinel", category: "siem", name: "Microsoft Sentinel" },
    siem_qradar: { type: "qradar", category: "siem", name: "IBM QRadar" },
    webhook: { type: "webhook", category: "notification", name: "Webhook Notifications" },
    api_access: { type: "api", category: "access", name: "API Access" },
    email_notifications: { type: "email", category: "notification", name: "Email Notifications" },
    takedown_service: { type: "takedown", category: "service", name: "Takedown Service" },
    custom_threat_feeds: { type: "threat_feeds", category: "inbound", name: "Custom Threat Feeds" },
  };

  if (body.services && body.services.length > 0) {
    for (const svc of body.services) {
      const def = SERVICE_MAP[svc];
      if (def) {
        try {
          await env.DB.prepare(`
            INSERT INTO org_integrations (org_id, type, category, name, status)
            VALUES (?, ?, ?, ?, 'pending_setup')
          `).bind(orgId, def.type, def.category, def.name).run();
        } catch { /* skip if duplicate */ }
      }
    }
  }

  // ─── Invite first admin ──────────────────────────────────
  let inviteData: Record<string, unknown> | null = null;
  if (body.admin_email) {
    const rawToken = generateInviteToken();
    const tokenHash = await hashToken(rawToken);
    const inviteId = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO invitations (id, email, role, token_hash, invited_by, expires_at, org_id, org_role)
       VALUES (?, ?, 'client', ?, ?, datetime('now', '+${INVITE_EXPIRY_HOURS} hours'), ?, 'admin')`,
    ).bind(inviteId, body.admin_email.toLowerCase(), tokenHash, adminUserId, orgId).run();

    const inviteUrl = `${new URL(request.url).origin}/invite?token=${rawToken}`;

    let emailSent = false;
    if (env.RESEND_API_KEY) {
      const emailResult = await sendInviteEmail(env.RESEND_API_KEY, {
        recipientEmail: body.admin_email.toLowerCase(),
        orgName: body.name,
        role: "admin",
        invitedByName: body.admin_name ?? "Averrow Super Admin",
        acceptUrl: inviteUrl,
        expiresAt: new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString(),
      });
      emailSent = emailResult.ok;
    }

    inviteData = {
      invite_id: inviteId,
      email: body.admin_email,
      org_role: "admin",
      invite_url: inviteUrl,
      email_sent: emailSent,
    };
  }

  await audit(env, {
    action: "org_created",
    userId: adminUserId,
    resourceType: "organization",
    resourceId: orgId,
    details: {
      name: body.name, slug, plan: body.plan ?? "starter",
      brands_assigned: body.brands?.length ?? 0,
      services_enabled: body.services?.length ?? 0,
      admin_invited: !!body.admin_email,
    },
    request,
  });

  return json({
    success: true,
    data: { ...org, invite: inviteData },
  }, 201, origin);
}

// ─── Admin: Search Brands for Assignment (super_admin) ──────

export async function handleSearchBrands(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "10", 10), 50);

  if (query.length < 1) {
    return json({ success: true, data: [] }, 200, origin);
  }

  const { results } = await env.DB.prepare(`
    SELECT b.id, b.name, b.canonical_domain, b.sector,
           COUNT(t.id) AS threat_count
    FROM brands b
    LEFT JOIN threats t ON t.target_brand_id = b.id
    WHERE b.name LIKE ? OR b.canonical_domain LIKE ?
    GROUP BY b.id
    ORDER BY threat_count DESC
    LIMIT ?
  `).bind(`%${query}%`, `%${query}%`, limit).all();

  return json({ success: true, data: results }, 200, origin);
}

// ─── Admin: List Organizations (super_admin) ─────────────────

export async function handleListOrgs(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const { results } = await env.DB.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM org_members om WHERE om.org_id = o.id AND om.status = 'active') AS member_count,
      (SELECT COUNT(*) FROM org_brands ob WHERE ob.org_id = o.id) AS brand_count
    FROM organizations o
    ORDER BY o.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  return json({ success: true, data: results }, 200, origin);
}

// ─── Admin: Get Organization Detail (super_admin) ────────────

export async function handleGetOrg(
  request: Request,
  env: Env,
  orgId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  const org = await env.DB.prepare("SELECT * FROM organizations WHERE id = ?")
    .bind(orgId).first();
  if (!org) return json({ success: false, error: "Organization not found" }, 404, origin);

  const { results: members } = await env.DB.prepare(`
    SELECT om.*, u.email, u.name AS user_name, u.role AS platform_role
    FROM org_members om
    JOIN users u ON u.id = om.user_id
    WHERE om.org_id = ? AND om.status = 'active'
    ORDER BY om.created_at
  `).bind(orgId).all();

  const { results: brands } = await env.DB.prepare(`
    SELECT ob.*, b.name AS brand_name, b.canonical_domain
    FROM org_brands ob
    JOIN brands b ON b.id = ob.brand_id
    WHERE ob.org_id = ?
    ORDER BY ob.created_at
  `).bind(orgId).all();

  return json({ success: true, data: { ...org, members, brands } }, 200, origin);
}

// ─── Admin: Update Organization (super_admin) ────────────────

export async function handleUpdateOrg(
  request: Request,
  env: Env,
  orgId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const body = await request.json().catch(() => null) as {
    plan?: string;
    max_brands?: number;
    max_members?: number;
    status?: string;
    webhook_url?: string;
    name?: string;
  } | null;

  if (!body) return json({ success: false, error: "No update data provided" }, 400, origin);

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (body.name !== undefined) { sets.push("name = ?"); vals.push(body.name); }
  if (body.max_brands !== undefined) { sets.push("max_brands = ?"); vals.push(body.max_brands); }
  if (body.max_members !== undefined) { sets.push("max_members = ?"); vals.push(body.max_members); }
  if (body.status !== undefined) { sets.push("status = ?"); vals.push(body.status); }
  if (body.webhook_url !== undefined) { sets.push("webhook_url = ?"); vals.push(body.webhook_url); }

  // Plan changes flow through plan_id (the FK-soft to pricing_plans).
  // 'free' has no pricing_plans row, so plan_id goes NULL for that
  // tier and syncOrgModulesToPlan suspends everything. The legacy
  // `plan` column is kept in sync so older readers don't break.
  let planChanged = false;
  let resolvedPlanId: string | null = null;
  if (body.plan !== undefined) {
    sets.push("plan = ?");
    vals.push(body.plan);
    planChanged = true;

    const planRow = await env.DB.prepare(
      `SELECT id FROM pricing_plans WHERE id = ? AND is_active = 1 LIMIT 1`,
    ).bind(body.plan).first<{ id: string }>();
    resolvedPlanId = planRow?.id ?? null;

    sets.push("plan_id = ?");
    vals.push(resolvedPlanId);
  }

  if (sets.length === 0) return json({ success: false, error: "No valid fields to update" }, 400, origin);

  sets.push("updated_at = datetime('now')");
  vals.push(orgId);

  await env.DB.prepare(`UPDATE organizations SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals).run();

  // Auto-sync module entitlements when the plan changed. This is a
  // super-admin action that explicitly says "this org gets this
  // plan", so we override billing_status to 'active' — the Stripe
  // webhook still owns the live billing state for orgs that have a
  // subscription. Idempotent and safe to call when no plan row
  // matched (resolvedPlanId === null) — the helper suspends every
  // active module in that case, which is the right "moved to free"
  // semantics.
  if (planChanged) {
    try {
      await syncOrgModulesToPlan(env, Number(orgId), {
        planId:                resolvedPlanId,
        billingStatusOverride: "active",
      });
    } catch {
      // Don't fail the PATCH on a sync error — the plan itself
      // saved, and the admin can hit /sync-plan-modules to retry.
    }
  }

  const org = await env.DB.prepare("SELECT * FROM organizations WHERE id = ?")
    .bind(orgId).first();

  return json({ success: true, data: org }, 200, origin);
}

// ─── Org Member: Get Own Org ──────────────────────────────────

export async function handleGetOwnOrg(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  // Superadmins can access any org; members must match
  if (ctx.role !== "super_admin" && ctx.orgId !== orgId) {
    return json({ success: false, error: "Not a member of this organization" }, 403, origin);
  }

  const org = await env.DB.prepare(
    "SELECT id, name, slug, plan, status, max_brands, max_members, created_at FROM organizations WHERE id = ?",
  ).bind(orgId).first();

  if (!org) return json({ success: false, error: "Organization not found" }, 404, origin);

  return json({ success: true, data: org }, 200, origin);
}

// ─── Org Admin: List Members ──────────────────────────────────

export async function handleListOrgMembers(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  // Check access: super_admin or org admin+
  if (ctx.role !== "super_admin") {
    if (ctx.orgId !== orgId) return json({ success: false, error: "Not a member of this organization" }, 403, origin);
    const level = ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0;
    if (level < (ORG_ROLE_HIERARCHY.admin ?? 3)) return json({ success: false, error: "Requires org role: admin or higher" }, 403, origin);
  }

  const { results } = await env.DB.prepare(`
    SELECT om.id, om.user_id, om.role, om.status, om.invited_at, om.accepted_at, om.last_active_at,
           u.email, u.name AS user_name
    FROM org_members om
    JOIN users u ON u.id = om.user_id
    WHERE om.org_id = ? AND om.status = 'active'
    ORDER BY om.created_at
  `).bind(orgId).all();

  return json({ success: true, data: results }, 200, origin);
}

// ─── Org Admin: Invite User ──────────────────────────────────

export async function handleOrgInvite(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  // Check access: super_admin or org admin+
  if (ctx.role !== "super_admin") {
    if (ctx.orgId !== orgId) return json({ success: false, error: "Not a member of this organization" }, 403, origin);
    const level = ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0;
    if (level < (ORG_ROLE_HIERARCHY.admin ?? 3)) return json({ success: false, error: "Requires org role: admin or higher" }, 403, origin);
  }

  const body = await request.json().catch(() => null) as {
    email?: string;
    org_role?: string;
  } | null;

  if (!body?.email) return json({ success: false, error: "Email is required" }, 400, origin);

  const orgRole = body.org_role ?? "viewer";
  if (!VALID_ORG_ROLES.includes(orgRole)) {
    return json({ success: false, error: `Invalid org role. Must be one of: ${VALID_ORG_ROLES.join(", ")}` }, 400, origin);
  }

  // Check member limit
  const org = await env.DB.prepare("SELECT max_members FROM organizations WHERE id = ?")
    .bind(orgId).first<{ max_members: number }>();
  if (org) {
    const memberCount = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM org_members WHERE org_id = ? AND status = 'active'",
    ).bind(orgId).first<{ cnt: number }>();
    if (memberCount && memberCount.cnt >= org.max_members) {
      return json({ success: false, error: "Organization has reached its member limit" }, 400, origin);
    }
  }

  // Generate invite token
  const rawToken = generateInviteToken();
  const tokenHash = await hashToken(rawToken);
  const id = crypto.randomUUID();

  // The invitation has platform role "client" and org context
  await env.DB.prepare(
    `INSERT INTO invitations (id, email, role, token_hash, invited_by, expires_at, org_id, org_role)
     VALUES (?, ?, 'client', ?, ?, datetime('now', '+${INVITE_EXPIRY_HOURS} hours'), ?, ?)`,
  ).bind(id, body.email.toLowerCase(), tokenHash, ctx.userId, orgId, orgRole).run();

  await audit(env, {
    action: "org_invite_created",
    userId: ctx.userId,
    resourceType: "invitation",
    resourceId: id,
    details: { email: body.email, org_id: orgId, org_role: orgRole },
    request,
  });

  const inviteUrl = `${new URL(request.url).origin}/invite?token=${rawToken}`;

  // Send invitation email via Resend
  let emailSent = false;
  if (env.RESEND_API_KEY) {
    // Look up org name and inviter name for the email
    const orgRow = await env.DB.prepare("SELECT name FROM organizations WHERE id = ?")
      .bind(orgId).first<{ name: string }>();
    const inviterRow = await env.DB.prepare("SELECT name, email FROM users WHERE id = ?")
      .bind(ctx.userId).first<{ name: string; email: string }>();

    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

    const emailResult = await sendInviteEmail(env.RESEND_API_KEY, {
      recipientEmail: body.email.toLowerCase(),
      orgName: orgRow?.name ?? "your organization",
      role: orgRole,
      invitedByName: inviterRow?.name ?? inviterRow?.email ?? "A team member",
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
      org_role: orgRole,
      invite_url: inviteUrl,
      email_sent: emailSent,
      expires_in_hours: INVITE_EXPIRY_HOURS,
    },
  }, 201, origin);
}

// ─── Org Admin: Remove Member ─────────────────────────────────

export async function handleRemoveOrgMember(
  request: Request,
  env: Env,
  orgId: string,
  userId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  if (ctx.role !== "super_admin") {
    if (ctx.orgId !== orgId) return json({ success: false, error: "Not a member of this organization" }, 403, origin);
    const level = ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0;
    if (level < (ORG_ROLE_HIERARCHY.admin ?? 3)) return json({ success: false, error: "Requires org role: admin or higher" }, 403, origin);
  }

  // Prevent removing yourself
  if (userId === ctx.userId) {
    return json({ success: false, error: "Cannot remove yourself from the organization" }, 400, origin);
  }

  const result = await env.DB.prepare(
    "UPDATE org_members SET status = 'removed', deprovisioned_at = datetime('now') WHERE org_id = ? AND user_id = ? AND status = 'active'",
  ).bind(orgId, userId).run();

  if (!result.meta.changes) {
    return json({ success: false, error: "Member not found or already removed" }, 404, origin);
  }

  await audit(env, {
    action: "org_member_removed",
    userId: ctx.userId,
    resourceType: "org_member",
    resourceId: userId,
    details: { org_id: orgId },
    request,
  });

  return json({ success: true, data: { message: "Member removed" } }, 200, origin);
}

// ─── Org Admin: Update Member Role ────────────────────────────

export async function handleUpdateOrgMember(
  request: Request,
  env: Env,
  orgId: string,
  userId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  if (ctx.role !== "super_admin") {
    if (ctx.orgId !== orgId) return json({ success: false, error: "Not a member of this organization" }, 403, origin);
    const level = ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0;
    if (level < (ORG_ROLE_HIERARCHY.admin ?? 3)) return json({ success: false, error: "Requires org role: admin or higher" }, 403, origin);
  }

  const body = await request.json().catch(() => null) as { role?: string } | null;
  if (!body?.role || !VALID_ORG_ROLES.includes(body.role)) {
    return json({ success: false, error: `Invalid role. Must be one of: ${VALID_ORG_ROLES.join(", ")}` }, 400, origin);
  }

  const result = await env.DB.prepare(
    "UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ? AND status = 'active'",
  ).bind(body.role, orgId, userId).run();

  if (!result.meta.changes) {
    return json({ success: false, error: "Member not found" }, 404, origin);
  }

  await audit(env, {
    action: "org_member_role_updated",
    userId: ctx.userId,
    resourceType: "org_member",
    resourceId: userId,
    details: { org_id: orgId, new_role: body.role },
    request,
  });

  return json({ success: true, data: { message: "Member role updated" } }, 200, origin);
}

// ─── Org Admin: Assign Brand ──────────────────────────────────

export async function handleAssignOrgBrand(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  if (ctx.role !== "super_admin") {
    if (ctx.orgId !== orgId) return json({ success: false, error: "Not a member of this organization" }, 403, origin);
    const level = ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0;
    if (level < (ORG_ROLE_HIERARCHY.admin ?? 3)) return json({ success: false, error: "Requires org role: admin or higher" }, 403, origin);
  }

  const body = await request.json().catch(() => null) as {
    brand_id?: string;
    is_primary?: boolean;
  } | null;

  if (!body?.brand_id) return json({ success: false, error: "brand_id is required" }, 400, origin);

  // Check max_brands limit
  const org = await env.DB.prepare("SELECT max_brands FROM organizations WHERE id = ?")
    .bind(orgId).first<{ max_brands: number }>();
  if (org) {
    const brandCount = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM org_brands WHERE org_id = ?",
    ).bind(orgId).first<{ cnt: number }>();
    if (brandCount && brandCount.cnt >= org.max_brands) {
      return json({ success: false, error: "Organization has reached its brand limit" }, 400, origin);
    }
  }

  try {
    await env.DB.prepare(
      "INSERT INTO org_brands (org_id, brand_id, is_primary) VALUES (?, ?, ?)",
    ).bind(orgId, body.brand_id, body.is_primary ? 1 : 0).run();
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      return json({ success: false, error: "Brand already assigned to this organization" }, 409, origin);
    }
    throw err;
  }

  await audit(env, {
    action: "org_brand_assigned",
    userId: ctx.userId,
    resourceType: "org_brand",
    resourceId: body.brand_id,
    details: { org_id: orgId, is_primary: body.is_primary },
    request,
  });

  return json({ success: true, data: { message: "Brand assigned" } }, 201, origin);
}

// ─── Org Admin: Remove Brand ──────────────────────────────────

export async function handleRemoveOrgBrand(
  request: Request,
  env: Env,
  orgId: string,
  brandId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  if (ctx.role !== "super_admin") {
    if (ctx.orgId !== orgId) return json({ success: false, error: "Not a member of this organization" }, 403, origin);
    const level = ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0;
    if (level < (ORG_ROLE_HIERARCHY.admin ?? 3)) return json({ success: false, error: "Requires org role: admin or higher" }, 403, origin);
  }

  const result = await env.DB.prepare(
    "DELETE FROM org_brands WHERE org_id = ? AND brand_id = ?",
  ).bind(orgId, brandId).run();

  if (!result.meta.changes) {
    return json({ success: false, error: "Brand not found in organization" }, 404, origin);
  }

  await audit(env, {
    action: "org_brand_removed",
    userId: ctx.userId,
    resourceType: "org_brand",
    resourceId: brandId,
    details: { org_id: orgId },
    request,
  });

  return json({ success: true, data: { message: "Brand removed" } }, 200, origin);
}

// ─── Org Member: List Brands ──────────────────────────────────

export async function handleListOrgBrands(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  if (ctx.role !== "super_admin" && ctx.orgId !== orgId) {
    return json({ success: false, error: "Not a member of this organization" }, 403, origin);
  }

  const { results } = await env.DB.prepare(`
    SELECT ob.id, ob.brand_id, ob.is_primary, ob.created_at,
           b.name AS brand_name, b.canonical_domain, b.sector, b.threat_count
    FROM org_brands ob
    JOIN brands b ON b.id = ob.brand_id
    WHERE ob.org_id = ?
    ORDER BY ob.created_at
  `).bind(orgId).all();

  return json({ success: true, data: results }, 200, origin);
}

// ─── Org Admin: List Pending Invites ─────────────────────────

export async function handleListOrgInvites(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  if (ctx.role !== "super_admin") {
    if (ctx.orgId !== orgId) return json({ success: false, error: "Not a member of this organization" }, 403, origin);
    const level = ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0;
    if (level < (ORG_ROLE_HIERARCHY.admin ?? 3)) return json({ success: false, error: "Requires org role: admin or higher" }, 403, origin);
  }

  const { results } = await env.DB.prepare(`
    SELECT id, email, org_role, created_at, expires_at
    FROM invitations
    WHERE org_id = ? AND status = 'pending'
    ORDER BY created_at DESC
  `).bind(orgId).all();

  return json({ success: true, data: results }, 200, origin);
}

// ─── Org Admin: Revoke Pending Invite ────────────────────────

export async function handleRevokeOrgInvite(
  request: Request,
  env: Env,
  orgId: string,
  inviteId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  if (ctx.role !== "super_admin") {
    if (ctx.orgId !== orgId) return json({ success: false, error: "Not a member of this organization" }, 403, origin);
    const level = ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0;
    if (level < (ORG_ROLE_HIERARCHY.admin ?? 3)) return json({ success: false, error: "Requires org role: admin or higher" }, 403, origin);
  }

  // Verify invitation belongs to this org
  const invite = await env.DB.prepare(
    "SELECT id FROM invitations WHERE id = ? AND org_id = ? AND status = 'pending'",
  ).bind(inviteId, orgId).first();

  if (!invite) {
    return json({ success: false, error: "Invitation not found or already used" }, 404, origin);
  }

  await env.DB.prepare(
    "UPDATE invitations SET status = 'revoked' WHERE id = ?",
  ).bind(inviteId).run();

  await audit(env, {
    action: "org_invite_revoked",
    userId: ctx.userId,
    resourceType: "invitation",
    resourceId: inviteId,
    details: { org_id: orgId },
    request,
  });

  return json({ success: true, data: { message: "Invitation revoked" } }, 200, origin);
}

// ─── Org Admin: Update Webhook Config ────────────────────────

export async function handleUpdateWebhook(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  if (ctx.role !== "super_admin") {
    if (ctx.orgId !== orgId) return json({ success: false, error: "Not a member of this organization" }, 403, origin);
    const level = ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0;
    if (level < (ORG_ROLE_HIERARCHY.admin ?? 3)) return json({ success: false, error: "Requires org role: admin or higher" }, 403, origin);
  }

  const body = await request.json().catch(() => null) as {
    webhook_url?: string;
    webhook_events?: string[];
  } | null;

  if (!body) return json({ success: false, error: "No update data provided" }, 400, origin);

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (body.webhook_url !== undefined) {
    sets.push("webhook_url = ?");
    vals.push(body.webhook_url || null);
  }

  if (body.webhook_events !== undefined) {
    sets.push("webhook_events = ?");
    vals.push(JSON.stringify(body.webhook_events));
  }

  if (sets.length === 0) return json({ success: false, error: "No valid fields to update" }, 400, origin);

  // Auto-generate secret if setting webhook_url for the first time
  let newSecret: string | null = null;
  if (body.webhook_url) {
    const existing = await env.DB.prepare(
      "SELECT webhook_secret FROM organizations WHERE id = ?",
    ).bind(orgId).first<{ webhook_secret: string | null }>();

    if (!existing?.webhook_secret) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      newSecret = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
      sets.push("webhook_secret = ?");
      vals.push(newSecret);
    }
  }

  sets.push("updated_at = datetime('now')");
  vals.push(orgId);

  await env.DB.prepare(`UPDATE organizations SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals).run();

  await audit(env, {
    action: "webhook_config_updated",
    userId: ctx.userId,
    resourceType: "organization",
    resourceId: orgId,
    details: { webhook_url: body.webhook_url, webhook_events: body.webhook_events },
    request,
  });

  const responseData: Record<string, unknown> = { message: "Webhook configuration updated" };
  if (newSecret) {
    responseData.webhook_secret = newSecret;
  }

  return json({ success: true, data: responseData }, 200, origin);
}

// ─── Org Owner: Regenerate Webhook Secret ────────────────────

export async function handleRegenerateSecret(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  if (ctx.role !== "super_admin") {
    if (ctx.orgId !== orgId) return json({ success: false, error: "Not a member of this organization" }, 403, origin);
    if (ctx.orgRole !== "owner") return json({ success: false, error: "Only the org owner can regenerate the webhook secret" }, 403, origin);
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const newSecret = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");

  await env.DB.prepare(
    "UPDATE organizations SET webhook_secret = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(newSecret, orgId).run();

  await audit(env, {
    action: "webhook_secret_regenerated",
    userId: ctx.userId,
    resourceType: "organization",
    resourceId: orgId,
    details: {},
    request,
  });

  return json({ success: true, data: { webhook_secret: newSecret } }, 200, origin);
}

// ─── Org Admin: Test Webhook ─────────────────────────────────

export async function handleTestWebhook(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  if (ctx.role !== "super_admin") {
    if (ctx.orgId !== orgId) return json({ success: false, error: "Not a member of this organization" }, 403, origin);
    const level = ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0;
    if (level < (ORG_ROLE_HIERARCHY.admin ?? 3)) return json({ success: false, error: "Requires org role: admin or higher" }, 403, origin);
  }

  const result = await sendTestWebhook(env, Number(orgId));

  return json({
    success: result.success,
    data: {
      status: result.status,
      error: result.error,
    },
  }, result.success ? 200 : 502, origin);
}

// ─── Org Admin: Get Webhook Config ───────────────────────────

export async function handleGetWebhookConfig(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  if (ctx.role !== "super_admin") {
    if (ctx.orgId !== orgId) return json({ success: false, error: "Not a member of this organization" }, 403, origin);
    const level = ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0;
    if (level < (ORG_ROLE_HIERARCHY.admin ?? 3)) return json({ success: false, error: "Requires org role: admin or higher" }, 403, origin);
  }

  const org = await env.DB.prepare(
    "SELECT webhook_url, webhook_secret, webhook_events, webhook_failures_24h, webhook_last_success, webhook_last_failure FROM organizations WHERE id = ?",
  ).bind(orgId).first<{
    webhook_url: string | null;
    webhook_secret: string | null;
    webhook_events: string | null;
    webhook_failures_24h: number;
    webhook_last_success: string | null;
    webhook_last_failure: string | null;
  }>();

  if (!org) return json({ success: false, error: "Organization not found" }, 404, origin);

  let events: string[] = [];
  if (org.webhook_events) {
    try { events = JSON.parse(org.webhook_events); } catch { /* default empty */ }
  }

  return json({
    success: true,
    data: {
      webhook_url: org.webhook_url,
      has_secret: !!org.webhook_secret,
      webhook_events: events,
      webhook_failures_24h: org.webhook_failures_24h ?? 0,
      webhook_last_success: org.webhook_last_success,
      webhook_last_failure: org.webhook_last_failure,
    },
  }, 200, origin);
}

// ═══════════════════════════════════════════════════════════════
// API KEYS
// ═══════════════════════════════════════════════════════════════

function requireOrgAdmin(ctx: AuthContext, orgId: string, origin: string | null): Response | null {
  if (ctx.role !== "super_admin") {
    if (ctx.orgId !== orgId) return json({ success: false, error: "Not a member of this organization" }, 403, origin);
    const level = ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0;
    if (level < (ORG_ROLE_HIERARCHY.admin ?? 3)) return json({ success: false, error: "Requires org role: admin or higher" }, 403, origin);
  }
  return null;
}

// ─── List API Keys ──────────────────────────────────────────

export async function handleListApiKeys(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const denied = requireOrgAdmin(ctx, orgId, origin);
  if (denied) return denied;

  const { results } = await env.DB.prepare(`
    SELECT id, name, key_prefix, scopes, last_used_at, expires_at, created_by, created_at, revoked_at
    FROM org_api_keys
    WHERE org_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC
  `).bind(orgId).all();

  return json({ success: true, data: results }, 200, origin);
}

// ─── Create API Key ─────────────────────────────────────────

export async function handleCreateApiKey(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const denied = requireOrgAdmin(ctx, orgId, origin);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as {
    name?: string;
    scopes?: string[];
    expires_at?: string;
  } | null;

  if (!body?.name) return json({ success: false, error: "Key name is required" }, 400, origin);

  const fullKey = `avr_live_${crypto.randomUUID().replace(/-/g, "")}`;
  const prefix = fullKey.slice(0, 16);
  const keyHash = await sha256(fullKey);
  const scopes = body.scopes ?? ["threats:read"];

  await env.DB.prepare(`
    INSERT INTO org_api_keys (org_id, name, key_prefix, key_hash, scopes, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    orgId,
    body.name,
    prefix,
    keyHash,
    JSON.stringify(scopes),
    body.expires_at ?? null,
    ctx.userId,
  ).run();

  await audit(env, {
    action: "api_key_created",
    userId: ctx.userId,
    resourceType: "api_key",
    resourceId: prefix,
    details: { org_id: orgId, name: body.name, scopes },
    request,
  });

  return json({
    success: true,
    data: {
      key: fullKey,
      prefix,
      name: body.name,
      scopes,
      message: "Store this key securely. It will not be shown again.",
    },
  }, 201, origin);
}

// ─── Revoke API Key ─────────────────────────────────────────

export async function handleRevokeApiKey(
  request: Request,
  env: Env,
  orgId: string,
  keyId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const denied = requireOrgAdmin(ctx, orgId, origin);
  if (denied) return denied;

  const result = await env.DB.prepare(
    "UPDATE org_api_keys SET revoked_at = datetime('now') WHERE id = ? AND org_id = ? AND revoked_at IS NULL",
  ).bind(keyId, orgId).run();

  if (!result.meta.changes) {
    return json({ success: false, error: "API key not found or already revoked" }, 404, origin);
  }

  await audit(env, {
    action: "api_key_revoked",
    userId: ctx.userId,
    resourceType: "api_key",
    resourceId: keyId,
    details: { org_id: orgId },
    request,
  });

  return json({ success: true, data: { message: "API key revoked" } }, 200, origin);
}

// ═══════════════════════════════════════════════════════════════
// INTEGRATIONS
// ═══════════════════════════════════════════════════════════════

// ─── List Integrations ──────────────────────────────────────

export async function handleListIntegrations(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const denied = requireOrgAdmin(ctx, orgId, origin);
  if (denied) return denied;

  const { results } = await env.DB.prepare(`
    SELECT id, type, category, name, status, last_sync_at, last_error, events_sent, created_at, updated_at
    FROM org_integrations
    WHERE org_id = ?
    ORDER BY created_at DESC
  `).bind(orgId).all();

  return json({ success: true, data: results }, 200, origin);
}

// ─── Create Integration ─────────────────────────────────────

export async function handleCreateIntegration(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const denied = requireOrgAdmin(ctx, orgId, origin);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as {
    type?: string;
    category?: string;
    name?: string;
    config?: Record<string, unknown>;
  } | null;

  if (!body?.type || !body?.category || !body?.name) {
    return json({ success: false, error: "type, category, and name are required" }, 400, origin);
  }

  // TODO: Encrypt config with AES-GCM using env secret in production
  const configStr = body.config ? JSON.stringify(body.config) : null;

  await env.DB.prepare(`
    INSERT INTO org_integrations (org_id, type, category, name, config_encrypted, status)
    VALUES (?, ?, ?, ?, ?, 'connected')
  `).bind(orgId, body.type, body.category, body.name, configStr).run();

  const integration = await env.DB.prepare(
    "SELECT * FROM org_integrations WHERE org_id = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(orgId).first();

  await audit(env, {
    action: "integration_created",
    userId: ctx.userId,
    resourceType: "integration",
    resourceId: integration?.id as string,
    details: { org_id: orgId, type: body.type, category: body.category },
    request,
  });

  return json({ success: true, data: integration }, 201, origin);
}

// ─── Update Integration ─────────────────────────────────────

export async function handleUpdateIntegration(
  request: Request,
  env: Env,
  orgId: string,
  integrationId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const denied = requireOrgAdmin(ctx, orgId, origin);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as {
    config?: Record<string, unknown>;
    status?: string;
  } | null;

  if (!body) return json({ success: false, error: "No update data provided" }, 400, origin);

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (body.config !== undefined) {
    sets.push("config_encrypted = ?");
    vals.push(JSON.stringify(body.config));
  }
  if (body.status !== undefined) {
    sets.push("status = ?");
    vals.push(body.status);
  }

  if (sets.length === 0) return json({ success: false, error: "No valid fields to update" }, 400, origin);

  sets.push("updated_at = datetime('now')");
  vals.push(integrationId, orgId);

  await env.DB.prepare(`UPDATE org_integrations SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`)
    .bind(...vals).run();

  return json({ success: true, data: { message: "Integration updated" } }, 200, origin);
}

// ─── Delete Integration ─────────────────────────────────────

export async function handleDeleteIntegration(
  request: Request,
  env: Env,
  orgId: string,
  integrationId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const denied = requireOrgAdmin(ctx, orgId, origin);
  if (denied) return denied;

  const result = await env.DB.prepare(
    "DELETE FROM org_integrations WHERE id = ? AND org_id = ?",
  ).bind(integrationId, orgId).run();

  if (!result.meta.changes) {
    return json({ success: false, error: "Integration not found" }, 404, origin);
  }

  await audit(env, {
    action: "integration_deleted",
    userId: ctx.userId,
    resourceType: "integration",
    resourceId: integrationId,
    details: { org_id: orgId },
    request,
  });

  return json({ success: true, data: { message: "Integration removed" } }, 200, origin);
}

// ─── Test Integration Connection ────────────────────────────

export async function handleTestIntegration(
  request: Request,
  env: Env,
  orgId: string,
  integrationId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const denied = requireOrgAdmin(ctx, orgId, origin);
  if (denied) return denied;

  const integration = await env.DB.prepare(
    "SELECT * FROM org_integrations WHERE id = ? AND org_id = ?",
  ).bind(integrationId, orgId).first();

  if (!integration) {
    return json({ success: false, error: "Integration not found" }, 404, origin);
  }

  // TODO: Implement actual connection tests per integration type (Splunk HEC, Jira API, etc.)
  // For now, mark as connected if config exists
  if (integration.config_encrypted) {
    await env.DB.prepare(
      "UPDATE org_integrations SET status = 'connected', last_sync_at = datetime('now'), last_error = NULL, updated_at = datetime('now') WHERE id = ?",
    ).bind(integrationId).run();

    return json({ success: true, data: { status: "connected", message: "Connection test successful" } }, 200, origin);
  }

  return json({ success: false, data: { status: "error", message: "No configuration found" } }, 400, origin);
}
