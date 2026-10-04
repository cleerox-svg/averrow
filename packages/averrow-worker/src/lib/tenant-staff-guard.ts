// Averrow — staff refusal on tenant (customer) WRITE routes.
//
// Owner decision 2026-10-04: staff actions on customer data are visible to
// customers but branded "Averrow SOC"; a staff member is never named or
// identified to a customer, and staff notes stay internal. Global
// super_admin (and the minted auditor) pass the tenant org gates
// (requireOrgMember / verifyOrgAccess / canPerformHITL / requireOrgAdmin /
// checkOrgAccess) via hasGlobalReadScope, so without this refusal a staff
// write lands in the customer's records, audit log and webhooks under the
// staff member's own user id.
//
// Every tenant write that is NOT a staff-on-tenant flow by design calls
// refuseStaffTenantWrite() right after its org-access check. The by-design
// exceptions (org membership / invites / brands / api keys / integrations /
// webhook / ownership transfer — CLAUDE.md §7 "Org owner seats") keep
// working and mask the staff actor on their customer-visible outputs
// instead. Billing checkout/portal sessions (handlers/tenantBilling.ts) are
// refused too: a staff checkout would stamp the staff email as the
// customer's Stripe customer_email. Tenant alert writes have their own message
// (STAFF_TENANT_ALERT_WRITE_ERROR in handlers/tenantData.ts).

import { json } from "./cors";
import { isPlatformStaff } from "../middleware/auth";
import type { AuthContext } from "../middleware/auth";

export const STAFF_TENANT_WRITE_ERROR = "Staff must work from the Averrow console";

/** 403 Response when the caller is platform staff (any non-client global
 *  role, incl. the lead-conversion placeholder super_admin), else null. */
export function refuseStaffTenantWrite(
  ctx: Pick<AuthContext, "role">,
  origin: string | null,
): Response | null {
  if (!isPlatformStaff(ctx.role)) return null;
  return json({ success: false, error: STAFF_TENANT_WRITE_ERROR }, 403, origin);
}
