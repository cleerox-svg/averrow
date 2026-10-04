// Tenant-facing billing read.
//
// Customers can see their own pricing summary at
// /api/orgs/:orgId/billing — same data shape as the super_admin
// equivalent (/api/admin/customers/:orgId/pricing) but scoped to
// the caller's org via verifyOrgAccess. super_admin reads any org.
//
// Read-only. The "change plan" / "update payment method" flows
// land in Stripe sprint 6 via Stripe Checkout + customer portal.
//
// v3 Phase D Stripe sprint 5.

import { json } from "../lib/cors";
import type { Env } from "../types";
import { verifyOrgAccess, isPlatformStaff } from "../middleware/auth";
import type { AuthContext } from "../middleware/auth";
import { requireOrgAdmin } from "./organizations";
import { STAFF_ROLE_LIST_SQL } from "../lib/lead-conversion-placeholder";
import { refuseReadOnlyGlobalWrite } from "../lib/tenant-staff-guard";
import { audit } from "../lib/audit";
import { getOrgPricingSummary, getPricingPlan } from "../lib/pricing";
import {
  createCheckoutSession,
  createPortalSession,
  StripeApiError,
} from "../lib/stripe-api";

export async function handleGetTenantBilling(
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

  const summary = await getOrgPricingSummary(env, orgIdNum);
  return json({ success: true, data: summary }, 200, origin);
}

/**
 * Stripe `customer_email` for a new checkout.
 *  - Customer caller: their own email (unchanged behavior).
 *  - Platform staff (crossover allowance): the org's customer owner — the
 *    first (lowest `org_members.id`) active `owner` membership whose user is
 *    active and NOT staff, so the lead-conversion placeholder super_admin
 *    never qualifies. No such owner → undefined; the checkout handler then
 *    refuses a staff caller with 409 rather than let Stripe prompt the staff
 *    member at the keyboard for an email (which would become the customer's
 *    Stripe email). The staff caller's own email is never returned.
 */
export async function customerEmailForCheckout(
  env:           Env,
  ctx:           Pick<AuthContext, "role" | "email">,
  orgIdNum:      number,
  callerDbEmail: string | null,
): Promise<string | undefined> {
  if (!isPlatformStaff(ctx.role)) return ctx.email ?? callerDbEmail ?? undefined;
  // STAFF_ROLE_LIST_SQL is compile-time role literals only (no request input).
  const owner = await env.DB.prepare(
    `SELECT u.email
     FROM org_members om
     JOIN users u ON u.id = om.user_id
     WHERE om.org_id = ? AND om.role = 'owner' AND om.status = 'active'
       AND u.status = 'active'
       AND u.role NOT IN (${STAFF_ROLE_LIST_SQL})
       AND u.email IS NOT NULL AND u.email != ''
     ORDER BY om.id ASC
     LIMIT 1`,
  ).bind(orgIdNum).first<{ email: string }>();
  return owner?.email ?? undefined;
}

// ─── POST /api/orgs/:orgId/billing/checkout-session ──────────────
//
// Creates a Stripe Checkout session for plan signup. Caller picks
// the plan; server resolves the plan's stripe_price_id, looks up
// (or builds) the customer, calls Stripe, and returns the redirect
// URL. Tenant SPA does window.location.href = url.

interface CheckoutBody {
  plan_id?:    unknown;
  return_path?: unknown;       // "/tenant/settings/billing" by default
}

export async function handleCreateCheckoutSession(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  // Billing management (checkout) is org-admin only — a viewer must not be
  // able to start a subscription change. requireOrgAdmin also enforces the
  // org-membership scope, so it fully subsumes the prior verifyOrgAccess.
  const roErr = refuseReadOnlyGlobalWrite(ctx, origin);
  if (roErr) return roErr;
  const denied = requireOrgAdmin(ctx, orgId, origin);
  if (denied) return denied;
  // Platform staff MAY start checkout on the customer's behalf — billing is
  // one of the four tenant surfaces in the staff crossover allowance (owner
  // decision 2026-10-04; lib/tenant-staff-guard.ts). The staff member's own
  // email is never sent to Stripe: see customerEmailForCheckout below.

  const apiKey = env.STRIPE_API_KEY;
  if (!apiKey) {
    return json({
      success: false,
      error: "Stripe is not configured. Set STRIPE_API_KEY in Worker secrets.",
    }, 503, origin);
  }

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  let body: CheckoutBody;
  try {
    body = await request.json() as CheckoutBody;
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400, origin);
  }

  if (typeof body.plan_id !== "string" || !body.plan_id) {
    return json({ success: false, error: "plan_id is required" }, 400, origin);
  }

  const plan = await getPricingPlan(env, body.plan_id);
  if (!plan) {
    return json({ success: false, error: "Pricing plan not found" }, 404, origin);
  }
  if (!plan.is_active) {
    return json({ success: false, error: "Pricing plan is not active" }, 400, origin);
  }
  if (!plan.stripe_price_id) {
    return json({
      success: false,
      error: "Plan is not yet wired in Stripe. Contact support@averrow.com.",
    }, 503, origin);
  }

  // Look up existing stripe_customer_id (and email) for the org.
  const orgRow = await env.DB.prepare(
    `SELECT o.stripe_customer_id, u.email
     FROM organizations o
     LEFT JOIN users u ON u.id = ?
     WHERE o.id = ?`,
  ).bind(ctx.userId, orgIdNum).first<{
    stripe_customer_id: string | null;
    email:              string | null;
  }>();

  if (!orgRow) {
    return json({ success: false, error: "Organization not found" }, 404, origin);
  }

  // Only needed when Stripe has no customer for the org yet.
  const customerEmail = orgRow.stripe_customer_id
    ? undefined
    : await customerEmailForCheckout(env, ctx, orgIdNum, orgRow.email);
  // A staff checkout with no Stripe customer and no customer owner would make
  // Stripe ask the staff member at the keyboard for an email, which then
  // becomes the customer's Stripe email. Refuse until the owner is invited.
  if (!orgRow.stripe_customer_id && !customerEmail && isPlatformStaff(ctx.role)) {
    return json({ success: false, error: "Invite the customer owner before starting checkout" }, 409, origin);
  }

  // success_url + cancel_url must be absolute. Use the request origin
  // (which is averrow.com in prod) so this works across environments.
  const requestOrigin = origin ?? "https://averrow.com";
  const returnPath = typeof body.return_path === "string" && body.return_path.startsWith("/tenant/")
    ? body.return_path
    : "/tenant/settings/billing";

  const successUrl = `${requestOrigin}${returnPath}?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl  = `${requestOrigin}${returnPath}?checkout=cancelled`;

  try {
    const session = await createCheckoutSession(apiKey, {
      customer:       orgRow.stripe_customer_id ?? undefined,
      customer_email: customerEmail,
      mode:           "subscription",
      line_items:     [{ price: plan.stripe_price_id, quantity: 1 }],
      success_url:    successUrl,
      cancel_url:     cancelUrl,
      client_reference_id: String(orgIdNum),
      subscription_data: {
        trial_period_days: plan.trial_days,
        metadata: { org_id: String(orgIdNum), plan_id: plan.id },
      },
      allow_promotion_codes: true,
    });
    // Customer-visible in the tenant audit log (staff actor → "Averrow SOC").
    await audit(env, {
      action: "billing_checkout_session", userId: ctx.userId,
      resourceType: "organization", resourceId: orgId,
      details: { org_id: orgId, plan_id: plan.id },
      outcome: "success", request,
    });
    return json({ success: true, data: { url: session.url, session_id: session.id } }, 200, origin);
  } catch (err) {
    const message = err instanceof StripeApiError
      ? `Stripe rejected the request: ${err.message}`
      : err instanceof Error ? err.message : "Checkout session create failed";
    const status  = err instanceof StripeApiError && err.status >= 400 && err.status < 500 ? 400 : 502;
    return json({ success: false, error: message }, status, origin);
  }
}

// ─── POST /api/orgs/:orgId/billing/portal-session ────────────────
//
// Redirects the customer to Stripe's customer portal where they can
// update payment method, view invoices, change plan, cancel.

interface PortalBody {
  return_path?: unknown;
}

export async function handleCreatePortalSession(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  // Portal access lets the customer cancel / change plan / view invoices —
  // org-admin only, not any viewer. requireOrgAdmin also enforces the
  // org-membership scope, so it fully subsumes the prior verifyOrgAccess.
  const roErr = refuseReadOnlyGlobalWrite(ctx, origin);
  if (roErr) return roErr;
  const denied = requireOrgAdmin(ctx, orgId, origin);
  if (denied) return denied;
  // Platform staff MAY open the portal on the customer's behalf (crossover
  // allowance, owner decision 2026-10-04; lib/tenant-staff-guard.ts). The
  // session carries only the org's Stripe customer id + a return URL —
  // nothing that identifies the caller.

  const apiKey = env.STRIPE_API_KEY;
  if (!apiKey) {
    return json({
      success: false,
      error: "Stripe is not configured. Set STRIPE_API_KEY in Worker secrets.",
    }, 503, origin);
  }

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  let body: PortalBody;
  try {
    body = await request.json() as PortalBody;
  } catch {
    body = {};
  }

  const orgRow = await env.DB.prepare(
    `SELECT stripe_customer_id FROM organizations WHERE id = ?`,
  ).bind(orgIdNum).first<{ stripe_customer_id: string | null }>();

  if (!orgRow) {
    return json({ success: false, error: "Organization not found" }, 404, origin);
  }
  if (!orgRow.stripe_customer_id) {
    return json({
      success: false,
      error: "Organization has no Stripe customer yet — start with a checkout session first.",
    }, 400, origin);
  }

  const requestOrigin = origin ?? "https://averrow.com";
  const returnPath = typeof body.return_path === "string" && body.return_path.startsWith("/tenant/")
    ? body.return_path
    : "/tenant/settings/billing";

  try {
    const session = await createPortalSession(apiKey, {
      customer:    orgRow.stripe_customer_id,
      return_url:  `${requestOrigin}${returnPath}`,
    });
    await audit(env, {
      action: "billing_portal_session", userId: ctx.userId,
      resourceType: "organization", resourceId: orgId,
      details: { org_id: orgId },
      outcome: "success", request,
    });
    return json({ success: true, data: { url: session.url } }, 200, origin);
  } catch (err) {
    const message = err instanceof StripeApiError
      ? `Stripe rejected the request: ${err.message}`
      : err instanceof Error ? err.message : "Portal session create failed";
    const status  = err instanceof StripeApiError && err.status >= 400 && err.status < 500 ? 400 : 502;
    return json({ success: false, error: message }, status, origin);
  }
}
