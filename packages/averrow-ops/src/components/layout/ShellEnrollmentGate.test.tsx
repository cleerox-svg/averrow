// Regression coverage for the H-3 passkey enrollment gate on the ops shell
// (AUTH_AUDIT_2026-06 follow-up, 2026-07).
//
// ShellV4 is the only ops shell. A privileged user on an enrollment-scoped
// session (signed in without a passkey) must NOT get the nav + Outlet:
// ShellV4 computes `enrollmentLocked` from `user.passkey_required`, gates its
// Outlet on it, and mounts `PasskeyEnrollmentGate` + `FirstSignInPasskeyPrompt`
// at its root. Without the gate every protected fetch 403s with nothing on
// screen to explain why.
//
// The gate itself (PasskeyEnrollmentGate) is NOT mocked — we assert on
// what it actually renders (role="dialog" + aria-labelledby
// "passkey-gate-title", see PasskeyEnrollmentGate.tsx) so a change that
// breaks the gate's own self-gating would also fail here. Unrelated chrome
// (bell, avatar, theme toggle, alert banner, alert-count query) is stubbed
// out, the same way CommandPalette.test.tsx isolates useGlobalSearch.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { ShellV4 } from './ShellV4';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: mocks.useAuth,
}));

vi.mock('@/components/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('@/hooks/useOpenAlertCount', () => ({
  useOpenAlertCount: () => ({ isSuccess: false, data: undefined }),
}));
vi.mock('./ThemeCycleButton', () => ({ ThemeCycleButton: () => null }));
vi.mock('@/components/PlatformAlertBanner', () => ({ PlatformAlertBanner: () => null }));

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
    logout: vi.fn().mockResolvedValue(undefined),
    refreshUser: vi.fn().mockResolvedValue(undefined),
  });
}

// Real route nesting (not just a bare wrapper) so <Outlet/> has an actual
// child route to resolve — a plain BrowserRouter with no <Routes/> can't
// exercise the gate's "does the child route mount" behavior at all.
function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<ShellV4 />}>
              <Route index element={<div data-testid="outlet-content">{OUTLET_MARKER}</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ShellV4 — H-3 passkey enrollment gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('locks the Outlet and shows the blocking enrollment gate when passkey_required is true', () => {
    mockAuthedUser({ passkey_required: true, passkey_count: 0 });
    renderShell();

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
    renderShell();

    expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    expect(screen.getByText(OUTLET_MARKER)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /passkey is required/i })).not.toBeInTheDocument();
  });

  it('renders the Outlet and does not show the gate when passkey_required is absent (normal session)', () => {
    mockAuthedUser({ passkey_count: 1 }); // passkey_required omitted entirely
    renderShell();

    expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /passkey is required/i })).not.toBeInTheDocument();
  });
});
