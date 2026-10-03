// Outlet page gutter: padded by default (classic-shell parity), opt-out for
// v4-native surfaces that pad themselves, and a fill variant for Observatory.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { ShellV4, outletLayoutFor } from './ShellV4';

const mocks = vi.hoisted(() => ({ useAuth: vi.fn(), useOpenAlertCount: vi.fn() }));
vi.mock('@/lib/auth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@/hooks/useOpenAlertCount', () => ({ useOpenAlertCount: mocks.useOpenAlertCount }));
vi.mock('@/components/PlatformAlertBanner', () => ({ PlatformAlertBanner: () => null }));
vi.mock('@/components/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('@/components/FirstSignInPasskeyPrompt', () => ({ FirstSignInPasskeyPrompt: () => null }));
vi.mock('@/components/PasskeyEnrollmentGate', () => ({ PasskeyEnrollmentGate: () => null }));
vi.mock('@/design-system/hooks', () => ({ useTheme: () => ({ theme: 'auto', cycle: vi.fn() }) }));

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<ShellV4 />}>
              <Route path="*" element={<div data-testid="page" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.useAuth.mockReturnValue({
    user: { id: 'u1', email: 's@averrow.com', role: 'admin', passkey_count: 1 },
    isSuperAdmin: false,
  });
  mocks.useOpenAlertCount.mockReturnValue({ isSuccess: true, data: 0, isLoading: false, isError: false });
});

describe('outletLayoutFor', () => {
  it.each(['/', '/console', '/explore', '/coverage', '/admin/operations', '/admin/governance', '/console/', '/profile'])(
    '%s is full-bleed', (p) => expect(outletLayoutFor(p)).toBe('bleed'),
  );
  it.each(['/observatory', '/observatory/'])('%s fills the outlet', (p) => expect(outletLayoutFor(p)).toBe('fill'));
  it.each(['/brands', '/admin', '/admin/users', '/alerts', '/agents', '/leads', '/feeds', '/trends', '/brands/b_1'])(
    '%s is padded', (p) => expect(outletLayoutFor(p)).toBe('padded'),
  );
});

describe('ShellV4 outlet gutter class', () => {
  it('wraps a standalone page in the padded gutter', () => {
    const { container, getByTestId } = renderAt('/brands');
    const page = container.querySelector('.v4-outlet > .v4-page') as HTMLElement;
    expect(page).toHaveClass('v4-page--padded');
    expect(page).toContainElement(getByTestId('page'));
  });

  it('does not pad a self-padded v4 surface', () => {
    const { container } = renderAt('/console');
    const page = container.querySelector('.v4-outlet > .v4-page') as HTMLElement;
    expect(page).toHaveClass('v4-page--bleed');
    expect(page).not.toHaveClass('v4-page--padded');
  });

  it('gives Observatory the fill variant', () => {
    const { container } = renderAt('/observatory');
    expect(container.querySelector('.v4-outlet > .v4-page')).toHaveClass('v4-page--fill');
  });
});
