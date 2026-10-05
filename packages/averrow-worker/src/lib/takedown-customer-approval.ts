// Averrow — "did the CUSTOMER approve this takedown?" (G21, owner decision
// 2026-10-05). The single definition shared by every send path: the staff
// hand-submit + ops "mark submitted" PATCH (handlers/takedowns.ts) and
// Sparrow Phase G auto-submit (agents/sparrow.ts).
//
// Approval is provenance-checked, never read off the status alone: the ops
// PATCH lets staff move draft → requested (the ops queue's "ready" step), so
// status 'requested' may be staff-set. Only the tenant PATCH
// (PATCH /api/orgs/:orgId/takedowns/:id, which refuses every staff caller)
// stamps requested_at, together with requested_by = the approving member.
// A staff requested_by (legacy, pre-refuseStaffTenantWrite) or a user row
// that no longer exists is NOT an approval (fail closed).

import type { Env } from "../types";
import { isPlatformStaff } from "../middleware/auth";

export interface TakedownApprovalFields {
  status:       string;
  requested_at: string | null;
  requested_by: string | null;
}

export async function isCustomerApproved(env: Env, row: TakedownApprovalFields): Promise<boolean> {
  if (row.status !== "requested" || !row.requested_at || !row.requested_by) return false;
  const approver = await env.DB.prepare("SELECT role FROM users WHERE id = ?")
    .bind(row.requested_by).first<{ role: string }>();
  return approver !== null && approver !== undefined && !isPlatformStaff(approver.role);
}
