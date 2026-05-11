// Averrow — tenant module surface
//
// `GET /api/orgs/:orgId/modules` returns the module list a tenant
// sees in their averrow-tenant sidebar:
//   - status per module (active / trial / suspended / not_entitled)
//   - metric definitions for each module (label, unit, billable flag)
//   - this month's usage rollup
//
// One handler so the tenant client can paint the whole sidebar +
// per-module usage cards from a single round-trip.
//
// `POST /api/admin/orgs/:orgId/modules` activates / suspends a
// module. Super-admin-only — eventually the Stripe webhook hits
// the same path.

import { json } from "../lib/cors";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";
import {
  MODULE_KEYS,
  type ModuleKey,
  type OrgModule,
  type ModuleStatus,
  listEnabledModules,
  activateModule,
  suspendModule,
  syncOrgModulesToPlan,
} from "../lib/entitlements";
import {
  listMetricDefinitions,
  getMonthlyUsageAcrossModules,
  type UsageMetricDef,
  type UsageRollupRow,
} from "../lib/module-usage";
import { getActiveAuthorization } from "../lib/takedown-authorizations";

// ─── Shared org-access guard ──────────────────────────────────
// Super-admins bypass; members must belong to the org id in the URL.
function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

// ─── GET /api/orgs/:orgId/modules ─────────────────────────────

export interface TenantModuleSurface {
  module_key:    ModuleKey;
  status:        ModuleStatus | "not_entitled";
  activated_at?: string;
  trial_ends_at?: string | null;
  suspended_at?: string | null;
  metrics: Array<UsageMetricDef & { value_this_month: number }>;
}

export async function handleListTenantModules(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  // Four reads, one round-trip — entitlements + defs + usage +
  // takedown authorization all KV-cached so the hot path is mostly KV.
  const [enabled, defs, usage, authorization] = await Promise.all([
    listEnabledModules(env, orgIdNum),
    listMetricDefinitions(env),
    getMonthlyUsageAcrossModules(env, orgIdNum),
    getActiveAuthorization(env, orgIdNum),
  ]);

  const enabledByKey = new Map<ModuleKey, OrgModule>();
  for (const e of enabled) enabledByKey.set(e.module_key, e);

  const usageByKey = new Map<string, number>();
  for (const u of usage) usageByKey.set(`${u.module_key}.${u.metric_key}`, u.value);

  // One row per canonical module — including "not_entitled" rows so
  // the client can show the entitled list AND the upsell list off the
  // same response. Eventually this drives both the sidebar and the
  // /settings/modules upgrade page.
  const surface: TenantModuleSurface[] = MODULE_KEYS.map((moduleKey) => {
    const entitled = enabledByKey.get(moduleKey);
    const moduleDefs = defs.filter((d) => d.module_key === moduleKey);
    return {
      module_key:    moduleKey,
      status:        entitled?.status ?? "not_entitled",
      activated_at:  entitled?.activated_at,
      trial_ends_at: entitled?.trial_ends_at ?? null,
      suspended_at:  entitled?.suspended_at ?? null,
      metrics: moduleDefs.map((d) => ({
        ...d,
        value_this_month: usageByKey.get(`${moduleKey}.${d.metric_key}`) ?? 0,
      })),
    };
  });

  // Compact authorization summary — the tenant client only needs to
  // know "is takedown automation usable, and which modules does the
  // signed scope cover" to decide whether to show CTAs vs badges.
  // Full record (signer, IP, agreement_version, etc.) is on the
  // dedicated /takedown-authorization endpoint.
  const authorizationSummary = authorization
    ? {
        signed:                 true,
        agreement_version:      authorization.agreement_version,
        signed_at:              authorization.signed_at,
        modules_covered:        authorization.scope.modules,
        max_takedowns_per_month: authorization.scope.max_takedowns_per_month,
      }
    : { signed: false };

  return json({
    success: true,
    data: {
      org_id: orgIdNum,
      modules: surface,
      takedown_authorization: authorizationSummary,
    },
  }, 200, origin);
}

// ─── POST /api/admin/orgs/:orgId/modules ──────────────────────
// Body: { module_key, action: 'activate'|'suspend', trial_ends_at?, config_json? }

export interface AdminModuleActionBody {
  module_key:     ModuleKey;
  action:         "activate" | "suspend";
  trial_ends_at?: string;
  config_json?:   string;
}

export async function handleAdminModuleAction(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (ctx.role !== "super_admin") {
    return json({ success: false, error: "Super admin required" }, 403, origin);
  }

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  let body: AdminModuleActionBody;
  try {
    body = await request.json<AdminModuleActionBody>();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400, origin);
  }

  if (!MODULE_KEYS.includes(body.module_key)) {
    return json({
      success: false,
      error: `Unknown module_key. Must be one of: ${MODULE_KEYS.join(", ")}`,
    }, 400, origin);
  }

  if (body.action === "activate") {
    await activateModule(env, orgIdNum, body.module_key, {
      trialEndsAt: body.trial_ends_at,
      configJson:  body.config_json,
    });
  } else if (body.action === "suspend") {
    await suspendModule(env, orgIdNum, body.module_key);
  } else {
    return json({
      success: false,
      error: "action must be 'activate' or 'suspend'",
    }, 400, origin);
  }

  return json({
    success: true,
    data: {
      org_id:     orgIdNum,
      module_key: body.module_key,
      action:     body.action,
    },
  }, 200, origin);
}

// ─── POST /api/admin/orgs/:orgId/sync-plan-modules ─────────────
//
// Operator action: "this org's plan_id is X, make their modules
// reflect that". Mostly used for enterprise / custom-billed orgs
// that don't flow through Stripe — the Stripe webhook path syncs
// automatically. Idempotent.
//
// Optional body: { plan_id?, billing_status?, trial_ends_at? }
// All fields fall back to the current row in `organizations` when
// omitted, so the no-body call ("just sync to current state") is
// the common usage.

export interface AdminSyncPlanModulesBody {
  plan_id?:        string;
  billing_status?: "trialing" | "active" | "past_due" | "cancelled" | "unbilled";
  trial_ends_at?:  string | null;
}

export async function handleAdminSyncPlanModules(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (ctx.role !== "super_admin") {
    return json({ success: false, error: "Super admin required" }, 403, origin);
  }

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  // Body is optional — accept no body, empty body, or JSON.
  let body: AdminSyncPlanModulesBody = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      body = JSON.parse(text) as AdminSyncPlanModulesBody;
    }
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400, origin);
  }

  try {
    const result = await syncOrgModulesToPlan(env, orgIdNum, {
      planId:                body.plan_id,
      billingStatusOverride: body.billing_status,
      trialEndsAt:           body.trial_ends_at ?? null,
    });
    return json({ success: true, data: result }, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error:   err instanceof Error ? err.message : "Sync failed",
    }, 500, origin);
  }
}

// ─── POST /api/admin/orgs/sync-all-plan-modules ────────────────
//
// One-shot bulk-sync: walks every org with `plan_id` set and calls
// syncOrgModulesToPlan. Used after the 0164 backfill migration to
// align org_modules rows with the newly populated plan_ids. Safe to
// re-run — idempotent. Skips orgs with billing_status='cancelled'
// since their modules should already be suspended.

export interface BulkSyncResult {
  scanned:   number;
  synced:    number;
  skipped:   number;
  failures:  Array<{ org_id: number; error: string }>;
}

export async function handleAdminBulkSyncPlanModules(
  request: Request,
  env:     Env,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (ctx.role !== "super_admin") {
    return json({ success: false, error: "Super admin required" }, 403, origin);
  }

  const result: BulkSyncResult = {
    scanned:  0,
    synced:   0,
    skipped:  0,
    failures: [],
  };

  // Scope to orgs that actually have a plan we can sync to. Free /
  // unplanned orgs are intentionally skipped — they're already in
  // the "no modules" state and a sync would suspend everything,
  // which is a no-op but burns D1 writes.
  const rows = await env.DB.prepare(
    `SELECT id, billing_status FROM organizations
     WHERE plan_id IS NOT NULL`,
  ).all<{ id: number; billing_status: string }>();

  for (const row of rows.results ?? []) {
    result.scanned += 1;
    if (row.billing_status === "cancelled") {
      result.skipped += 1;
      continue;
    }
    try {
      await syncOrgModulesToPlan(env, row.id, {
        // billingStatusOverride deliberately omitted — pulls the
        // current row's billing_status so trialing orgs stay
        // trialing, active stays active, etc. The 0164 migration
        // only touches plan_id, so the bulk sync just needs to
        // propagate that change to org_modules.
      });
      result.synced += 1;
    } catch (err) {
      result.failures.push({
        org_id: row.id,
        error:  err instanceof Error ? err.message : "sync failed",
      });
    }
  }

  return json({ success: true, data: result }, 200, origin);
}
