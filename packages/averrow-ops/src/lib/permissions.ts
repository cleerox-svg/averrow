// Frontend mirror of packages/trust-radar/src/lib/role-permissions.ts.
//
// The worker is the source of truth — every endpoint enforces these flags
// server-side. This client-side copy exists only to show/hide UI coherently
// (e.g. gate /admin/pricing on view_billing/edit_pricing instead of
// super_admin, per the documented model — audit GM2). Keep in sync with the
// backend matrix.

export type StaffPermission =
  | 'read_customers'
  | 'edit_pricing'
  | 'edit_alerts'
  | 'manage_takedowns'
  | 'manage_invites'
  | 'view_billing'
  | 'view_audit';

const ROLE_PERMISSIONS: Record<string, StaffPermission[]> = {
  super_admin: ['read_customers', 'edit_pricing', 'edit_alerts', 'manage_takedowns', 'manage_invites', 'view_billing', 'view_audit'],
  admin:       ['read_customers', 'edit_pricing', 'edit_alerts', 'manage_takedowns', 'manage_invites', 'view_billing', 'view_audit'],
  analyst:     ['read_customers', 'edit_alerts', 'manage_takedowns', 'view_audit'],
  sales:       ['read_customers', 'edit_pricing', 'manage_invites', 'view_billing'],
  support:     ['read_customers', 'edit_alerts'],
  billing:     ['edit_pricing', 'view_billing'],
  auditor:     ['read_customers', 'view_billing', 'view_audit'],
  client:      [],
};

export function roleHasPermission(role: string | null | undefined, permission: StaffPermission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
