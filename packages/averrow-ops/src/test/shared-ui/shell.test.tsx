// Shared shell modules (AccountMenu, SearchTrigger, NotificationBell) rendered
// the way a second product (no router, no row actions, no switch account) uses
// them.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AccountMenu, SearchTrigger, NotificationBell, MenuLabel, MenuRadioGroup, MenuRadioItem,
  type ShellNotification,
} from '@averrow/shared/ui';
import { stubViewport } from './settings/helpers';

beforeEach(() => { stubViewport(true); });

describe('SearchTrigger', () => {
  it('opens, names itself and hides the shortcut on request', async () => {
    const onOpen = vi.fn();
    render(
      <SearchTrigger label="Search animals…" shortcut="⌘K" aria-label="Open search" onOpen={onOpen}
        data-testid="search" className="custom-x" shortcutTestId="search-kbd" />,
    );
    const btn = screen.getByTestId('search');
    expect(btn.getAttribute('aria-label')).toBe('Open search');
    expect(btn.className).toContain('custom-x');
    expect(screen.getByTestId('search-kbd').textContent).toBe('⌘K');
    await userEvent.click(btn);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('renders no kbd without a shortcut', () => {
    render(<SearchTrigger label="Search" onOpen={() => {}} />);
    expect(document.querySelector('kbd')).toBeNull();
  });
});

describe('AccountMenu', () => {
  function setup(over: Partial<React.ComponentProps<typeof AccountMenu>> = {}) {
    const onSignOut = vi.fn();
    const onTheme = vi.fn();
    const onLink = vi.fn();
    render(
      <AccountMenu
        name="Jo Farmer"
        initials="JF"
        email="jo@farm.co"
        role={{ label: 'Manager', tone: { status: 'draft' } }}
        links={[{ key: 'p', label: 'Profile', icon: <i />, onSelect: onLink, 'data-testid': 'link-profile', count: 120, countCritical: true }]}
        themeValue="dark"
        onThemeChange={onTheme}
        afterAppearance={(
          <>
            <MenuLabel>Look</MenuLabel>
            <MenuRadioGroup aria-label="Look" layout="segmented" value="a" onValueChange={() => {}}>
              <MenuRadioItem value="a" keepOpen data-testid="look-a">Averrow</MenuRadioItem>
              <MenuRadioItem value="b" keepOpen data-testid="look-b">Classic</MenuRadioItem>
            </MenuRadioGroup>
          </>
        )}
        signOut={{ label: 'Sign out', onSelect: onSignOut, 'data-testid': 'signout' }}
        versionLabel="v1 · abc"
        versionTestId="ver"
        triggerTestId="acct-trigger"
        data-testid="acct-menu"
        {...over}
      />,
    );
    return { onSignOut, onTheme, onLink };
  }

  it('renders the FarmTrack shape: slot group, no switch account, caps the count, hides passkey when undefined', async () => {
    const { onSignOut, onTheme, onLink } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('acct-trigger'));
    expect(screen.getByTestId('acct-menu')).toBeTruthy();
    expect(screen.getByText('Manager')).toBeTruthy();
    expect(screen.queryByRole('img', { name: /passkey/i })).toBeNull();
    expect(screen.queryByText(/Switch account/)).toBeNull();
    expect(screen.getByText('99+')).toBeTruthy();
    expect(screen.getByTestId('look-b')).toBeTruthy();
    expect(screen.getByTestId('ver').textContent).toBe('v1 · abc');
    await user.click(screen.getByTestId('account-menu-theme-light'));
    expect(onTheme).toHaveBeenCalledWith('light');
    await user.click(screen.getByTestId('link-profile'));
    expect(onLink).toHaveBeenCalledOnce();
    await user.click(screen.getByTestId('acct-trigger'));
    await user.click(screen.getByTestId('signout'));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it('shows switch account only when given', async () => {
    const onSwitch = vi.fn();
    setup({ switchAccount: { label: 'Switch account', onSelect: onSwitch } });
    await userEvent.click(screen.getByTestId('acct-trigger'));
    await userEvent.click(screen.getByText('Switch account'));
    expect(onSwitch).toHaveBeenCalledOnce();
  });
});

describe('NotificationBell (kit)', () => {
  const item = (id: string, state: string, severity = 'medium'): ShellNotification => ({
    id, state, severity, title: `T${id}`, message: `M${id}`, created_at: new Date().toISOString(),
  });

  it('lists rows with no actions when none are wired, caps the badge, and routes footer links', async () => {
    const onActivate = vi.fn();
    render(
      <NotificationBell
        items={[item('1', 'unread', 'critical'), item('2', 'read')]}
        unreadCount={120}
        hasCritical
        onMarkAllRead={() => {}}
        onActivate={onActivate}
        footerLinks={[{ key: 'all', label: 'View all', href: '/n' }]}
        triggerTestId="bell"
        data-testid="bell-panel"
        compact={false}
      />,
    );
    expect(screen.getByTestId('bell-count').textContent).toBe('99+');
    expect(screen.getByTestId('bell-count').getAttribute('data-tone')).toBe('critical');
    await userEvent.click(screen.getByTestId('bell'));
    expect(screen.getByTestId('bell-panel')).toBeTruthy();
    expect(screen.queryByLabelText('Notification actions')).toBeNull();
    expect(screen.getByRole('link', { name: 'View all' }).getAttribute('href')).toBe('/n');
    await userEvent.click(screen.getByText('T1'));
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }), expect.objectContaining({ close: expect.any(Function) }));
  });

  it('filters to unread and shows the error / empty states', async () => {
    render(
      <NotificationBell
        items={[item('2', 'read')]}
        unreadCount={0}
        onMarkAllRead={() => {}}
        onActivate={() => {}}
        compact={false}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^Notifications/ }));
    await userEvent.click(screen.getByRole('radio', { name: 'Unread' }));
    expect(screen.getByText('No unread notifications')).toBeTruthy();
  });

  it('fires onOpenChange', async () => {
    const onOpenChange = vi.fn();
    render(
      <NotificationBell items={[]} unreadCount={0} onMarkAllRead={() => {}} onActivate={() => {}} compact={false} onOpenChange={onOpenChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /^Notifications/ }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });
});
