import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsShell, type SettingsSection } from '../../../../../shared/src/ui/settings';
import { stubViewport } from './helpers';

const SECTIONS: SettingsSection[] = [
  { id: 'profile', label: 'Profile', description: 'Name, appearance', icon: <svg />, tone: 'amber', group: 'Account' },
  { id: 'security', label: 'Security', description: 'Passkeys and sessions', icon: <svg />, tone: 'green', group: 'Account' },
  { id: 'notifications', label: 'Notifications', icon: <svg />, tone: 'blue', group: 'Preferences', badge: 3 },
  { id: 'devices', label: 'Devices & App', icon: <svg />, tone: 'violet', group: 'Preferences' },
];

describe('SettingsShell — desktop', () => {
  beforeEach(() => stubViewport(true));

  it('renders a labelled nav rail with grouped links and aria-current on the active item only', () => {
    render(
      <SettingsShell sections={SECTIONS} activeId="security" basePath="/settings" subtitle="Your profile.">
        <div>pane content</div>
      </SettingsShell>,
    );
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/settings/profile', '/settings/security', '/settings/notifications', '/settings/devices',
    ]);
    expect(within(nav).getByRole('link', { name: /Security/ })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: /Profile/ })).not.toHaveAttribute('aria-current');
    expect(within(nav).getByText('Account')).toBeInTheDocument();
    expect(within(nav).getByText('Preferences')).toBeInTheDocument();
    expect(screen.getByText('pane content')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  });

  it('shows a count badge only when the badge is non-zero, and the rail footer', () => {
    render(
      <SettingsShell
        sections={SECTIONS.map((s) => (s.id === 'devices' ? { ...s, badge: 0 } : s))}
        activeId="profile"
        basePath="/settings/"
        railFooter={<button>Sign out</button>}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getByRole('link', { name: /Notifications/ })).toHaveTextContent('3');
    expect(within(nav).getByRole('link', { name: /Devices/ })).not.toHaveTextContent('0');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    // trailing slash on basePath is normalised
    expect(within(nav).getByRole('link', { name: /Profile/ })).toHaveAttribute('href', '/settings/profile');
  });

  it('uses renderLink for router integration and does not render the mobile home', () => {
    const renderLink = vi.fn((p) => <a data-rl href={`/v2${p.href}`} className={p.className} aria-current={p['aria-current']} onClick={p.onClick}>{p.children}</a>);
    render(<SettingsShell sections={SECTIONS} activeId="profile" basePath="/settings" renderLink={renderLink} home={<div>HOME SLOT</div>} />);
    expect(renderLink).toHaveBeenCalled();
    expect(screen.getAllByRole('link')[0]).toHaveAttribute('href', '/v2/settings/profile');
    expect(screen.queryByText('HOME SLOT')).toBeNull();
  });
});

describe('SettingsShell — mobile list to detail', () => {
  beforeEach(() => stubViewport(false));
  afterEach(() => { delete (document as unknown as { startViewTransition?: unknown }).startViewTransition; });

  it('home (activeId null): large title, home slot, grouped list links, footer', () => {
    render(
      <SettingsShell
        sections={SECTIONS}
        activeId={null}
        basePath="/settings"
        home={<div>HERO</div>}
        homeFooter={<div>v4.0.0</div>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('HERO')).toBeInTheDocument();
    expect(screen.getByText('v4.0.0')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull();
    const security = screen.getByRole('link', { name: /Security/ });
    expect(security).toHaveAttribute('href', '/settings/security');
    expect(security).toHaveTextContent('Passkeys and sessions');
    expect(screen.getByRole('region', { name: 'Account' })).toBeInTheDocument();
  });

  it('detail: back link to home, large title and content; no rail', () => {
    render(
      <SettingsShell sections={SECTIONS} activeId="security" basePath="/settings">
        <div>security pane</div>
      </SettingsShell>,
    );
    const back = screen.getByRole('link', { name: /Settings/ });
    expect(back).toHaveAttribute('href', '/settings');
    expect(back).toHaveClass('ds-sshell-back');
    expect(screen.getByRole('heading', { level: 1, name: 'Security' })).toBeInTheDocument();
    expect(screen.getByText('security pane')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull();
  });

  it('custom homeLabel is used on the back link', () => {
    render(<SettingsShell sections={SECTIONS} activeId="profile" basePath="/settings" homeLabel="Account" />);
    expect(screen.getByRole('link', { name: /Account/ })).toHaveAttribute('href', '/settings');
  });

  it('onNavigate keeps anchors but routes in JS for plain clicks', async () => {
    const onNavigate = vi.fn();
    render(<SettingsShell sections={SECTIONS} activeId={null} basePath="/settings" onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole('link', { name: /Devices/ }));
    expect(onNavigate).toHaveBeenCalledWith('/settings/devices');
  });

  it('runs a View Transition when supported (forward on open, back on return)', async () => {
    // Like the browser: the callback is actually invoked (after the click), and its promise gates `finished`.
    const start = vi.fn((cb: () => Promise<void> | void) => ({ finished: Promise.resolve().then(() => cb()) }));
    (document as unknown as { startViewTransition: typeof start }).startViewTransition = start;
    const onNavigate = vi.fn();
    const { rerender } = render(<SettingsShell sections={SECTIONS} activeId={null} basePath="/settings" onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole('link', { name: /Security/ }));
    expect(start).toHaveBeenCalledTimes(1);
    rerender(<SettingsShell sections={SECTIONS} activeId="security" basePath="/settings" onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole('link', { name: /Settings/ }));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('without the View Transition API the screen gets the CSS fallback animation class', () => {
    const { container } = render(<SettingsShell sections={SECTIONS} activeId="profile" basePath="/settings" />);
    expect(container.querySelector('.ds-sshell-screen--fallback')).not.toBeNull();
  });
});

describe('SettingsShell view transition + focus (review fixes)', () => {
  beforeEach(() => stubViewport(false));
  afterEach(() => { delete (document as unknown as { startViewTransition?: unknown }).startViewTransition; });

  /** Mock that captures the callback; `run()` plays the browser taking the snapshot, then calling it. */
  const installVT = (log: string[]) => {
    const cbs: Array<() => Promise<void> | void> = [];
    (document as unknown as { startViewTransition: unknown }).startViewTransition = vi.fn((cb: () => Promise<void> | void) => {
      log.push('vt-start');
      cbs.push(cb);
      return { finished: Promise.resolve() };
    });
    return { run: async () => { log.push('snapshot'); await cbs.shift()?.(); } };
  };

  it('navigates INSIDE the transition callback, after the old snapshot', async () => {
    const log: string[] = [];
    const vt = installVT(log);
    const onNavigate = vi.fn(() => { log.push('navigate'); });
    render(<SettingsShell sections={SECTIONS} activeId={null} basePath="/settings" onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole('link', { name: /Security/ }));
    expect(onNavigate).not.toHaveBeenCalled(); // not navigated synchronously with the click
    expect(log).toEqual(['vt-start']);
    void vt.run();
    expect(log).toEqual(['vt-start', 'snapshot', 'navigate']);
    expect(onNavigate).toHaveBeenCalledWith('/settings/security');
  });

  it('with renderLink + onNavigate the click is intercepted (router Link skips its own navigation)', async () => {
    const vt = installVT([]);
    const onNavigate = vi.fn();
    const linkClick = vi.fn((e: { defaultPrevented: boolean }) => e.defaultPrevented);
    const renderLink = (p: Parameters<NonNullable<React.ComponentProps<typeof SettingsShell>['renderLink']>>[0]) => (
      <a href={p.href} className={p.className} onClick={(e) => { p.onClick?.(e); linkClick(e); e.preventDefault(); }}>{p.children}</a>
    );
    render(<SettingsShell sections={SECTIONS} activeId={null} basePath="/settings" renderLink={renderLink} onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole('link', { name: /Devices/ }));
    expect(linkClick).toHaveReturnedWith(true);
    void vt.run();
    expect(onNavigate).toHaveBeenCalledWith('/settings/devices');
  });

  it('renderLink without onNavigate skips the transition and uses the CSS fallback animation', async () => {
    const log: string[] = [];
    installVT(log);
    const { container } = render(
      <SettingsShell sections={SECTIONS} activeId="profile" basePath="/settings"
        renderLink={(p) => <a href={p.href} className={p.className} onClick={(e) => { p.onClick?.(e); e.preventDefault(); }}>{p.children}</a>} />,
    );
    expect(container.querySelector('.ds-sshell-screen--fallback')).not.toBeNull();
    await userEvent.click(screen.getByRole('link', { name: /Settings/ }));
    expect(log).toEqual([]);
  });

  it('moves focus to the new screen title on route change, not on first mount', () => {
    const { rerender } = render(<SettingsShell sections={SECTIONS} activeId={null} basePath="/settings" />);
    const home = screen.getByRole('heading', { level: 1, name: 'Settings' });
    expect(home).not.toHaveFocus();
    expect(home).toHaveAttribute('tabindex', '-1');
    rerender(<SettingsShell sections={SECTIONS} activeId="security" basePath="/settings" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Security' })).toHaveFocus();
    rerender(<SettingsShell sections={SECTIONS} activeId={null} basePath="/settings" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toHaveFocus();
  });
});
