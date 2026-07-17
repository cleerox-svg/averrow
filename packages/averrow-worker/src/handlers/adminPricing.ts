// Staff pricing handlers.
//
// M4 (2026-06-10 audit): access is permission-gated per
// lib/role-permissions.ts — reads require `view_billing`, mutations
// require `edit_pricing`. Both flags grant sales + billing (+ admin
// and super_admin via their full-grant rows), matching the
// documented RBAC model. The route layer (routes/admin.ts) applies
// the same requirePermission guards; this in-handler check is
// defense-in-depth for any future caller that skips the router.
//
// v3 Phase D Stripe sprint 1.

import { json } from "../lib/cors";
import { roleHasPermission, type StaffPermission } from "../lib/role-permissions";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";
import {
  listPricingPlans,
  listModulePrices,
  getOrgPricingSummary,
  updatePricingPlan,
  updateModulePrice,
  createPricingOverride,
  revokePricingOverride,
  type OverrideType,
  type UpdatePlanInput,
  type UpdateModulePriceInput,
} from "../lib/pricing";
import type { ModuleKey } from "../lib/entitlements";

function checkPermission(ctx: AuthContext, permission: StaffPermission): string | null {
  if (!roleHasPermission(ctx.role, permission)) {
    return `Forbidden: requires '${permission}' permission`;
  }
  return null;
}

// ─── GET /api/admin/pricing/plans ───────────────────────────────

export async function handleListPricingPlans(
  request: Request,
  env:     Env,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const err = checkPermission(ctx, "view_billing");
  if (err) return json({ success: false, error: err }, 403, origin);

  const plans = await listPricingPlans(env);
  return json({ success: true, data: { plans } }, 200, origin);
}

// ─── GET /api/admin/pricing/modules ─────────────────────────────

export async function handleListModulePrices(
  request: Request,
  env:     Env,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const err = checkPermission(ctx, "view_billing");
  if (err) return json({ success: false, error: err }, 403, origin);

  const modules = await listModulePrices(env);
  return json({ success: true, data: { modules } }, 200, origin);
}

// ─── GET /api/admin/customers/:orgId/pricing ────────────────────

export async function handleGetCustomerPricing(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const err = checkPermission(ctx, "view_billing");
  if (err) return json({ success: false, error: err }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  const summary = await getOrgPricingSummary(env, orgIdNum);
  return json({ success: true, data: summary }, 200, origin);
}

// ─── PATCH /api/admin/pricing/plans/:id ─────────────────────────

interface RawPlanPatch {
  display_name?:        unknown;
  monthly_price_cents?: unknown;
  trial_days?:          unknown;
  included_modules?:    unknown;
  stripe_price_id?:     unknown;
  description?:         unknown;
  is_active?:           unknown;
  sort_order?:          unknown;
}

function coercePlanPatch(raw: RawPlanPatch): UpdatePlanInput {
  const out: UpdatePlanInput = {};
  if (typeof raw.display_name === "string")        out.display_name        = raw.display_name;
  if (typeof raw.monthly_price_cents === "number") out.monthly_price_cents = raw.monthly_price_cents;
  if (typeof raw.trial_days === "number")          out.trial_days          = raw.trial_days;
  if (Array.isArray(raw.included_modules)) {
    out.included_modules = raw.included_modules.filter((m): m is ModuleKey => typeof m === "string") as ModuleKey[];
  }
  if (typeof raw.stripe_price_id === "string" || raw.stripe_price_id === null) out.stripe_price_id = raw.stripe_price_id ?? null;
  if (typeof raw.description === "string"     || raw.description === null)     out.description     = raw.description     ?? null;
  if (typeof raw.is_active === "boolean")          out.is_active           = raw.is_active;
  if (typeof raw.sort_order === "number")          out.sort_order          = raw.sort_order;
  return out;
}

export async function handleUpdatePricingPlan(
  request: Request,
  env:     Env,
  planId:  string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const err = checkPermission(ctx, "edit_pricing");
  if (err) return json({ success: false, error: err }, 403, origin);

  let body: RawPlanPatch;
  try {
    body = await request.json() as RawPlanPatch;
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400, origin);
  }

  const patch = coercePlanPatch(body);
  if (patch.monthly_price_cents !== undefined && (!Number.isInteger(patch.monthly_price_cents) || patch.monthly_price_cents < 0)) {
    return json({ success: false, error: "monthly_price_cents must be a non-negative integer" }, 400, origin);
  }
  if (patch.trial_days !== undefined && (!Number.isInteger(patch.trial_days) || patch.trial_days < 0)) {
    return json({ success: false, error: "trial_days must be a non-negative integer" }, 400, origin);
  }

  const updated = await updatePricingPlan(env, planId, patch);
  if (!updated) {
    return json({ success: false, error: "Pricing plan not found" }, 404, origin);
  }
  return json({ success: true, data: { plan: updated } }, 200, origin);
}

// ─── PATCH /api/admin/pricing/modules/:moduleKey ────────────────

interface RawModulePatch {
  display_name?:        unknown;
  monthly_price_cents?: unknown;
  stripe_price_id?:     unknown;
  is_active?:           unknown;
}

function coerceModulePatch(raw: RawModulePatch): UpdateModulePriceInput {
  const out: UpdateModulePriceInput = {};
  if (typeof raw.display_name === "string")        out.display_name        = raw.display_name;
  if (typeof raw.monthly_price_cents === "number") out.monthly_price_cents = raw.monthly_price_cents;
  if (typeof raw.stripe_price_id === "string" || raw.stripe_price_id === null) out.stripe_price_id = raw.stripe_price_id ?? null;
  if (typeof raw.is_active === "boolean")          out.is_active           = raw.is_active;
  return out;
}

export async function handleUpdateModulePrice(
  request:   Request,
  env:       Env,
  moduleKey: string,
  ctx:       AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const err = checkPermission(ctx, "edit_pricing");
  if (err) return json({ success: false, error: err }, 403, origin);

  let body: RawModulePatch;
  try {
    body = await request.json() as RawModulePatch;
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400, origin);
  }

  const patch = coerceModulePatch(body);
  if (patch.monthly_price_cents !== undefined && (!Number.isInteger(patch.monthly_price_cents) || patch.monthly_price_cents < 0)) {
    return json({ success: false, error: "monthly_price_cents must be a non-negative integer" }, 400, origin);
  }

  const updated = await updateModulePrice(env, moduleKey as ModuleKey, patch);
  if (!updated) {
    return json({ success: false, error: "Module price not found" }, 404, origin);
  }
  return json({ success: true, data: { module: updated } }, 200, origin);
}

// ─── POST /api/admin/customers/:orgId/pricing-overrides ─────────

interface RawCreateOverride {
  override_type?:     unknown;
  plan_id?:           unknown;
  module_key?:        unknown;
  custom_price_cents?: unknown;
  discount_pct?:      unknown;
  reason?:            unknown;
  effective_until?:   unknown;
}

export async function handleCreatePricingOverride(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const err = checkPermission(ctx, "edit_pricing");
  if (err) return json({ success: false, error: err }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  let body: RawCreateOverride;
  try {
    body = await request.json() as RawCreateOverride;
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400, origin);
  }

  const ot = body.override_type;
  if (ot !== "tier_price" && ot !== "module_price" && ot !== "discount_percent") {
    return json({ success: false, error: "override_type must be tier_price | module_price | discount_percent" }, 400, origin);
  }
  if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return json({ success: false, error: "reason is required" }, 400, origin);
  }

  try {
    const id = await createPricingOverride(env, {
      org_id:             orgIdNum,
      override_type:      ot as OverrideType,
      plan_id:            typeof body.plan_id === "string" ? body.plan_id : null,
      module_key:         typeof body.module_key === "string" ? body.module_key as ModuleKey : null,
      custom_price_cents: typeof body.custom_price_cents === "number" ? body.custom_price_cents : null,
      discount_pct:       typeof body.discount_pct === "number" ? body.discount_pct : null,
      reason:             body.reason.trim(),
      set_by_user_id:     ctx.userId,
      effective_until:    typeof body.effective_until === "string" ? body.effective_until : null,
    });
    return json({ success: true, data: { id } }, 201, origin);
  } catch (e) {
    return json({
      success: false,
      error: e instanceof Error ? e.message : "Override create failed",
    }, 400, origin);
  }
}

// ─── PATCH /api/admin/customers/:orgId/pricing-overrides/:id (revoke) ──

export async function handleRevokePricingOverride(
  request:    Request,
  env:        Env,
  _orgId:     string,
  overrideId: string,
  ctx:        AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const err = checkPermission(ctx, "edit_pricing");
  if (err) return json({ success: false, error: err }, 403, origin);

  await revokePricingOverride(env, overrideId);
  return json({ success: true, data: { id: overrideId, revoked: true } }, 200, origin);
}
