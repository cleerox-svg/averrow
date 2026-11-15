// Account / avatar menu (ACCOUNT_DESIGN_SPEC §4.12, §5.5). The menu itself is
// the shared kit's AccountMenu (also used by FarmTrack); this wrapper feeds it
// ops data: auth user, theme, unread summary, router navigation, lucide icons.
// Initials only — never the Google profile picture.

import { useNavigate } from 'react-router-dom';
import {
  Bell, ShieldCheck, Smartphone, User, UserPlus, LogOut, Monitor, Moon, Sun,
} from 'lucide-react';
import { AccountMenu, roleBadgeProps, type AccountMenuLink } from '@averrow/shared/ui';
import { useAuth } from '@/lib/auth';
import { parseInitials } from '@/lib/avatar';
import { VERSION_LABEL, BUILD_SHA } from '@/lib/version';
import { useTheme } from '@/design-system/hooks/useTheme';
import { useUnreadSummary } from '@/components/notifications/useUnreadSummary';

const ACCOUNT_LINKS = [
  { label: 'Profile', path: '/settings/profile', Icon: User, tone: 'amber' },
  { label: 'Security', path: '/settings/security', Icon: ShieldCheck, tone: 'green' },
  { label: 'Notifications', path: '/settings/notifications', Icon: Bell, tone: 'blue' },
  { label: 'Devices & App', path: '/settings/devices', Icon: Smartphone, tone: 'violet' },
] as const;

export function UserAvatar() {
  const { user, logout, switchAccount } = useAuth();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const { count: unreadCount, hasCritical } = useUnreadSummary();
  const unread = unreadCount ?? 0;

  const name = user?.display_name ?? user?.name ?? user?.email ?? 'account';
  const initials = parseInitials(user?.display_name ?? user?.name ?? null, user?.email ?? null);
  const role = roleBadgeProps(user?.role);

  const links: AccountMenuLink[] = ACCOUNT_LINKS.map(({ label, path, Icon, tone }) => ({
    key: path,
    label,
    tone,
    icon: <Icon />,
    onSelect: () => navigate(path),
    ...(label === 'Notifications' ? { count: unread, countCritical: hasCritical } : {}),
  }));

  return (
    <AccountMenu
      name={name}
      initials={initials}
      email={user?.email}
      role={role}
      hasPasskey={(user?.passkey_count ?? 0) > 0}
      links={links}
      themeValue={theme}
      onThemeChange={setTheme}
      themeIcons={{ auto: <Monitor />, dark: <Moon />, light: <Sun /> }}
      switchAccount={{
        label: 'Switch account…',
        description: 'Use a different Google account',
        icon: <UserPlus />,
        onSelect: () => { void switchAccount(); },
      }}
      signOut={{ label: 'Sign out', icon: <LogOut />, onSelect: () => { void logout(); } }}
      versionLabel={`${VERSION_LABEL} · ${BUILD_SHA}`}
    />
  );
}
