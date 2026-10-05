// One role badge for every surface (avatar menu, profile hero, profile rows):
// sentence-case label (from ROLE_LABELS) + tone (amber = platform admins,
// blue = analysts, neutral = everyone else).

import { roleLabel } from '../../roles';
import type { BadgeProps } from '../Badge';

export interface RoleBadgeProps {
  label: string;
  tone: Pick<BadgeProps, 'severity' | 'status'>;
}

export function roleBadgeProps(role: string | null | undefined): RoleBadgeProps {
  const key = (role ?? '').toLowerCase();
  const label = roleLabel(key || null);
  if (key === 'super_admin' || key === 'admin') return { label, tone: { severity: 'medium' } };
  if (key === 'analyst') return { label, tone: { severity: 'low' } };
  return { label, tone: { status: 'draft' } };
}
