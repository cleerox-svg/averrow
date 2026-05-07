// Averrow — takedown authorization endpoints
//
// `GET /api/orgs/:orgId/takedown-authorization`
//   Tenant + super_admin can read the org's active authorization
//   (or null if not signed). Tenant client uses this to decide
//   whether to show the "sign authorization" CTA on the takedowns
//   page.
//
// `POST /api/admin/orgs/:orgId/takedown-authorization`
//   Super-admin-only. Records a freshly signed authorization on
//   behalf of a tenant. Once the tenant-side signing UI lands
//   (averrow-tenant Settings → Takedown Authorization page in
//   Phase B), the tenant route below replaces this admin path.
//
// `DELETE /api/orgs/:orgId/takedown-authorization`
//   Tenant admin or super_admin can revoke an active authorization.
//   Idempotent.

import { json } from "../lib/cors";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";
import { MODULE_KEYS, type ModuleKey } from "../lib/entitlements";
import {
  getActiveAuthorization,
  recordSignedAuthorization,
  revokeAuthorization,
  type AuthorizationScope,
  type EscalationMode,
} from "../lib/takedown-authorizations";

// ─── Org-access guard ──────────────────────────────────────────
function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

// Members must be admin/owner to revoke; analyst/viewer are read-only.
const ADMIN_ROLES = new Set(["admin", "owner"]);

function canMutateAuthorization(ctx: AuthContext): boolean {
  if (ctx.role === "super_admin") return true;
  return ADMIN_ROLES.has(ctx.orgRole ?? "");
}

// ─── GET /api/orgs/:orgId/takedown-authorization ───────────────

export async function handleGetActiveAuthorization(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  const auth = await getActiveAuthorization(env, orgIdNum);
  return json({
    success: true,
    data: {
      org_id: orgIdNum,
      authorization: auth,
    },
  }, 200, origin);
}

// ─── POST /api/admin/orgs/:orgId/takedown-authorization ─────────
// Body: { agreement_version, signed_by_user_id, scope: AuthorizationScope, signed_ip?, signed_user_agent? }

interface AdminRecordAuthorizationBody {
  agreement_version: string;
  signed_by_user_id: string;
  scope:             AuthorizationScope;
  signed_ip?:        string;
  signed_user_agent?: string;
}

function isModuleKey(k: unknown): k is ModuleKey {
  return typeof k === "string" && (MODULE_KEYS as readonly string[]).includes(k);
}

function validateScope(scope: unknown): scope is AuthorizationScope {
  if (!scope || typeof scope !== "object") return false;
  const s = scope as Record<string, unknown>;
  if (!Array.isArray(s.modules) || !s.modules.every(isModuleKey)) return false;
  if (s.max_takedowns_per_month !== null && typeof s.max_takedowns_per_month !== "number") return false;
  if (s.escalation !== "auto_resubmit_on_pivot" && s.escalation !== "manual_only") return false;
  if (s.auto_followup_breached_sla_hours !== null && typeof s.auto_followup_breached_sla_hours !== "number") return false;
  if (typeof s.high_risk_requires_per_takedown_approval !== "boolean") return false;
  return true;
}

export async function handleAdminRecordAuthorization(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (ctx.role !== "super_admin") {
    return json({ success: false, error: "Super admin required" }, 403, origin);
  }

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  let body: AdminRecordAuthorizationBody;
  try {
    body = await request.json<AdminRecordAuthorizationBody>();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400, origin);
  }

  if (typeof body.agreement_version !== "string" || !body.agreement_version.trim()) {
    return json({ success: false, error: "agreement_version is required" }, 400, origin);
  }
  if (typeof body.signed_by_user_id !== "string" || !body.signed_by_user_id.trim()) {
    return json({ success: false, error: "signed_by_user_id is required" }, 400, origin);
  }
  if (!validateScope(body.scope)) {
    return json({
      success: false,
      error: `Invalid scope. modules must be a subset of [${MODULE_KEYS.join(", ")}]; max_takedowns_per_month, auto_followup_breached_sla_hours can be number or null; escalation must be 'auto_resubmit_on_pivot' or 'manual_only'; high_risk_requires_per_takedown_approval must be boolean`,
    }, 400, origin);
  }

  const auth = await recordSignedAuthorization(env, {
    orgId:            orgIdNum,
    agreementVersion: body.agreement_version,
    signedByUserId:   body.signed_by_user_id,
    scope:            body.scope,
    signedIp:         body.signed_ip ?? null,
    signedUserAgent:  body.signed_user_agent ?? null,
  });

  return json({
    success: true,
    data: { authorization: auth },
  }, 200, origin);
}

// ─── DELETE /api/orgs/:orgId/takedown-authorization ─────────────
// Tenant admin/owner or super_admin. Idempotent.

interface RevokeAuthorizationBody {
  reason?: string;
}

export async function handleRevokeAuthorization(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);
  if (!canMutateAuthorization(ctx)) {
    return json({
      success: false,
      error: "Org admin / owner required to revoke takedown authorization",
    }, 403, origin);
  }

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  let body: RevokeAuthorizationBody = {};
  try {
    const parsed = await request.json<RevokeAuthorizationBody>().catch(() => ({}));
    body = parsed ?? {};
  } catch { /* ignore */ }

  await revokeAuthorization(env, orgIdNum, {
    revokedByUserId: ctx.userId,
    reason:          body.reason,
  });

  return json({ success: true, data: { org_id: orgIdNum, action: "revoked" } }, 200, origin);
}
