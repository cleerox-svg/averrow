// @averrow/shared/ui/settings — AccountHero (ACCOUNT_DESIGN_SPEC §3)
//
// "This is you" identity card: the one glowing (amber) Card on the page.
// Initials-only squircle avatar in the static self colour — NEVER a profile
// picture (SHARED_LOGIN_SPEC §3): there is deliberately no avatar-URL prop.
//
// Pure presentation: pass already-resolved strings/flags. Router-agnostic;
// actions (Edit profile / Sign out) come in through the `actions` slot.

import type { ReactNode } from 'react';
import { parseInitials, SELF_AVATAR_COLOR } from '../../avatar';
import { Avatar } from '../Avatar';
import { Badge, type BadgeProps } from '../Badge';
import { Card } from '../Card';
import { cn } from '../cn';
import { ShieldIcon } from './icons';
import { useMediaQuery } from './useMediaQuery';

const STAFF_ROLES = ['super_admin', 'admin', 'analyst', 'sales', 'support', 'billing', 'auditor'] as const;

/** Role -> badge text + tone (amber = platform admins, blue = analysts, neutral = the rest). */
const ROLE_BADGE: Record<string, { label: string; tone: Pick<BadgeProps, 'severity' | 'status'> }> = {
  super_admin: { label: 'Super admin', tone: { severity: 'medium' } },
  admin:       { label: 'Admin',       tone: { severity: 'medium' } },
  analyst:     { label: 'Analyst',     tone: { severity: 'low' } },
  sales:       { label: 'Sales',       tone: { status: 'draft' } },
  support:     { label: 'Support',     tone: { status: 'draft' } },
  billing:     { label: 'Billing',     tone: { status: 'draft' } },
  auditor:     { label: 'Auditor',     tone: { status: 'draft' } },
};

const titleCase = (s: string) => s.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** One-line scope text: staff see platform scope, customers see "{Org} · {Role}". */
export function describeAccountScope(opts: { role?: string | null; orgName?: string | null; orgRole?: string | null }): string | null {
  const role = (opts.role ?? '').toLowerCase();
  if (role === 'auditor') return 'Read-only access to all data';
  if ((STAFF_ROLES as readonly string[]).includes(role)) return 'Averrow staff · Full platform access';
  if (opts.orgName) return opts.orgRole ? `${opts.orgName} · ${titleCase(opts.orgRole)}` : opts.orgName;
  return null;
}

export interface AccountHeroProps {
  name?: string | null;
  email?: string | null;
  /** Raw global role (`super_admin`, `analyst`, `client`, ...). */
  role?: string | null;
  /** Override the role badge text. */
  roleLabel?: string;
  /** `true` -> "Passkey on" (green), `false` -> "No passkey" (amber), `null`/omitted -> hidden. */
  passkey?: boolean | null;
  /** Scope line under the chips; see `describeAccountScope`. */
  scope?: ReactNode;
  /** Right on desktop, equal-width 44px row on mobile. */
  actions?: ReactNode;
  /** Smaller avatar for the mobile settings-home list. */
  compact?: boolean;
  /** Layout-shaped skeleton (no shift when the data arrives). */
  loading?: boolean;
  className?: string;
}

export function AccountHero({
  name, email, role, roleLabel, passkey, scope, actions, compact = false, loading = false, className,
}: AccountHeroProps) {
  const wide = useMediaQuery('(min-width: 768px)', true);
  const avatarSize = compact ? 56 : wide ? 72 : 64;
  const padding = wide && !compact ? 'lg' : 20;

  if (loading) {
    return (
      <Card variant="active" accent="var(--amber)" padding={padding} className={className} aria-busy="true" aria-label="Loading your profile">
        <div className="ds-hero">
          <div className="animate-pulse rounded-full" style={{ width: avatarSize, height: avatarSize, background: 'var(--border-strong)' }} />
          <div className="ds-hero-body">
            <div className="animate-pulse rounded" style={{ height: 22, width: '55%', background: 'var(--border-strong)' }} />
            <div className="mt-2 animate-pulse rounded" style={{ height: 14, width: '40%', background: 'var(--border-base)' }} />
          </div>
        </div>
      </Card>
    );
  }

  const roleKey = (role ?? '').toLowerCase();
  const roleBadge = roleKey
    ? ROLE_BADGE[roleKey] ?? { label: titleCase(roleKey), tone: { status: 'draft' as const } }
    : null;
  const display = (name ?? '').trim() || email || 'Your account';

  return (
    <Card variant="active" accent="var(--amber)" padding={padding} className={className}>
      <div className={cn('ds-hero', compact && 'ds-hero--compact')}>
        <Avatar
          tone="self"
          shape="squircle"
          size={avatarSize}
          color={SELF_AVATAR_COLOR}
          name={display}
          initials={parseInitials(name ?? null, email ?? null)}
        />
        <div className="ds-hero-body">
          <h2 className="ds-hero-name">{display}</h2>
          {email && <p className="ds-hero-email" title={email}>{email}</p>}
          {(roleBadge || passkey !== null && passkey !== undefined) && (
            <div className="ds-hero-chips">
              {roleBadge && <Badge {...roleBadge.tone} label={roleBadge.label} size="md" />}
              {roleKey === 'auditor' && <Badge status="inactive" label="Read-only" size="md" />}
              {passkey === true && <Badge status="active" label="Passkey on" size="md" />}
              {passkey === false && <Badge status="pending" label="No passkey" size="md" />}
            </div>
          )}
          {scope && (
            <p className="ds-hero-scope">
              <ShieldIcon />
              <span className="min-w-0">{scope}</span>
            </p>
          )}
        </div>
        {actions && <div className="ds-hero-actions">{actions}</div>}
      </div>
    </Card>
  );
}
