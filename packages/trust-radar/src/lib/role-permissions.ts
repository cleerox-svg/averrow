// Role → permission matrix for fine-grained staff access decisions.
//
// The hierarchy in middleware/auth.ts ROLE_HIERARCHY is good for
// "is this user staff or a customer" questions. It can't capture
// the differentiated permissions of the four sub-roles (analyst,
// sales, support, billing) — they all sit at the same level but
// have different jobs.
//
// Use roleHasPermission() in handlers when the access decision is
// about WHAT the user can DO, not just whether they're an
// employee. Routes that gate on "can edit pricing" or "can resolve
// alerts" should call this rather than reading ctx.role directly.
//
// Permission flag semantics:
//
//   read_customers   — list orgs, view org detail, browse members
//   edit_pricing     — change plan + pricing overrides
//   edit_alerts      — acknowledge / resolve / dismiss alerts
//   manage_takedowns — create / submit / mark resolved
//   manage_invites   — invite + remove staff users (super_admin only
//                      can invite super_admins; admin can invite
//                      anything below admin)
//   view_billing     — read Stripe data, see customer plans
//   view_audit       — see audit logs, IP / device session metadata
//
// New flags get added here + a corresponding entry on every role
// row. `roleHasPermission` resolves to true via direct flag
// membership; the special-case for super_admin and admin is that
// they grant everything.

import type { UserRole } from "../types";

export type StaffPermission =
  | "read_customers"
  | "edit_pricing"
  | "edit_alerts"
  | "manage_takedowns"
  | "manage_invites"
  | "view_billing"
  | "view_audit";

const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<StaffPermission>> = {
  super_admin: new Set<StaffPermission>([
    "read_customers", "edit_pricing", "edit_alerts", "manage_takedowns",
    "manage_invites", "view_billing", "view_audit",
  ]),
  admin: new Set<StaffPermission>([
    "read_customers", "edit_pricing", "edit_alerts", "manage_takedowns",
    "manage_invites", "view_billing", "view_audit",
  ]),
  analyst: new Set<StaffPermission>([
    "read_customers", "edit_alerts", "manage_takedowns", "view_audit",
  ]),
  sales: new Set<StaffPermission>([
    "read_customers", "edit_pricing", "manage_invites", "view_billing",
  ]),
  support: new Set<StaffPermission>([
    "read_customers", "edit_alerts",
  ]),
  billing: new Set<StaffPermission>([
    "edit_pricing", "view_billing",
  ]),
  client: new Set<StaffPermission>(),
};

/** True if the role grants the named permission. */
export function roleHasPermission(role: UserRole, permission: StaffPermission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Compact list of permissions a role grants — used by /api/auth/me
 *  and the admin user-list UI to show the badge set. Exposing this
 *  to the client lets the SPA gate UI affordances (hide buttons the
 *  current user can't act on) without re-deriving the permission
 *  set per surface. */
export function listRolePermissions(role: UserRole): StaffPermission[] {
  return Array.from(ROLE_PERMISSIONS[role] ?? []);
}

/** True if the role is any Averrow-staff role (i.e. NOT 'client'). */
export function isStaffRole(role: UserRole): boolean {
  return role !== "client";
}
