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
// The approver must also still be an ACTIVE member of the takedown's own
// org (org_members.status = 'active') with an active, non-staff account
// (users.status = 'active') — appsec L2. A staff requested_by (legacy,
// pre-refuseStaffTenantWrite), a removed member, a disabled account, a
// member of a different org, or a user row that no longer exists is NOT an
// approval (fail closed). The lead-conversion placeholder is a staff account,
// so its membership never counts.

import type { Env } from "../types";
import { isPlatformStaff } from "../middleware/auth";

export interface TakedownApprovalFields {
  status:       string;
  org_id:       number | null;
  requested_at: string | null;
  requested_by: string | null;
}

export async function isCustomerApproved(env: Env, row: TakedownApprovalFields): Promise<boolean> {
  if (row.status !== "requested" || !row.requested_at || !row.requested_by) return false;
  if (row.org_id === null || row.org_id === undefined) return false;
  const approver = await env.DB.prepare(
    `SELECT u.role
     FROM users u
     JOIN org_members om ON om.user_id = u.id AND om.org_id = ? AND om.status = 'active'
     WHERE u.id = ? AND u.status = 'active'
     LIMIT 1`,
  ).bind(row.org_id, row.requested_by).first<{ role: string }>();
  return approver !== null && approver !== undefined && !isPlatformStaff(approver.role);
}
