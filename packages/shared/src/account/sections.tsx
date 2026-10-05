// The settings sections, described once (ACCOUNT_DESIGN_SPEC §2, §4.0, §5.0).
// Both apps feed this to <SettingsShell sections={...}>; the id doubles as the
// last URL segment (`/settings/<id>`). Security and Notifications are listed
// here even though their pages live in sibling modules, so the rail, the
// mobile list and the avatar menu always agree on what exists.

import type { SettingsSection } from '../ui/settings';
import { BellIcon, ShieldCheckIcon, SmartphoneIcon, UserIcon } from './section-icons';

export const ACCOUNT_SECTION_IDS = ['profile', 'security', 'notifications', 'devices'] as const;
export type AccountSectionId = (typeof ACCOUNT_SECTION_IDS)[number];

export const ACCOUNT_SETTINGS_BASE_PATH = '/settings';

interface AccountSectionDef {
  id: AccountSectionId;
  label: string;
  description: string;
  tone: NonNullable<SettingsSection['tone']>;
  group: string;
  icon: () => SettingsSection['icon'];
}

/** Static definition: id, label, default description, tone and group. Order is the rail order. */
export const ACCOUNT_SECTION_DEFS: readonly AccountSectionDef[] = [
  { id: 'profile',       label: 'Profile',        description: 'Name, appearance and time zone', tone: 'amber',  group: 'Account',     icon: () => <UserIcon /> },
  { id: 'security',      label: 'Security',       description: 'Passkeys and sessions',          tone: 'green',  group: 'Account',     icon: () => <ShieldCheckIcon /> },
  { id: 'notifications', label: 'Notifications',  description: 'Push, email and quiet hours',    tone: 'blue',   group: 'Preferences', icon: () => <BellIcon /> },
  { id: 'devices',       label: 'Devices & App',  description: 'Install the app and manage devices', tone: 'violet', group: 'Preferences', icon: () => <SmartphoneIcon /> },
];

export interface AccountSectionsOptions {
  /** Where the host mounts the settings area. Default `/settings`. */
  basePath?: string;
  /** Live summaries for the mobile list ("Passkey on · 3 sessions"). Falls back to the default text. */
  descriptions?: Partial<Record<AccountSectionId, string>>;
  /** Count badges (e.g. unread notifications). Hidden when 0. */
  badges?: Partial<Record<AccountSectionId, number | string>>;
}

/** Sections in `SettingsShell` shape, with absolute hrefs under `basePath`. */
export function getAccountSections(opts: AccountSectionsOptions = {}): SettingsSection[] {
  const root = (opts.basePath ?? ACCOUNT_SETTINGS_BASE_PATH).replace(/\/+$/, '');
  return ACCOUNT_SECTION_DEFS.map((d) => ({
    id: d.id,
    label: d.label,
    description: opts.descriptions?.[d.id] ?? d.description,
    icon: d.icon(),
    tone: d.tone,
    group: d.group,
    badge: opts.badges?.[d.id],
    href: `${root}/${d.id}`,
  }));
}

/** The section id for a pathname under `basePath` (`/settings/notifications/quiet-hours` -> `notifications`), or null for the home list. */
export function accountSectionIdFromPath(pathname: string, basePath: string = ACCOUNT_SETTINGS_BASE_PATH): AccountSectionId | null {
  const root = basePath.replace(/\/+$/, '');
  if (pathname !== root && !pathname.startsWith(`${root}/`)) return null;
  const seg = pathname.slice(root.length).split('/').filter(Boolean)[0];
  return (ACCOUNT_SECTION_IDS as readonly string[]).includes(seg ?? '') ? (seg as AccountSectionId) : null;
}
