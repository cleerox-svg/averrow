// Stripe event → Averrow state sync.
//
// Maps the four event families we care about onto our org +
// org_modules state:
//
//   customer.subscription.created   → first subscription. Resolve
//                                     org via customer_id, set
//                                     plan_id + trial_ends_at +
//                                     billing_status. Sync
//                                     org_modules from the plan's
//                                     included_modules + any per-
//                                     module subscription items.
//
//   customer.subscription.updated   → status change (trial→active,
//                                     plan switch, paused/resumed).
//                                     Same sync as created.
//
//   customer.subscription.deleted   → cancellation. billing_status
//                                     → 'cancelled'; org_modules
//                                     entries get suspended (status
//                                     'suspended', suspended_at
//                                     stamped).
//
//   invoice.payment_failed          → billing_status → 'past_due'.
//                                     Don't touch org_modules yet —
//                                     Stripe retries automatically;
//                                     we wait for the eventual
//                                     subscription.deleted before
//                                     suspending entitlements.
//
//   invoice.payment_succeeded       → if was 'past_due', flip back
//                                     to 'active'.
//
// Subscription status mapping (Stripe → us):
//   trialing      → trialing
//   active        → active
//   past_due      → past_due
//   canceled      → cancelled
//   incomplete    → unbilled (waiting for first payment)
//   incomplete_expired → cancelled
//   unpaid        → past_due
//   paused        → past_due (Stripe pause behaves like delinquency)
//
// v3 Phase D Stripe sprint 4.

import type { Env } from "../types";
import { syncOrgModulesToPlan, type ModuleKey } from "./entitlements";

// ─── Event payload shapes (subset of Stripe's API) ─────────────

export interface StripeEvent {
  id:           string;
  type:         string;
  api_version?: string;
  livemode?:    boolean;
  data:         { object: unknown };
}

export interface StripeSubscription {
  id:                  string;
  customer:            string;
  status:              string;     // trialing | active | past_due | canceled | …
  trial_end:           number | null;  // unix seconds
  cancel_at_period_end?: boolean;
  items:               { data: Array<StripeSubscriptionItem> };
  metadata?:           Record<string, string>;
}

export interface StripeSubscriptionItem {
  id:    string;
  price: { id: string };
}

export interface StripeInvoice {
  id:           string;
  customer:     string;
  subscription: string | null;
}

// ─── Status mapping ─────────────────────────────────────────────

export type BillingStatus =
  | "unbilled"
  | "trialing"
  | "active"
  | "past_due"
  | "cancelled";

export function mapSubscriptionStatus(stripeStatus: string): BillingStatus {
  switch (stripeStatus) {
    case "trialing":           return "trialing";
    case "active":             return "active";
    case "past_due":           return "past_due";
    case "unpaid":             return "past_due";
    case "paused":             return "past_due";
    case "canceled":           return "cancelled";
    case "incomplete_expired": return "cancelled";
    case "incomplete":         return "unbilled";
    default:                   return "unbilled";
  }
}

// ─── Org + plan resolution ──────────────────────────────────────

export async function findOrgByStripeCustomer(
  env:        Env,
  customerId: string,
): Promise<{ id: number } | null> {
  return env.DB.prepare(
    `SELECT id FROM organizations WHERE stripe_customer_id = ? LIMIT 1`,
  ).bind(customerId).first<{ id: number }>();
}

export async function findPlanByStripePriceId(
  env:           Env,
  stripePriceId: string,
): Promise<{ id: string; included_modules: string } | null> {
  return env.DB.prepare(
    `SELECT id, included_modules FROM pricing_plans WHERE stripe_price_id = ? LIMIT 1`,
  ).bind(stripePriceId).first<{ id: string; included_modules: string }>();
}

export async function findModuleKeyByStripePriceId(
  env:           Env,
  stripePriceId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT module_key FROM module_prices WHERE stripe_price_id = ? LIMIT 1`,
  ).bind(stripePriceId).first<{ module_key: string }>();
  return row?.module_key ?? null;
}

// ─── Subscription sync ─────────────────────────────────────────

export interface SyncResult {
  org_id:              number;
  billing_status:      BillingStatus;
  plan_id:             string | null;
  enabled_modules:     ModuleKey[];
  trial_ends_at:       string | null;
}

/**
 * Idempotent. Re-running with the same subscription data is safe —
 * we INSERT OR REPLACE on org_modules and full-row UPDATE on
 * organizations. Stripe re-deliveries are caught higher up via
 * stripe_webhook_events idempotency, but defense in depth.
 */
export async function syncOrgFromSubscription(
  env: Env,
  subscription: StripeSubscription,
): Promise<SyncResult | null> {
  const org = await findOrgByStripeCustomer(env, subscription.customer);
  if (!org) return null;

  const billingStatus = mapSubscriptionStatus(subscription.status);
  const trialEndsAt = subscription.trial_end !== null
    ? new Date(subscription.trial_end * 1000).toISOString().replace("T", " ").slice(0, 19)
    : null;

  // 1. Resolve plan + per-module items from subscription items.
  let resolvedPlanId: string | null = null;
  const includedModules = new Set<string>();
  const aLaCarteModules = new Set<string>();

  for (const item of subscription.items.data) {
    const priceId = item.price.id;
    const plan = await findPlanByStripePriceId(env, priceId);
    if (plan) {
      resolvedPlanId = plan.id;
      try {
        const parsed = JSON.parse(plan.included_modules) as unknown;
        if (Array.isArray(parsed)) {
          for (const m of parsed) {
            if (typeof m === "string") includedModules.add(m);
          }
        }
      } catch {
        // bad JSON — ignore, plan resolution still useful for billing
      }
      continue;
    }
    const moduleKey = await findModuleKeyByStripePriceId(env, priceId);
    if (moduleKey) aLaCarteModules.add(moduleKey);
  }

  const enabledModules = Array.from(new Set([...includedModules, ...aLaCarteModules])) as ModuleKey[];

  // 2. Update organizations row.
  await env.DB.prepare(
    `UPDATE organizations
     SET stripe_subscription_id = ?,
         plan_id                = ?,
         trial_ends_at          = ?,
         billing_status         = ?
     WHERE id = ?`,
  ).bind(
    subscription.id,
    resolvedPlanId,
    trialEndsAt,
    billingStatus,
    org.id,
  ).run();

  // 3. Sync org_modules to match the new entitlement set. Delegated
  //    to syncOrgModulesToPlan() in lib/entitlements.ts so the policy
  //    lives in one place.
  //
  //    Pass planModulesOverride so the helper doesn't re-SELECT the
  //    plan row — we already parsed `included_modules` above to
  //    populate `includedModules`. Same call also passes the explicit
  //    plan id (kept for the result struct + future logging) and
  //    skips the `organizations` SELECT.
  //
  //    À-la-carte modules from per-module Stripe items go through
  //    `extraModules` and land active alongside the plan's bundle.
  await syncOrgModulesToPlan(env, org.id, {
    planId:                resolvedPlanId,
    billingStatusOverride: billingStatus,
    trialEndsAt,
    planModulesOverride:   Array.from(includedModules) as ModuleKey[],
    extraModules:          Array.from(aLaCarteModules) as ModuleKey[],
  });

  return {
    org_id:          org.id,
    billing_status:  billingStatus,
    plan_id:         resolvedPlanId,
    enabled_modules: enabledModules,
    trial_ends_at:   trialEndsAt,
  };
}

/**
 * Mark org as cancelled. Suspends every active/trial module.
 */
export async function cancelOrgFromSubscription(
  env: Env,
  subscription: StripeSubscription,
): Promise<SyncResult | null> {
  const org = await findOrgByStripeCustomer(env, subscription.customer);
  if (!org) return null;

  await env.DB.prepare(
    `UPDATE organizations
     SET billing_status = 'cancelled'
     WHERE id = ?`,
  ).bind(org.id).run();

  await env.DB.prepare(
    `UPDATE org_modules
     SET status = 'suspended', suspended_at = datetime('now')
     WHERE org_id = ? AND status IN ('active', 'trial')`,
  ).bind(org.id).run();

  return {
    org_id:          org.id,
    billing_status:  "cancelled",
    plan_id:         null,
    enabled_modules: [],
    trial_ends_at:   null,
  };
}

/**
 * Flip billing_status to 'past_due' on payment failure. Does NOT
 * suspend modules — Stripe retries automatically, customer stays
 * functional through the dunning window. We only suspend on
 * the eventual subscription.deleted.
 */
export async function markOrgPastDue(env: Env, customerId: string): Promise<{ org_id: number } | null> {
  const org = await findOrgByStripeCustomer(env, customerId);
  if (!org) return null;
  await env.DB.prepare(
    `UPDATE organizations SET billing_status = 'past_due' WHERE id = ?`,
  ).bind(org.id).run();
  return { org_id: org.id };
}

/**
 * Flip billing_status from 'past_due' back to 'active' after a
 * successful retry. No-op if already 'active' or in another state.
 */
export async function clearOrgPastDue(env: Env, customerId: string): Promise<{ org_id: number } | null> {
  const org = await findOrgByStripeCustomer(env, customerId);
  if (!org) return null;
  await env.DB.prepare(
    `UPDATE organizations
     SET billing_status = 'active'
     WHERE id = ? AND billing_status = 'past_due'`,
  ).bind(org.id).run();
  return { org_id: org.id };
}
