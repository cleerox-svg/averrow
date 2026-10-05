// Account / avatar menu (ACCOUNT_DESIGN_SPEC §4.12, §5.5), built on the shared
// kit: Radix popover on desktop, the same items in a bottom Sheet on compact
// screens. Initials only — never the Google profile picture.

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell, ShieldCheck, Smartphone, User, UserPlus, LogOut, Monitor, Moon, Sun,
} from 'lucide-react';
import { roleLabel } from '@averrow/shared';
import {
  Avatar, Badge, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, ResponsiveMenu,
} from '@averrow/shared/ui';
import { useAuth } from '@/lib/auth';
import { parseInitials } from '@/lib/avatar';
import { VERSION_LABEL, BUILD_SHA } from '@/lib/version';
import { useTheme } from '@/design-system/hooks/useTheme';
import type { Theme } from '@/design-system/hooks/useTheme';
import { useUnreadCount, OPS_AUDIENCE_FILTER } from '@/hooks/useNotifications';

const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string; Icon: typeof Monitor }> = [
  { value: 'auto', label: 'Auto', Icon: Monitor },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'light', label: 'Light', Icon: Sun },
];

function isTheme(v: string): v is Theme {
  return v === 'auto' || v === 'dark' || v === 'light';
}

const ACCOUNT_LINKS = [
  { label: 'Profile', path: '/settings/profile', Icon: User, tone: 'amber' },
  { label: 'Security', path: '/settings/security', Icon: ShieldCheck, tone: 'green' },
  { label: 'Notifications', path: '/settings/notifications', Icon: Bell, tone: 'blue' },
  { label: 'Devices & App', path: '/settings/devices', Icon: Smartphone, tone: 'violet' },
] as const;

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
            <Badge status="draft" size="md" font="sans">{roleLabel(user?.role)}</Badge>
            {hasPasskey
              ? <Badge status="active" size="md" font="sans">Passkey on</Badge>
              : <Badge status="warning" size="md" font="sans">No passkey</Badge>}
          </div>
        </div>
      </div>

      <MenuSeparator />

      {ACCOUNT_LINKS.map(({ label, path, Icon, tone }) => (
        <MenuItem
          key={path}
          icon={<Icon />}
          tone={tone}
          trailing={label === 'Notifications' && unread > 0
            ? <Badge severity="medium" size="md" label={unread > 99 ? '99+' : String(unread)} />
            : undefined}
          onSelect={() => navigate(path)}
        >
          {label}
        </MenuItem>
      ))}

      <MenuSeparator />

      {/* Choice rows, not a SegmentedControl: they are real menu items, so arrow
          keys reach them in the popover and the sheet. keepOpen: a theme change
          is visible instantly behind the menu and people compare Dark/Light, so
          closing after each pick would force a reopen; Esc / outside tap closes. */}
      <MenuLabel>Appearance</MenuLabel>
      <MenuRadioGroup
        aria-label="Appearance"
        value={theme}
        onValueChange={(v) => { if (isTheme(v)) setTheme(v); }}
      >
        {THEME_OPTIONS.map(({ value, label, Icon }) => (
          <MenuRadioItem key={value} value={value} icon={<Icon />} keepOpen>{label}</MenuRadioItem>
        ))}
      </MenuRadioGroup>

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
