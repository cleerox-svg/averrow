// Account / avatar menu (ACCOUNT_DESIGN_SPEC §4.12, §5.5), built on the shared
// kit: Radix popover on desktop, the same items in a bottom Sheet on compact
// screens. Initials only — never the Google profile picture.

import { forwardRef, type ButtonHTMLAttributes, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell, ShieldCheck, Smartphone, User, UserPlus, LogOut,
} from 'lucide-react';
import { roleLabel } from '@averrow/shared';
import {
  Avatar, Badge, MenuItem, MenuSeparator, ResponsiveMenu, SegmentedControl,
} from '@averrow/shared/ui';
import { useAuth } from '@/lib/auth';
import { parseInitials } from '@/lib/avatar';
import { VERSION_LABEL, BUILD_SHA } from '@/lib/version';
import { useTheme } from '@/design-system/hooks/useTheme';
import type { Theme } from '@/design-system/hooks/useTheme';
import { useUnreadCount, OPS_AUDIENCE_FILTER } from '@/hooks/useNotifications';

const THEME_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

function isTheme(v: string): v is Theme {
  return v === 'auto' || v === 'dark' || v === 'light';
}

// Sentence-case sans badge text (the kit Badge defaults to mono uppercase).
const BADGE_SANS = '!font-sans !normal-case !tracking-normal !font-semibold';

const ACCOUNT_LINKS = [
  { label: 'Profile', path: '/settings/profile', Icon: User, tone: 'amber' },
  { label: 'Security', path: '/settings/security', Icon: ShieldCheck, tone: 'green' },
  { label: 'Notifications', path: '/settings/notifications', Icon: Bell, tone: 'blue' },
  { label: 'Devices & App', path: '/settings/devices', Icon: Smartphone, tone: 'violet' },
] as const;

type TileTone = (typeof ACCOUNT_LINKS)[number]['tone'];

/** Section-tinted 28px icon tile (MenuItem's own tile is neutral/red only). */
function Tinted({ tone, children }: { tone: TileTone; children: React.ReactNode }) {
  return (
    <span className="ds-tile" data-tone={tone} aria-hidden="true"
      style={{
        '--ds-tile-size': '28px', '--ds-tile-radius': '8px',
        '--ds-tile-tint': `var(--${tone})`,
        '--ds-tile-glyph': tone === 'amber' ? 'var(--amber-text)' : tone === 'green' ? 'var(--sev-info-text)' : tone === 'blue' ? 'var(--sev-low-text)' : 'var(--violet-text)',
      } as React.CSSProperties}>
      {children}
    </span>
  );
}

const AvatarTrigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { initials: string; name: string }>(
  function AvatarTrigger({ initials, name, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={`Account menu for ${name}`}
        aria-haspopup="menu"
        className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-[var(--amber)] touch-target"
        {...rest}
      >
        <Avatar name={name} initials={initials} tone="self" size={36} radius={18} />
      </button>
    );
  },
);

export function UserAvatar() {
  const { user, logout, switchAccount } = useAuth();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const { data: unread = 0 } = useUnreadCount(OPS_AUDIENCE_FILTER);

  const name = user?.display_name ?? user?.name ?? user?.email ?? 'account';
  const initials = parseInitials(user?.display_name ?? user?.name ?? null, user?.email ?? null);
  const hasPasskey = (user?.passkey_count ?? 0) > 0;

  // Keep arrow keys inside the segmented control (Radix menu would otherwise
  // treat them as item navigation / typeahead).
  const stopMenuKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') e.stopPropagation();
  };

  return (
    <ResponsiveMenu
      title="Account menu"
      trigger={<AvatarTrigger initials={initials} name={name} />}
    >
      <div className="flex items-center gap-3 px-3 pb-3 pt-2.5">
        <Avatar name={name} initials={initials} tone="self" shape="squircle" size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold leading-tight text-[var(--text-primary)]" title={name}>{name}</p>
          {user?.email ? (
            <p className="truncate text-[13px] text-[var(--text-secondary)]" title={user.email}>{user.email}</p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge status="draft" size="md" className={BADGE_SANS}>{roleLabel(user?.role)}</Badge>
            {hasPasskey
              ? <Badge status="active" size="md" className={BADGE_SANS}>Passkey on</Badge>
              : <Badge status="warning" size="md" className={BADGE_SANS}>No passkey</Badge>}
          </div>
        </div>
      </div>

      <MenuSeparator />

      {ACCOUNT_LINKS.map(({ label, path, Icon, tone }) => (
        <MenuItem
          key={path}
          icon={<Tinted tone={tone}><Icon /></Tinted>}
          trailing={label === 'Notifications' && unread > 0
            ? <Badge severity="medium" size="md" className={BADGE_SANS} label={unread > 99 ? '99+' : String(unread)} />
            : undefined}
          onSelect={() => navigate(path)}
        >
          {label}
        </MenuItem>
      ))}

      <MenuSeparator />

      <div
        className="flex items-center justify-between gap-3 px-3 py-1.5"
        onKeyDown={stopMenuKeys}
      >
        <span className="text-[14px] font-medium text-[var(--text-primary)]" id="account-menu-appearance">Appearance</span>
        <SegmentedControl
          aria-labelledby="account-menu-appearance"
          value={theme}
          onValueChange={(v) => { if (isTheme(v)) setTheme(v); }}
          options={THEME_OPTIONS}
          className="[&_button]:min-w-0 [&_button]:px-2.5"
        />
      </div>

      <MenuSeparator />

      <MenuItem
        icon={<UserPlus />}
        description="Use a different Google account"
        onSelect={() => { void switchAccount(); }}
      >
        Switch account…
      </MenuItem>
      <MenuItem tone="danger" icon={<LogOut />} onSelect={() => { void logout(); }}>
        Sign out
      </MenuItem>

      <p className="px-3 pb-1.5 pt-2 text-center font-mono text-[11px] text-[var(--text-muted)]">
        {VERSION_LABEL} · {BUILD_SHA}
      </p>
    </ResponsiveMenu>
  );
}
