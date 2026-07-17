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
  normalizeScope,
  type AuthorizationScope,
  type EscalationMode,
} from "../lib/takedown-authorizations";
import {
  POLICY_SEVERITIES,
  POLICY_TARGET_TYPES,
  POLICY_PROVIDER_TYPES,
} from "../lib/takedown-policy";

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

function isSubsetOf(arr: unknown, allowed: readonly string[]): boolean {
  return Array.isArray(arr) && arr.every((v) => typeof v === "string" && allowed.includes(v));
}

// Loose validation of an inbound scope body. The new mode + semi_auto_rules
// fields are OPTIONAL here (legacy clients omit them) — normalizeScope()
// backfills them deterministically before persistence. Only the legacy core
// fields are strictly required so a malformed body is still rejected.
function validateScope(scope: unknown): boolean {
  if (!scope || typeof scope !== "object") return false;
  const s = scope as Record<string, unknown>;
  if (!Array.isArray(s.modules) || !s.modules.every(isModuleKey)) return false;
  if (s.max_takedowns_per_month !== null && typeof s.max_takedowns_per_month !== "number") return false;
  if (s.escalation !== "auto_resubmit_on_pivot" && s.escalation !== "manual_only") return false;
  if (s.auto_followup_breached_sla_hours !== null && typeof s.auto_followup_breached_sla_hours !== "number") return false;
  if (typeof s.high_risk_requires_per_takedown_approval !== "boolean") return false;
  // Optional canonical posture.
  if (s.mode !== undefined && s.mode !== "off" && s.mode !== "semi_auto" && s.mode !== "auto") return false;
  // Optional semi-auto criteria — each list, if present, must be a subset of
  // the canonical domain.
  if (s.semi_auto_rules !== undefined) {
    if (!s.semi_auto_rules || typeof s.semi_auto_rules !== "object") return false;
    const r = s.semi_auto_rules as Record<string, unknown>;
    if (r.auto_severities !== undefined && !isSubsetOf(r.auto_severities, POLICY_SEVERITIES)) return false;
    if (r.auto_target_types !== undefined && !isSubsetOf(r.auto_target_types, POLICY_TARGET_TYPES)) return false;
    if (r.auto_provider_types !== undefined && !isSubsetOf(r.auto_provider_types, POLICY_PROVIDER_TYPES)) return false;
  }
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

// ─── POST /api/orgs/:orgId/takedown-authorization ───────────────
//
// Tenant-side signing. Gated to org admin/owner (or super_admin).
// signed_by_user_id is derived from ctx.userId — the tenant can't
// claim to sign on someone else's behalf. signed_ip and
// signed_user_agent are pulled from the request so the audit
// record reflects the actual signing browser.

interface RecordAuthorizationBody {
  agreement_version: string;
  scope:             AuthorizationScope;
}

export async function handleRecordAuthorization(
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
      error:   "Org admin / owner required to sign takedown authorization",
    }, 403, origin);
  }

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  let body: RecordAuthorizationBody;
  try {
    body = await request.json<RecordAuthorizationBody>();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400, origin);
  }

  if (typeof body.agreement_version !== "string" || !body.agreement_version.trim()) {
    return json({ success: false, error: "agreement_version is required" }, 400, origin);
  }
  if (!validateScope(body.scope)) {
    return json({
      success: false,
      error: `Invalid scope. modules must be a subset of [${MODULE_KEYS.join(", ")}]; max_takedowns_per_month, auto_followup_breached_sla_hours can be number or null; escalation must be 'auto_resubmit_on_pivot' or 'manual_only'; high_risk_requires_per_takedown_approval must be boolean`,
    }, 400, origin);
  }

  // Extract signing IP from CF/standard headers. CF-Connecting-IP
  // is the public source IP behind Cloudflare's edge; falling back
  // to X-Forwarded-For for non-CF dev contexts.
  const signedIp =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null;
  const signedUserAgent = request.headers.get("User-Agent") ?? null;

  const auth = await recordSignedAuthorization(env, {
    orgId:            orgIdNum,
    agreementVersion: body.agreement_version,
    signedByUserId:   ctx.userId,
    scope:            body.scope,
    signedIp,
    signedUserAgent,
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
