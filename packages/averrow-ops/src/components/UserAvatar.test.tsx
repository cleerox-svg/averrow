import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ROLE_LABELS, USER_ROLES, roleLabel } from '@averrow/shared';

const logout = vi.fn(() => Promise.resolve());
const switchAccount = vi.fn(() => Promise.resolve());
const setTheme = vi.fn();
let role = 'sales';
let passkeys = 1;
let unread = 0;
let theme = 'auto';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@b.co', name: 'A B', role, passkey_count: passkeys, avatar_url: 'https://x/y.png' },
    logout,
    switchAccount,
  }),
}));
vi.mock('@/design-system/hooks/useTheme', () => ({
  useTheme: () => ({ theme, setTheme }),
}));
vi.mock('@/hooks/useNotifications', () => ({
  OPS_AUDIENCE_FILTER: ['super_admin', 'team', 'all'],
  useUnreadCount: () => ({ data: unread }),
}));

import { UserAvatar } from './UserAvatar';
import { VERSION_LABEL, BUILD_SHA } from '@/lib/version';
import { stubViewport } from '@/test/shared-ui/settings/helpers';

/** compact = phone: the (max-width: 767px) overlay query matches. */
function stubCompact(compact: boolean) {
  if (!compact) { stubViewport(true); return; }
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width: 767px'),
    media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

async function open() {
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/']}><Where /><UserAvatar /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: /account menu for/i }));
  return user;
}

beforeEach(() => {
  logout.mockClear(); switchAccount.mockClear(); setTheme.mockClear();
  role = 'sales'; passkeys = 1; unread = 0; theme = 'auto';
  stubCompact(false);
});

describe('role labels', () => {
  it('covers all 8 roles', () => {
    expect(USER_ROLES).toHaveLength(8);
    expect(USER_ROLES.map(r => ROLE_LABELS[r])).toEqual([
      'Super Admin', 'Admin', 'Analyst', 'Sales', 'Support', 'Billing', 'Auditor', 'Client',
    ]);
  });
  it('falls back to the raw key for unknown roles', () => {
    expect(roleLabel('mystery')).toBe('mystery');
  });
});

describe('UserAvatar account menu (desktop)', () => {
  it('trigger is named for the user and shows initials only', async () => {
    render(<MemoryRouter><UserAvatar /></MemoryRouter>);
    const trigger = screen.getByRole('button', { name: 'Account menu for A B' });
    expect(trigger.textContent).toBe('AB');
    expect(document.querySelector('img')).toBeNull();
  });

  it.each(USER_ROLES)('shows the role label for %s', async (r) => {
    role = r;
    await open();
    expect(screen.getByText(ROLE_LABELS[r])).toBeTruthy();
  });

  it('shows passkey status', async () => {
    await open();
    expect(screen.getByText('Passkey on')).toBeTruthy();
  });

  it('shows "No passkey" when none registered', async () => {
    passkeys = 0;
    await open();
    expect(screen.getByText('No passkey')).toBeTruthy();
  });

  it('lists the four account pages, no Organization / API Keys', async () => {
    await open();
    for (const label of ['Profile', 'Security', 'Notifications', 'Devices & App']) {
      expect(screen.getByRole('menuitem', { name: new RegExp(label) })).toBeTruthy();
    }
    expect(screen.queryByText('Organization')).toBeNull();
    expect(screen.queryByText('API Keys')).toBeNull();
  });

  it.each([
    ['Profile', '/settings/profile'],
    ['Security', '/settings/security'],
    ['Notifications', '/settings/notifications'],
    ['Devices & App', '/settings/devices'],
  ])('%s navigates to %s', async (label, path) => {
    const user = await open();
    await user.click(screen.getByRole('menuitem', { name: new RegExp(label) }));
    expect(screen.getByTestId('where').textContent).toBe(path);
  });

  it('shows an unread count on Notifications only when > 0', async () => {
    await open();
    const item = screen.getByRole('menuitem', { name: /Notifications/ });
    expect(within(item).queryByText('3')).toBeNull();
  });

  it('renders the unread count', async () => {
    unread = 3;
    await open();
    expect(within(screen.getByRole('menuitem', { name: /Notifications/ })).getByText('3')).toBeTruthy();
  });

  it('caps the unread count at 99+', async () => {
    unread = 250;
    await open();
    expect(within(screen.getByRole('menuitem', { name: /Notifications/ })).getByText('99+')).toBeTruthy();
  });

  it('appearance choice reflects and sets the theme via the theme hook', async () => {
    theme = 'dark';
    const user = await open();
    const group = screen.getByRole('group', { name: 'Appearance' });
    expect(within(group).getByRole('menuitemradio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    await user.click(within(group).getByRole('menuitemradio', { name: 'Light' }));
    expect(setTheme).toHaveBeenCalledWith('light');
    // keepOpen: choosing a theme leaves the menu open.
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('theme choice is reachable with arrow keys from the first item', async () => {
    const user = await open();
    const items = screen.getAllByRole('menuitem');
    await user.keyboard('{ArrowDown}'); // focus first item (Profile)
    expect(document.activeElement).toBe(items[0]);
    let guard = 0;
    while (document.activeElement?.getAttribute('role') !== 'menuitemradio' && guard++ < 12) {
      await user.keyboard('{ArrowDown}');
    }
    expect(document.activeElement?.getAttribute('role')).toBe('menuitemradio');
    expect(document.activeElement?.textContent).toBe('Auto');
    await user.keyboard('{ArrowDown}{ArrowDown}'); // Dark, Light
    expect(document.activeElement?.textContent).toBe('Light');
    await user.keyboard('{Enter}');
    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('Switch account calls switchAccount, not logout', async () => {
    const user = await open();
    expect(screen.getByText('Use a different Google account')).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: /Switch account/ }));
    expect(switchAccount).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
  });

  it('Sign out calls logout only', async () => {
    const user = await open();
    expect(screen.queryByText('Logout')).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(switchAccount).not.toHaveBeenCalled();
  });

  it('shows a non-interactive version line', async () => {
    await open();
    const line = screen.getByText(`${VERSION_LABEL} · ${BUILD_SHA}`);
    expect(line.closest('button, a, [role="menuitem"]')).toBeNull();
  });

  it('Escape closes the menu and returns focus to the trigger', async () => {
    const user = await open();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /account menu for/i }));
  });
});

describe('UserAvatar account menu (mobile)', () => {
  beforeEach(() => stubCompact(true));

  it('renders the items inside a dialog sheet', async () => {
    await open();
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('button', { name: /Profile/ })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('sheet items navigate and close', async () => {
    const user = await open();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Security/ }));
    expect(screen.getByTestId('where').textContent).toBe('/settings/security');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sheet appearance choice is a radiogroup that sets the theme and stays open', async () => {
    theme = 'dark';
    const user = await open();
    const group = within(screen.getByRole('dialog')).getByRole('radiogroup', { name: 'Appearance' });
    expect(within(group).getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    await user.click(within(group).getByRole('radio', { name: 'Light' }));
    expect(setTheme).toHaveBeenCalledWith('light');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('sheet Sign out calls logout', async () => {
    const user = await open();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalledTimes(1);
  });
});

