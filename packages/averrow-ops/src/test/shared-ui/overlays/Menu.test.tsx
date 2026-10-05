import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Menu, MenuTrigger, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuRadioGroup, MenuRadioItem, ResponsiveMenu,
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

describe('MenuItem tone tints', () => {
  it('accepts IconTile tones for the icon tile and keeps danger text only for danger', async () => {
    const user = userEvent.setup();
    render(
      <Menu>
        <MenuTrigger asChild><button type="button">Open</button></MenuTrigger>
        <MenuContent aria-label="m">
          <MenuItem tone="violet" icon={<svg data-testid="ic" />}>Devices</MenuItem>
        </MenuContent>
      </Menu>,
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const item = await screen.findByRole('menuitem', { name: 'Devices' });
    expect(item.querySelector('[data-tone="violet"]')).not.toBeNull();
    expect(item.className).not.toContain('sev-critical');
  });
});

describe('MenuRadioGroup', () => {
  function Choice({ onValueChange }: { onValueChange: (v: string) => void }) {
    const [v, setV] = React.useState('auto');
    return (
      <ResponsiveMenu trigger={<button type="button">Theme menu</button>} title="Appearance">
        <MenuRadioGroup aria-label="Theme" value={v} onValueChange={(n) => { setV(n); onValueChange(n); }}>
          <MenuRadioItem value="auto">Auto</MenuRadioItem>
          <MenuRadioItem value="dark">Dark</MenuRadioItem>
          <MenuRadioItem value="light">Light</MenuRadioItem>
        </MenuRadioGroup>
      </ResponsiveMenu>
    );
  }

  it('popover: shows the checked item, is arrow-key reachable and fires onValueChange', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<Choice onValueChange={onValueChange} />);
    screen.getByRole('button', { name: 'Theme menu' }).focus();
    await user.keyboard('{Enter}');
    const items = await screen.findAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute('aria-checked', 'true');
    expect(items[1]).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(items[0]).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('dark');
  });

  it('sheet: radiogroup with checked state, arrow keys move + select, click selects', async () => {
    stubViewport(true);
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<Choice onValueChange={onValueChange} />);
    await user.click(screen.getByRole('button', { name: 'Theme menu' }));
    const group = await screen.findByRole('radiogroup', { name: 'Theme' });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    radios[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(onValueChange).toHaveBeenCalledWith('dark');
    expect(radios[1]).toHaveFocus();
  });

  it('sheet: closes after a click unless keepOpen', async () => {
    stubViewport(true);
    const user = userEvent.setup();
    render(<Choice onValueChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Theme menu' }));
    await user.click(await screen.findByRole('radio', { name: 'Light' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
