// Sanity: v4 is the only ops shell — no "Classic view" / "Try v4" shell-switch
// control may remain anywhere in ShellV4's chrome (PR #1739).

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { ShellV4 } from './ShellV4';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 's@averrow.com', role: 'super_admin', name: 'S', display_name: 'S', organization: null, passkey_count: 1 },
    isSuperAdmin: true,
    logout: vi.fn(),
    refreshUser: vi.fn(),
  }),
}));
vi.mock('@/components/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('@/hooks/useOpenAlertCount', () => ({
  useOpenAlertCount: () => ({ isSuccess: false, data: undefined }),
}));
vi.mock('./ThemeCycleButton', () => ({ ThemeCycleButton: () => null }));
vi.mock('@/components/PlatformAlertBanner', () => ({ PlatformAlertBanner: () => null }));

describe('ShellV4 — no shell-switch control', () => {
  it('renders no "Classic view" or "Try v4" control', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route element={<ShellV4 />}>
                <Route index element={<div>outlet</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('outlet')).toBeInTheDocument();
    expect(screen.queryByText(/classic view/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/try v4/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /classic|try v4/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /classic|try v4/i })).not.toBeInTheDocument();
  });
});
