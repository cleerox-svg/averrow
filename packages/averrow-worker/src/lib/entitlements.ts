// Averrow — module entitlement helpers
//
// v3 introduces per-tenant **module licensing**. A tenant has an
// `org_modules` row per module they're entitled to (status: 'active',
// 'trial', or 'suspended'). This file is the canonical reader.
//
// Pattern mirrors `lib/cached-value.ts` (KV-cached, KV reads free
// vs D1) so entitlement checks don't tax D1 on every request — the
// hot path is `requireModule()` running on every module-scoped
// handler call.
//
// See:
//   - `migrations/0145_org_modules.sql` — schema
//   - `eager-moseying-papert.md` — Phase A foundation
//   - `lib/module-usage.ts`        — sister: usage tracking

import type { Env } from "../types";
import { cachedValue } from "./cached-value";

// Canonical module keys. Mirrors the seed in
// `migrations/0146_module_metric_definitions.sql`. Keep in sync.
export const MODULE_KEYS = [
  "domain",
  "social",
  "app_store",
  "dark_web",
  "abuse_mailbox",
  "trademark",
  "threat_actor",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export type ModuleStatus = "active" | "suspended" | "trial";

export interface OrgModule {
  module_key:    ModuleKey;
  status:        ModuleStatus;
  activated_at:  string;
  suspended_at:  string | null;
  trial_ends_at: string | null;
  config_json:   string | null;
}

const ENTITLEMENT_TTL_SECONDS = 120; // 2-min cache; entitlement flips are rare

function cacheKey(orgId: number): string {
  return `entitlements.org.${orgId}`;
}

/**
 * Returns every active or trial module the tenant has access to.
 * Suspended modules are filtered out. Trial modules whose
 * `trial_ends_at` has passed are also filtered.
 */
export async function listEnabledModules(env: Env, orgId: number): Promise<OrgModule[]> {
  const rows = await cachedValue<OrgModule[]>(env, cacheKey(orgId), ENTITLEMENT_TTL_SECONDS, async () => {
    const result = await env.DB.prepare(
      `SELECT module_key, status, activated_at, suspended_at, trial_ends_at, config_json
       FROM org_modules
       WHERE org_id = ? AND status IN ('active', 'trial')`,
    )
      .bind(orgId)
      .all<OrgModule>();
    return result.results ?? [];
  });

  // Trial expiry is post-cache so we don't have to bust the cache
  // when a trial ticks over its expiry minute.
  const now = Date.now();
  return rows.filter((row) => {
    if (row.status !== "trial") return true;
    if (!row.trial_ends_at) return true;
    return new Date(row.trial_ends_at).getTime() > now;
  });
}

/** True iff the tenant has an active or non-expired trial entitlement to this module. */
export async function isModuleEnabled(
  env: Env,
  orgId: number,
  moduleKey: ModuleKey,
): Promise<boolean> {
  const enabled = await listEnabledModules(env, orgId);
  return enabled.some((m) => m.module_key === moduleKey);
}

/**
 * Throws a `ModuleNotEntitledError` if the tenant doesn't have the
 * module. Use as a guard in module-scoped handlers.
 *
 *   await requireModule(env, orgId, 'domain');
 *
 * Caller catches and returns a 403 with a customer-friendly body.
 */
export class ModuleNotEntitledError extends Error {
  constructor(
    public readonly orgId:     number,
    public readonly moduleKey: ModuleKey,
  ) {
    super(`Org ${orgId} is not entitled to module '${moduleKey}'`);
    this.name = "ModuleNotEntitledError";
  }
}

export async function requireModule(
  env: Env,
  orgId: number,
  moduleKey: ModuleKey,
): Promise<void> {
  if (!(await isModuleEnabled(env, orgId, moduleKey))) {
    throw new ModuleNotEntitledError(orgId, moduleKey);
  }
}

/**
 * Activate a module for a tenant. Idempotent — re-running with the
 * same arguments resets `suspended_at` and `updated_at`. Used by
 * super_admin onboarding + Stripe webhook handlers.
 */
export async function activateModule(
  env: Env,
  orgId: number,
  moduleKey: ModuleKey,
  options: { trialEndsAt?: string; configJson?: string } = {},
): Promise<void> {
  const status = options.trialEndsAt ? "trial" : "active";
  await env.DB.prepare(
    `INSERT INTO org_modules (org_id, module_key, status, activated_at, suspended_at, trial_ends_at, config_json, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), NULL, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(org_id, module_key) DO UPDATE SET
       status        = excluded.status,
       suspended_at  = NULL,
       trial_ends_at = excluded.trial_ends_at,
       config_json   = COALESCE(excluded.config_json, org_modules.config_json),
       updated_at    = datetime('now')`,
  )
    .bind(orgId, moduleKey, status, options.trialEndsAt ?? null, options.configJson ?? null)
    .run();
  await invalidateEntitlements(env, orgId);
}

/**
 * Suspend a module. Sets status='suspended'; the row is preserved so
 * we keep the activation history. Customers with a suspended module
 * see the module disappear from their sidebar but their data isn't
 * deleted.
 */
export async function suspendModule(
  env: Env,
  orgId: number,
  moduleKey: ModuleKey,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE org_modules
     SET status = 'suspended', suspended_at = datetime('now'), updated_at = datetime('now')
     WHERE org_id = ? AND module_key = ?`,
  )
    .bind(orgId, moduleKey)
    .run();
  await invalidateEntitlements(env, orgId);
}

/** KV cache bust. Called from activate/suspend so flips show up immediately.
 *  No-op when env.CACHE isn't bound — unit tests pass `{ DB }` only. */
async function invalidateEntitlements(env: Env, orgId: number): Promise<void> {
  // The `cachedValue` helper uses CACHE_PREFIX + key; we mirror it
  // here. Keeping the prefix string in sync with cached-value.ts is
  // a small risk; if it changes, both files update together.
  if (!env.CACHE) return;
  await env.CACHE.delete(`cv:entitlements.org.${orgId}`);
}

// ─── Plan-driven org_modules sync ────────────────────────────────

export interface SyncOrgModulesOptions {
  /** Optional explicit plan id (e.g. 'enterprise'). If omitted the
   *  function reads `organizations.plan_id` for the org. */
  planId?: string | null;
  /** Optional override for billing_status. Determines whether modules
   *  land as 'active' (default), 'trial', or 'suspended'. */
  billingStatusOverride?: "trialing" | "active" | "past_due" | "cancelled" | "unbilled";
  /** ISO trial-end timestamp passed through to org_modules.trial_ends_at. */
  trialEndsAt?: string | null;
  /** À-la-carte modules to add on top of whatever the plan covers.
   *  Used by the Stripe webhook when subscription items include
   *  per-module prices that aren't part of the tier bundle. */
  extraModules?: ModuleKey[];
  /** Caller-supplied plan bundle. When set, the helper skips the
   *  `pricing_plans` SELECT and uses this list as the plan's
   *  included modules. Useful for the Stripe handler, which already
   *  resolved the plan via stripe_price_id and parsed
   *  `included_modules` in one round-trip. */
  planModulesOverride?: ModuleKey[];
}

export interface SyncOrgModulesResult {
  org_id:         number;
  plan_id:        string | null;
  billing_status: string;
  modules_active: ModuleKey[];
}

/**
 * Idempotently align an org's `org_modules` rows with its current
 * `plan_id`. Reads the plan's `included_modules` JSON from
 * `pricing_plans`, then:
 *   - activates (or sets to 'trial' / 'suspended' depending on
 *     billing_status) every module in the plan
 *   - suspends every active/trial module NOT in the plan (downgrade
 *     handling)
 *   - invalidates the KV entitlement cache so the change shows up
 *     on the next request
 *
 * The Stripe webhook handler delegates to this. An admin "sync now"
 * endpoint also calls it for orgs whose plan was set offline (e.g.
 * enterprise customers without a Stripe subscription). Safe to call
 * any number of times.
 */
export async function syncOrgModulesToPlan(
  env: Env,
  orgId: number,
  options: SyncOrgModulesOptions = {},
): Promise<SyncOrgModulesResult> {
  // Resolve effective plan_id + billing_status. The Stripe handler
  // hands both in (subscription is the source of truth there); admin
  // "sync now" calls pass neither and we read the current snapshot
  // from the DB. Only hit organizations when needed so the unit
  // tests for syncOrgFromSubscription don't have to mock that row.
  let planId: string | null;
  let billingStatus: string;
  if (options.planId !== undefined && options.billingStatusOverride !== undefined) {
    planId = options.planId;
    billingStatus = options.billingStatusOverride;
  } else {
    const orgRow = await env.DB.prepare(
      `SELECT plan_id, billing_status FROM organizations WHERE id = ?`,
    ).bind(orgId).first<{ plan_id: string | null; billing_status: string }>();
    if (!orgRow) {
      throw new Error(`Org ${orgId} not found`);
    }
    planId = options.planId !== undefined ? options.planId : orgRow.plan_id;
    billingStatus = options.billingStatusOverride ?? orgRow.billing_status;
  }

  const planModules = new Set<ModuleKey>();
  if (options.planModulesOverride) {
    for (const m of options.planModulesOverride) planModules.add(m);
  } else if (planId) {
    const planRow = await env.DB.prepare(
      `SELECT included_modules FROM pricing_plans WHERE id = ? AND is_active = 1`,
    ).bind(planId).first<{ included_modules: string }>();
    if (planRow?.included_modules) {
      try {
        const parsed = JSON.parse(planRow.included_modules) as unknown;
        if (Array.isArray(parsed)) {
          for (const m of parsed) {
            if (typeof m === "string" && (MODULE_KEYS as readonly string[]).includes(m)) {
              planModules.add(m as ModuleKey);
            }
          }
        }
      } catch {
        // Bad JSON in the plan row — fail soft, leave planModules empty.
      }
    }
  }

  // Union of plan-bundled modules + à-la-carte extras (Stripe items).
  const enabledModules: ModuleKey[] = Array.from(
    new Set<ModuleKey>([...planModules, ...(options.extraModules ?? [])]),
  );

  // Decide the per-module status from billing_status. Mirror of the
  // Stripe handler's logic, kept in one place so the policy doesn't
  // drift across call sites.
  const isLive = billingStatus === "trialing" || billingStatus === "active";
  const moduleStatus: ModuleStatus =
    billingStatus === "trialing" ? "trial" : isLive ? "active" : "suspended";

  // 1. Activate every module the plan covers.
  for (const moduleKey of enabledModules) {
    await env.DB.prepare(
      `INSERT INTO org_modules (org_id, module_key, status, activated_at, suspended_at, trial_ends_at)
       VALUES (?, ?, ?, datetime('now'), NULL, ?)
       ON CONFLICT(org_id, module_key) DO UPDATE SET
         status        = excluded.status,
         activated_at  = COALESCE(org_modules.activated_at, excluded.activated_at),
         suspended_at  = NULL,
         trial_ends_at = excluded.trial_ends_at`,
    ).bind(orgId, moduleKey, moduleStatus, options.trialEndsAt ?? null).run();
  }

  // 2. Suspend modules currently active/trial but NOT in the new
  //    plan (downgrade path). When enabledModules is empty (plan
  //    cancelled or unknown), this suspends everything. We use
  //    plain UPDATE without RETURNING because the unit test mock
  //    captures `.run()` calls only.
  const placeholders = enabledModules.length > 0
    ? enabledModules.map(() => "?").join(",")
    : "''";
  await env.DB.prepare(
    `UPDATE org_modules
     SET status = 'suspended', suspended_at = datetime('now')
     WHERE org_id = ?
       AND status IN ('active', 'trial')
       AND module_key NOT IN (${placeholders})`,
  ).bind(orgId, ...enabledModules).run();

  await invalidateEntitlements(env, orgId);

  return {
    org_id:         orgId,
    plan_id:        planId,
    billing_status: billingStatus,
    modules_active: enabledModules,
  };
}
