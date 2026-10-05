// Account / avatar menu (ACCOUNT_DESIGN_SPEC §4.12, §5.5), built on the shared
// kit: Radix popover on desktop, the same items in a bottom Sheet on compact
// screens. Initials only — never the Google profile picture.

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell, ShieldCheck, ShieldAlert, Smartphone, User, UserPlus, LogOut, Monitor, Moon, Sun,
} from 'lucide-react';
import {
  Avatar, Badge, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, ResponsiveMenu, roleBadgeProps,
} from '@averrow/shared/ui';
import { useAuth } from '@/lib/auth';
import { parseInitials } from '@/lib/avatar';
import { VERSION_LABEL, BUILD_SHA } from '@/lib/version';
import { useTheme } from '@/design-system/hooks/useTheme';
import type { Theme } from '@/design-system/hooks/useTheme';
import { useUnreadSummary } from '@/components/notifications/useUnreadSummary';

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
  const { count: unreadCount, hasCritical } = useUnreadSummary();
  const unread = unreadCount ?? 0;

  const name = user?.display_name ?? user?.name ?? user?.email ?? 'account';
  const initials = parseInitials(user?.display_name ?? user?.name ?? null, user?.email ?? null);
  const hasPasskey = (user?.passkey_count ?? 0) > 0;
  const role = roleBadgeProps(user?.role);

  return (
    <ResponsiveMenu
      title="Account menu"
      trigger={<AvatarTrigger initials={initials} name={name} />}
    >
      <div className="flex items-start gap-3 px-3 pb-3 pt-2.5">
        <Avatar name={name} initials={initials} tone="self" shape="squircle" size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold leading-tight text-[var(--text-primary)]" title={name}>{name}</p>
          {user?.email ? (
            <p className="truncate text-[13px] text-[var(--text-secondary)]" title={user.email}>{user.email}</p>
          ) : null}
          <div className="mt-1.5 flex items-center gap-2">
            <Badge {...role.tone} size="md" font="sans">{role.label}</Badge>
            {hasPasskey ? (
              <span
                role="img"
                title="Passkey on"
                aria-label="Passkey on"
                className="inline-flex h-5 w-5 items-center justify-center text-[var(--green)]"
              >
                <ShieldCheck aria-hidden="true" className="h-[18px] w-[18px]" />
              </span>
            ) : (
              <span
                role="img"
                title="No passkey"
                aria-label="No passkey"
                className="inline-flex h-5 w-5 items-center justify-center text-[var(--amber-text,var(--amber))]"
              >
                <ShieldAlert aria-hidden="true" className="h-[18px] w-[18px]" />
              </span>
            )}
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
            ? (
            <Badge
              {...(hasCritical ? { severity: 'critical' as const } : { status: 'warning' as const })}
              size="md"
              label={unread > 99 ? '99+' : String(unread)}
            />
          )
            : undefined}
          onSelect={() => navigate(path)}
        >
          {label}
        </MenuItem>
      ))}

      <MenuSeparator />

      {/* One compact Auto | Dark | Light control. Segments are real menu radio
          items, so arrow keys reach them in the popover and the sheet. keepOpen:
          a theme change is visible instantly behind the menu and people compare
          Dark/Light; Esc / outside tap closes. */}
      <MenuLabel>Appearance</MenuLabel>
      <MenuRadioGroup
        aria-label="Appearance"
        layout="segmented"
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

      <p className="px-3 pb-1.5 pt-2 text-center font-mono text-[12px] text-[var(--text-tertiary)]">
        {VERSION_LABEL} · {BUILD_SHA}
      </p>
    </ResponsiveMenu>
  );
}
