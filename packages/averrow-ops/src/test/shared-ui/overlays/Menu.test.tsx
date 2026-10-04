import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Menu, MenuTrigger, MenuContent, MenuItem, MenuLabel, MenuSeparator, ResponsiveMenu,
} from '../../../../../shared/src/ui/overlays';
import { installDomStubs, stubViewport } from './helpers';

beforeEach(() => {
  installDomStubs();
  stubViewport(false);
});

function Example({ onSignOut = () => {} }: { onSignOut?: (e: Event) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button">Account</button>
      </MenuTrigger>
      <MenuContent aria-label="Account menu">
        <MenuLabel>Account</MenuLabel>
        <MenuItem>Profile</MenuItem>
        <MenuItem trailing={<span>3</span>}>Notifications</MenuItem>
        <MenuSeparator />
        <MenuItem tone="danger" onSelect={onSignOut}>Sign out</MenuItem>
      </MenuContent>
    </Menu>
  );
}

describe('Menu', () => {
  it('opens from the keyboard, moves with arrows, and Escape returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Example />);
    const trigger = screen.getByRole('button', { name: 'Account' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(3);
    await waitFor(() => expect(items[0]).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[2]).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('renders trailing content and a 44px item with the danger tone', async () => {
    const onSignOut = vi.fn();
    const user = userEvent.setup();
    render(<Example onSignOut={onSignOut} />);
    screen.getByRole('button', { name: 'Account' }).focus();
    await user.keyboard('{Enter}');
    const notifications = await screen.findByRole('menuitem', { name: /Notifications/ });
    expect(notifications).toHaveTextContent('3');
    expect(notifications.className).toContain('min-h-[44px]');
    const danger = screen.getByRole('menuitem', { name: 'Sign out' });
    expect(danger.className).toContain('text-[var(--sev-critical-text)]');
    expect(screen.getByRole('menuitem', { name: 'Profile' }).className).not.toContain('sev-critical');
    await user.click(danger);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('sizes the panel to min(296px, 100vw - 24px)', async () => {
    render(<Example />);
    screen.getByRole('button', { name: 'Account' }).focus();
    await userEvent.setup().keyboard('{Enter}');
    const width = (await screen.findByRole('menu')).style.width;
    expect(width).toContain('296px');
    expect(width).toContain('calc(100vw - 24px)');
  });
});

describe('ResponsiveMenu', () => {
  const build = (onSelect: (e: Event) => void = () => {}) => (
    <ResponsiveMenu trigger={<button type="button">Avatar</button>} title="Account menu">
      <MenuItem onSelect={onSelect}>Profile</MenuItem>
      <MenuItem tone="danger">Sign out</MenuItem>
    </ResponsiveMenu>
  );

  it('uses a popover menu on desktop', async () => {
    render(build());
    screen.getByRole('button', { name: 'Avatar' }).focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it('renders the same items in a bottom sheet on compact screens, closing after select', async () => {
    stubViewport(true);
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(build(onSelect));
    await user.click(screen.getByRole('button', { name: 'Avatar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Account menu' });
    expect(dialog.className).toContain('av-ov-sheet');
    await user.click(screen.getByRole('button', { name: 'Profile' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the sheet open when onSelect prevents default', async () => {
    stubViewport(true);
    const user = userEvent.setup();
    render(build((e: Event) => e.preventDefault()));
    await user.click(screen.getByRole('button', { name: 'Avatar' }));
    await user.click(await screen.findByRole('button', { name: 'Profile' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
