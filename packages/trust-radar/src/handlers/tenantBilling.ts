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
import type { AuthContext } from "../middleware/auth";
import { getOrgPricingSummary } from "../lib/pricing";

function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

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
