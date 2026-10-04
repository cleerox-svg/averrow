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
// instead.
//
// STAFF CROSSOVER ALLOWANCE (owner decision 2026-10-04, the single customer-
// data exception): staff may manage these four surfaces on the customer's
// behalf, so they do NOT call refuseStaffTenantWrite —
//   1. executives          — handlers/tenantExecutives.ts (create/PATCH/PUT/DELETE)
//   2. monitoring rules    — handlers/tenantData.ts handleUpdateMonitoringConfig
//   3. trademark assets    — handlers/tenantTrademarkModule.ts (upload/delete)
//   4. billing             — handlers/tenantBilling.ts (checkout/portal; a staff
//                            checkout sends the org's CUSTOMER owner email to
//                            Stripe, never the staff email; with no Stripe
//                            customer and no customer owner it is 409)
// Org access is NOT widened: staff still pass each handler's own org gate
// (requireOrgAdmin / canPerformHITL / canManageAssets), which in practice
// means super_admin (global) or a staff member holding a qualifying org
// membership (the lead-conversion placeholder owner). The staff actor is
// masked on every customer-visible output ("Averrow SOC"). Every OTHER
// customer-data write (investigations, takedowns, abuse-mailbox status,
// takedown authorization, alerts) stays refused. Tenant alert writes have
// their own message (STAFF_TENANT_ALERT_WRITE_ERROR in handlers/tenantData.ts).

import { json } from "./cors";
import { isPlatformStaff, isReadOnlyGlobalRole } from "../middleware/auth";
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

/** 403 Response for the read-only global seat (`auditor`), else null.
 *  Explicit write-guard on the four staff crossover surfaces — the same
 *  `isReadOnlyGlobalRole` block the abuse-mailbox status writers carry —
 *  so auditor stays refused even if a handler's org-role gate changes. */
export function refuseReadOnlyGlobalWrite(
  ctx: Pick<AuthContext, "role">,
  origin: string | null,
): Response | null {
  if (!isReadOnlyGlobalRole(ctx.role)) return null;
  return json({ success: false, error: "Forbidden: read-only role" }, 403, origin);
}
