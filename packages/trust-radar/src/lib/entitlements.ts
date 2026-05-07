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

/** KV cache bust. Called from activate/suspend so flips show up immediately. */
async function invalidateEntitlements(env: Env, orgId: number): Promise<void> {
  // The `cachedValue` helper uses CACHE_PREFIX + key; we mirror it
  // here. Keeping the prefix string in sync with cached-value.ts is
  // a small risk; if it changes, both files update together.
  await env.CACHE.delete(`cv:entitlements.org.${orgId}`);
}
