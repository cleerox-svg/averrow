// Averrow — module usage instrumentation
//
// Records per-tenant per-module usage to `org_usage_daily` with a
// composite PK (org_id, module_key, metric_key, day). Pattern mirrors
// `agent_budget_rollups` — single-row UPSERT on each call so reads
// stay cheap (no SUM scans).
//
// Customer-facing reads are KV-cached (60s TTL) since dashboards hit
// the same metrics on every navigation.
//
// See:
//   - `migrations/0146_module_metric_definitions.sql` — metric catalogue
//   - `migrations/0147_org_usage_daily.sql`           — rollup table
//   - `lib/entitlements.ts`                           — sister: licensing
//   - `eager-moseying-papert.md`                      — Phase A foundation

import type { Env } from "../types";
import type { ModuleKey } from "./entitlements";
import { cachedValue } from "./cached-value";

export interface UsageMetricDef {
  module_key:  string;
  metric_key:  string;
  label:       string;
  unit:        string;
  is_billable: number;
  description: string | null;
}

export interface UsageRollupRow {
  module_key: string;
  metric_key: string;
  day:        string;
  value:      number;
}

const USAGE_TTL_SECONDS = 60; // hot path — dashboards refresh often

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function usageCacheKey(orgId: number, moduleKey: string | null, day: string): string {
  return moduleKey
    ? `usage.org.${orgId}.${moduleKey}.${day}`
    : `usage.org.${orgId}.all.${day}`;
}

/**
 * Record `delta` (default 1) usage for an org's module metric on
 * today's UTC day. Idempotent on (org, module, metric, day) — re-runs
 * accumulate via `value = value + ?`.
 *
 * Caller responsibility: only call from inside a request that's
 * already entitlement-checked. This helper does NOT verify the org
 * has the module enabled.
 */
export async function recordUsage(
  env:       Env,
  orgId:     number,
  moduleKey: ModuleKey,
  metricKey: string,
  delta:     number = 1,
): Promise<void> {
  if (delta === 0) return;
  const day = todayUtc();
  await env.DB.prepare(
    `INSERT INTO org_usage_daily (org_id, module_key, metric_key, day, value, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(org_id, module_key, metric_key, day) DO UPDATE SET
       value      = value + excluded.value,
       updated_at = datetime('now')`,
  )
    .bind(orgId, moduleKey, metricKey, day, delta)
    .run();

  // Cache busts: the per-module rollup AND the all-modules rollup
  // for today both stop being valid. Tomorrow's keys are unaffected.
  await Promise.all([
    env.CACHE.delete(`cv:${usageCacheKey(orgId, moduleKey, day)}`),
    env.CACHE.delete(`cv:${usageCacheKey(orgId, null, day)}`),
  ]);
}

/**
 * Read this month's usage for one (org, module). KV-cached 60s.
 * Returns one row per metric — caller joins to
 * `module_metric_definitions` for labels/units.
 */
export async function getMonthlyUsage(
  env:       Env,
  orgId:     number,
  moduleKey: ModuleKey,
): Promise<UsageRollupRow[]> {
  const day = todayUtc();
  return cachedValue<UsageRollupRow[]>(env, usageCacheKey(orgId, moduleKey, day), USAGE_TTL_SECONDS, async () => {
    const result = await env.DB.prepare(
      `SELECT module_key, metric_key, day, SUM(value) AS value
       FROM org_usage_daily
       WHERE org_id = ? AND module_key = ?
         AND day >= strftime('%Y-%m-01', 'now')
       GROUP BY metric_key
       ORDER BY metric_key`,
    )
      .bind(orgId, moduleKey)
      .all<UsageRollupRow>();
    return result.results ?? [];
  });
}

/**
 * Read this month's usage across every module the org has touched.
 * Used by the org dashboard (a single card listing everything).
 */
export async function getMonthlyUsageAcrossModules(
  env:   Env,
  orgId: number,
): Promise<UsageRollupRow[]> {
  const day = todayUtc();
  return cachedValue<UsageRollupRow[]>(env, usageCacheKey(orgId, null, day), USAGE_TTL_SECONDS, async () => {
    const result = await env.DB.prepare(
      `SELECT module_key, metric_key, day, SUM(value) AS value
       FROM org_usage_daily
       WHERE org_id = ?
         AND day >= strftime('%Y-%m-01', 'now')
       GROUP BY module_key, metric_key
       ORDER BY module_key, metric_key`,
    )
      .bind(orgId)
      .all<UsageRollupRow>();
    return result.results ?? [];
  });
}

/**
 * Catalogue of what's measured. Loaded once, reused for the lifetime
 * of the worker. Cached 24h since definitions change only on
 * migrations.
 */
export async function listMetricDefinitions(env: Env): Promise<UsageMetricDef[]> {
  return cachedValue<UsageMetricDef[]>(env, "usage.metric_defs", 24 * 60 * 60, async () => {
    const result = await env.DB.prepare(
      `SELECT module_key, metric_key, label, unit, is_billable, description
       FROM module_metric_definitions
       ORDER BY module_key, metric_key`,
    ).all<UsageMetricDef>();
    return result.results ?? [];
  });
}
