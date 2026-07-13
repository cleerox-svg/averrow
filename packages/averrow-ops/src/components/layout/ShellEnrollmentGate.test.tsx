// Regression coverage for H-3 gating parity across shell variants
// (AUTH_AUDIT_2026-06 follow-up, 2026-07).
//
// Bug: ShellV4 (the v4 "cinematic" shell) rendered `<Outlet/>`
// unconditionally and never mounted `PasskeyEnrollmentGate` — unlike the
// classic `Shell`, which has always gated the Outlet on
// `user.passkey_required` and mounted the gate at its root (see the H-3
// comments in Shell.tsx). A privileged user on an enrollment-scoped
// session (signed in without a passkey) who switched to the v4 shell got
// the full nav + Outlet with no blocking gate — every protected fetch
// 403'd with nothing on screen to explain why.
//
// Fix: ShellV4 now computes the same `enrollmentLocked` flag, gates its
// Outlet the same way, and mounts `PasskeyEnrollmentGate` +
// `FirstSignInPasskeyPrompt` at its root, mirroring Shell.tsx exactly.
//
// This file runs the SAME assertions against BOTH Shell and ShellV4 via
// describe.each so a future third shell variant (or a regression in
// either existing one) can't silently reintroduce the omission — a test
// file scoped to only one shell would miss that class of bug entirely.
//
// The gate itself (PasskeyEnrollmentGate) is NOT mocked — we assert on
// what it actually renders (role="dialog" + aria-labelledby
// "passkey-gate-title", see PasskeyEnrollmentGate.tsx) so a change that
// breaks the gate's own self-gating would also fail here. Everything
// else each shell drags in that isn't relevant to the gating behavior
// (Sidebar, TopBar, mobile nav/drawer, background chrome, page-transition
// wrapper, the platform alert banner) is stubbed out, the same way
// CommandPalette.test.tsx isolates useGlobalSearch.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui/Toast';
import { Shell } from './Shell';
import { ShellV4 } from './ShellV4';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: mocks.useAuth,
}));

// Shell.tsx-only dependencies — irrelevant to the enrollment-gate
// behavior under test, stubbed so this file doesn't also have to satisfy
// their own data/hook requirements (react-query notification counts,
// matchMedia, framer-motion, etc).
vi.mock('./Sidebar', () => ({ Sidebar: () => <div data-testid="mock-sidebar" /> }));
vi.mock('./TopBar', () => ({ TopBar: () => <div data-testid="mock-topbar" /> }));
vi.mock('@/layouts/MobileNav', () => ({ MobileNav: () => null }));
vi.mock('@/layouts/MobileSidebarDrawer', () => ({ MobileSidebarDrawer: () => null }));
vi.mock('@/components/ui/DeepBackground', () => ({ DeepBackground: () => null }));
vi.mock('@/components/ui/PageTransition', () => ({
  PageTransition: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/PlatformAlertBanner', () => ({ PlatformAlertBanner: () => null }));
vi.mock('@/design-system/hooks', () => ({
  useBreakpoint: () => ({ isMobile: false, isMobileVertical: false, isMobileHorizontal: false }),
}));

const OUTLET_MARKER = 'CHILD ROUTE CONTENT';

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'staff@averrow.com',
    role: 'admin',
    display_name: 'Staff User',
    name: 'Staff User',
    organization: null,
    passkey_count: 1,
    ...overrides,
  };
}

function mockAuthedUser(overrides: Record<string, unknown> = {}) {
  mocks.useAuth.mockReturnValue({
    user: makeUser(overrides),
    isSuperAdmin: false,
    isBrandAdmin: false,
    logout: vi.fn().mockResolvedValue(undefined),
    refreshUser: vi.fn().mockResolvedValue(undefined),
  });
}

// Real route nesting (not just a bare wrapper) so <Outlet/> has an actual
// child route to resolve — a plain BrowserRouter with no <Routes/> can't
// exercise the gate's "does the child route mount" behavior at all.
function renderShell(ShellComponent: () => JSX.Element) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<ShellComponent />}>
              <Route index element={<div data-testid="outlet-content">{OUTLET_MARKER}</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const SHELLS: Array<{ name: string; Component: () => JSX.Element }> = [
  { name: 'Shell (classic)', Component: Shell },
  { name: 'ShellV4 (cinematic)', Component: ShellV4 },
];

describe.each(SHELLS)('$name — H-3 passkey enrollment gate', ({ Component }) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('locks the Outlet and shows the blocking enrollment gate when passkey_required is true', () => {
    mockAuthedUser({ passkey_required: true, passkey_count: 0 });
    renderShell(Component);

    // The routed child content must NOT mount — otherwise its data
    // fetches 403 underneath the gate with nothing on screen to explain
    // why (the exact bug this locks down).
    expect(screen.queryByTestId('outlet-content')).not.toBeInTheDocument();
    expect(screen.queryByText(OUTLET_MARKER)).not.toBeInTheDocument();

    // PasskeyEnrollmentGate's own markup — role="dialog", labelled by its
    // "A passkey is required" heading (id="passkey-gate-title").
    const dialog = screen.getByRole('dialog', { name: /passkey is required/i });
    expect(dialog).toBeInTheDocument();
  });

  it('renders the Outlet and does not show the gate when passkey_required is false', () => {
    mockAuthedUser({ passkey_required: false, passkey_count: 1 });
    renderShell(Component);

    expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    expect(screen.getByText(OUTLET_MARKER)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /passkey is required/i })).not.toBeInTheDocument();
  });

  it('renders the Outlet and does not show the gate when passkey_required is absent (normal session)', () => {
    mockAuthedUser({ passkey_count: 1 }); // passkey_required omitted entirely
    renderShell(Component);

    expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /passkey is required/i })).not.toBeInTheDocument();
  });
});
