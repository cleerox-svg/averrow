// System Back closes the open mobile nav drawer instead of leaving the page,
// and picking a destination from the drawer leaves no dead drawer entry behind.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { ShellV4 } from './ShellV4';

const mocks = vi.hoisted(() => ({ useAuth: vi.fn(), useOpenAlertCount: vi.fn() }));
vi.mock('@/lib/auth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@/hooks/useOpenAlertCount', () => ({ useOpenAlertCount: mocks.useOpenAlertCount }));
vi.mock('@/components/PlatformAlertBanner', () => ({ PlatformAlertBanner: () => null }));
vi.mock('@/components/NotificationBell', () => ({ NotificationBell: () => <div /> }));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => <div /> }));
vi.mock('@/components/FirstSignInPasskeyPrompt', () => ({ FirstSignInPasskeyPrompt: () => null }));
vi.mock('@/components/PasskeyEnrollmentGate', () => ({ PasskeyEnrollmentGate: () => null }));
vi.mock('@/design-system/hooks', () => ({ useTheme: () => ({ theme: 'auto', cycle: vi.fn() }) }));

let nav: ReturnType<typeof useNavigate>;
let where = '';
function Probe() { nav = useNavigate(); const l = useLocation(); where = l.pathname + l.search; return null; }

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/prev', '/']} initialIndex={1}>
          <Probe />
          <Routes>
            <Route path="/prev" element={<div>PREV</div>} />
            <Route element={<ShellV4 />}>
              <Route index element={<div>home</div>} />
              <Route path="console" element={<div>console page</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const shellRoot = (c: HTMLElement) => c.querySelector('.shell-v4') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useAuth.mockReturnValue({
    user: { id: 'u1', email: 's@averrow.com', role: 'admin', display_name: 'Staff', passkey_count: 1 },
    isSuperAdmin: false,
  });
  mocks.useOpenAlertCount.mockReturnValue({ isLoading: false, isError: false, isSuccess: true, data: 0 });
});

describe('ShellV4 drawer and the system Back gesture', () => {
  it('Back closes the open drawer and stays on the page', async () => {
    const { container } = renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(shellRoot(container)).toHaveClass('drawer-open');
    act(() => { void nav(-1); });
    await waitFor(() => expect(shellRoot(container)).not.toHaveClass('drawer-open'));
    expect(where).toBe('/');
  });

  it('closing with the X pops the drawer entry: one Back then leaves the page', async () => {
    const { container } = renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    await waitFor(() => expect(shellRoot(container)).not.toHaveClass('drawer-open'));
    expect(where).toBe('/');
    act(() => { void nav(-1); });
    await screen.findByText('PREV');
  });

  it('choosing a destination from the drawer replaces the drawer entry: Back returns to where the drawer was opened', async () => {
    const { container } = renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.click(screen.getByRole('link', { name: /console/i }));
    await screen.findByText('console page');
    expect(where).toBe('/console');
    expect(shellRoot(container)).not.toHaveClass('drawer-open');
    act(() => { void nav(-1); });
    await waitFor(() => expect(where).toBe('/')); // where the drawer was opened
    expect(screen.getByText('home')).toBeInTheDocument();
    act(() => { void nav(-1); });
    await screen.findByText('PREV'); // no dead drawer entry in between
  });

  it('a nav link outside the open drawer still pushes as before', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('link', { name: /console/i }));
    await screen.findByText('console page');
    act(() => { void nav(-1); });
    await waitFor(() => expect(where).toBe('/'));
  });
});
