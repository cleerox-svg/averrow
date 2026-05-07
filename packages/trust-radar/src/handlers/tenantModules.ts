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
} from "../lib/entitlements";
import {
  listMetricDefinitions,
  getMonthlyUsageAcrossModules,
  type UsageMetricDef,
  type UsageRollupRow,
} from "../lib/module-usage";

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

  // Three reads, one round-trip — entitlements + defs + usage all
  // KV-cached so the hot path is mostly KV.
  const [enabled, defs, usage] = await Promise.all([
    listEnabledModules(env, orgIdNum),
    listMetricDefinitions(env),
    getMonthlyUsageAcrossModules(env, orgIdNum),
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

  return json({
    success: true,
    data: {
      org_id: orgIdNum,
      modules: surface,
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
