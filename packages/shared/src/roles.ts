// Display labels for global user roles (`users.role`). Single source of
// truth for the profile menu and the shared ProfilePage identity card.
// Mirrors `UserRole` in averrow-worker/src/types.ts.

export const USER_ROLES = [
  'super_admin', 'admin', 'analyst', 'sales',
  'support', 'billing', 'auditor', 'client',
] as const;

export type UserRoleKey = (typeof USER_ROLES)[number];

export const ROLE_LABELS: Record<UserRoleKey, string> = {
  super_admin: 'Super Admin',
  admin:       'Admin',
  analyst:     'Analyst',
  sales:       'Sales',
  support:     'Support',
  billing:     'Billing',
  auditor:     'Auditor',
  client:      'Client',
};

/** Human label for a role key; unknown keys fall back to the raw value. */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return ROLE_LABELS.client;
  return (ROLE_LABELS as Record<string, string>)[role] ?? role;
}
