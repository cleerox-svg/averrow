// One role badge for every surface (avatar menu, profile hero, profile rows):
// sentence-case label (from ROLE_LABELS) + tone (blue = analysts, neutral =
// everyone else; platform admins are neutral too since the facelift flip,
// because amber is a status colour now — with FACELIFT reverted they keep the
// legacy amber `medium` tone).

import { roleLabel } from '../../roles';
import type { BadgeProps } from '../Badge';
import { FACELIFT } from '../../theme/appearanceDefaults';

export interface RoleBadgeProps {
  label: string;
  tone: Pick<BadgeProps, 'severity' | 'status'>;
}

export function roleBadgeProps(role: string | null | undefined): RoleBadgeProps {
  const key = (role ?? '').toLowerCase();
  const label = roleLabel(key || null);
  if (key === 'super_admin' || key === 'admin') return { label, tone: FACELIFT ? { status: 'draft' } : { severity: 'medium' } };
  if (key === 'analyst') return { label, tone: { severity: 'low' } };
  return { label, tone: { status: 'draft' } };
}
