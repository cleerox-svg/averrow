// Coverage for the v4 shell parity work (commit 945fde4): topbar bell +
// avatar, Console nav-row alert badge, footer theme toggle, drawer
// keyboard/route behaviour, and the PlatformAlertBanner mount point.
// Heavy neighbours (bell/avatar/banner/palette data) are stubbed like
// ShellEnrollmentGate.test.tsx; ThemeCycleButton stays real so the footer
// assertion exercises the actual toggle.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui/Toast';
import { ShellV4 } from './ShellV4';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useOpenAlertCount: vi.fn(),
  banner: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@/hooks/useOpenAlertCount', () => ({ useOpenAlertCount: mocks.useOpenAlertCount }));
vi.mock('@/components/PlatformAlertBanner', () => ({
  PlatformAlertBanner: () => mocks.banner(),
}));
vi.mock('@/components/NotificationBell', () => ({
  NotificationBell: () => <div data-testid="notification-bell" />,
}));
vi.mock('@/components/UserAvatar', () => ({
  UserAvatar: () => <div data-testid="user-avatar" />,
}));

// Shell.tsx (imported by ShellV4) dependencies — irrelevant here.
vi.mock('./Sidebar', () => ({ Sidebar: () => null }));
vi.mock('./TopBar', () => ({ TopBar: () => null }));
vi.mock('@/layouts/MobileNav', () => ({ MobileNav: () => null }));
vi.mock('@/layouts/MobileSidebarDrawer', () => ({ MobileSidebarDrawer: () => null }));
vi.mock('@/components/ui/DeepBackground', () => ({ DeepBackground: () => null }));
vi.mock('@/components/ui/PageTransition', () => ({
  PageTransition: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/FirstSignInPasskeyPrompt', () => ({ FirstSignInPasskeyPrompt: () => null }));
vi.mock('@/components/PasskeyEnrollmentGate', () => ({ PasskeyEnrollmentGate: () => null }));
vi.mock('@/design-system/hooks', () => ({
  useBreakpoint: () => ({ isMobile: false, isMobileVertical: false, isMobileHorizontal: false }),
  useTheme: () => ({ theme: 'auto', cycle: vi.fn() }),
}));

type CountState = { isSuccess: boolean; data?: number; isLoading?: boolean; isError?: boolean };
function setCount(state: CountState) {
  mocks.useOpenAlertCount.mockReturnValue({ isLoading: false, isError: false, ...state });
}

function Goto() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/other')}>go-other</button>;
}

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<ShellV4 />}>
              <Route index element={<div data-testid="outlet-content"><Goto /></div>} />
              <Route path="other" element={<div>other page</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const shellRoot = (c: HTMLElement) => c.querySelector('.shell-v4') as HTMLElement;
const consoleLink = () => screen.getByRole('link', { name: /console/i });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useAuth.mockReturnValue({
    user: { id: 'u1', email: 's@averrow.com', role: 'admin', display_name: 'Staff User', passkey_count: 1 },
    isSuperAdmin: false,
  });
  mocks.banner.mockReturnValue(null);
  setCount({ isSuccess: true, data: 0 });
});

describe('ShellV4 topbar', () => {
  it('renders the notification bell and user avatar inside the topbar', () => {
    const { container } = renderShell();
    const top = container.querySelector('header.v4-top') as HTMLElement;
    expect(within(top).getByTestId('notification-bell')).toBeInTheDocument();
    expect(within(top).getByTestId('user-avatar')).toBeInTheDocument();
  });
});

describe('ShellV4 Console alert badge', () => {
  it('shows the open-alert count', () => {
    setCount({ isSuccess: true, data: 7 });
    renderShell();
    const badge = within(consoleLink()).getByLabelText('7 open alerts');
    expect(badge).toHaveTextContent('7');
  });

  it('shows 99 as-is (cap boundary)', () => {
    setCount({ isSuccess: true, data: 99 });
    renderShell();
    expect(within(consoleLink()).getByLabelText('99 open alerts')).toHaveTextContent(/^99$/);
  });

  it('caps display at 99+ above 99 but keeps the real number in aria-label', () => {
    setCount({ isSuccess: true, data: 1234 });
    renderShell();
    const badge = within(consoleLink()).getByLabelText('1234 open alerts');
    expect(badge).toHaveTextContent('99+');
  });

  it('shows 99+ at 100', () => {
    setCount({ isSuccess: true, data: 100 });
    renderShell();
    expect(within(consoleLink()).getByLabelText('100 open alerts')).toHaveTextContent('99+');
  });

  it('is absent at 0', () => {
    setCount({ isSuccess: true, data: 0 });
    renderShell();
    expect(within(consoleLink()).queryByLabelText(/open alerts/)).not.toBeInTheDocument();
  });

  it('is absent while loading', () => {
    setCount({ isSuccess: false, isLoading: true, data: undefined });
    renderShell();
    expect(within(consoleLink()).queryByLabelText(/open alerts/)).not.toBeInTheDocument();
  });

  it('is absent on error, even if stale data is present', () => {
    setCount({ isSuccess: false, isError: true, data: 42 });
    renderShell();
    expect(within(consoleLink()).queryByLabelText(/open alerts/)).not.toBeInTheDocument();
  });
});

describe('ShellV4 footer', () => {
  it('renders the theme toggle and no sign-out / profile duplicate', () => {
    const { container } = renderShell();
    const foot = container.querySelector('.v4-foot') as HTMLElement;
    expect(within(foot).getByRole('button', { name: /^theme:/i })).toBeInTheDocument();
    expect(within(foot).queryByText(/sign out/i)).not.toBeInTheDocument();
    expect(within(foot).queryByRole('button', { name: /sign out|log ?out/i })).not.toBeInTheDocument();
    expect(within(foot).queryByRole('link', { name: /profile/i })).not.toBeInTheDocument();
    expect(within(foot).queryByTestId('user-avatar')).not.toBeInTheDocument();
  });
});

describe('ShellV4 drawer', () => {
  it('opens via the hamburger', () => {
    const { container } = renderShell();
    expect(shellRoot(container)).not.toHaveClass('drawer-open');
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(shellRoot(container)).toHaveClass('drawer-open');
  });

  it('closes on Escape and returns focus to the hamburger', () => {
    const { container } = renderShell();
    const hamburger = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.click(hamburger);
    // focus is elsewhere (as when a user tabbed into the drawer)
    const closeBtn = screen.getByRole('button', { name: 'Close menu' });
    closeBtn.focus();
    expect(document.activeElement).toBe(closeBtn);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(shellRoot(container)).not.toHaveClass('drawer-open');
    expect(document.activeElement).toBe(hamburger);
  });

  it('does not steal focus on Escape when the drawer is closed', () => {
    renderShell();
    const hamburger = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).not.toBe(hamburger);
  });

  it('closes on route change', () => {
    const { container } = renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(shellRoot(container)).toHaveClass('drawer-open');

    // programmatic navigation (not via a nav link's onClick) so the
    // location-driven effect is what must close the drawer
    fireEvent.click(screen.getByText('go-other'));

    expect(screen.getByText('other page')).toBeInTheDocument();
    expect(shellRoot(container)).not.toHaveClass('drawer-open');
  });
});

describe('ShellV4 PlatformAlertBanner', () => {
  it('renders the banner above the outlet content', () => {
    mocks.banner.mockReturnValue(<div data-testid="alert-banner">platform alert</div>);
    const { container } = renderShell();
    const banner = screen.getByTestId('alert-banner');
    const outlet = screen.getByTestId('outlet-content');
    expect(container.querySelector('.v4-banner-wrap')).toContainElement(banner);
    expect(banner.compareDocumentPosition(outlet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leaves its wrapper empty (so :empty hides it) when the banner returns null', () => {
    const { container } = renderShell();
    const wrap = container.querySelector('.v4-banner-wrap') as HTMLElement;
    expect(wrap).toBeInTheDocument();
    expect(wrap).toBeEmptyDOMElement();
  });
});
