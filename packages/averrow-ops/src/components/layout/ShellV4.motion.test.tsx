// Motion kit (P3-4) wiring in the ops shell: the gliding nav indicator and the
// page slide exist only under data-accent; without it the shell is unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { ShellV4 } from './ShellV4';

const mocks = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock('@/lib/auth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@/hooks/useOpenAlertCount', () => ({ useOpenAlertCount: () => ({ isSuccess: true, data: 0 }) }));
vi.mock('@/components/PlatformAlertBanner', () => ({ PlatformAlertBanner: () => null }));
vi.mock('@/components/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('@/components/FirstSignInPasskeyPrompt', () => ({ FirstSignInPasskeyPrompt: () => null }));
vi.mock('@/components/PasskeyEnrollmentGate', () => ({ PasskeyEnrollmentGate: () => null }));
vi.mock('@/design-system/hooks', () => ({ useTheme: () => ({ theme: 'auto', cycle: vi.fn() }) }));

let animate: ReturnType<typeof vi.fn>;

function Go({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>go {to}</button>;
}

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/console']}>
          <Routes>
            <Route element={<ShellV4 />}>
              <Route path="console" element={<Go to="/explore" />} />
              <Route path="explore" element={<Go to="/console" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const nav = () => document.querySelector('.v4-nav') as HTMLElement;
const page = () => document.querySelector('.v4-page') as HTMLElement;
const pageSlides = () => animate.mock.contexts.filter((el) => el === page()).length;

beforeEach(() => {
  mocks.useAuth.mockReturnValue({
    user: { id: 'u1', email: 's@averrow.com', role: 'admin', passkey_count: 1 },
    isSuperAdmin: false,
  });
  animate = vi.fn(() => ({ cancel: vi.fn() }));
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-accent');
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
});

describe('ShellV4 motion', () => {
  it('no accent: no indicator, no data-glide, no page slide', () => {
    renderShell();
    expect(nav().querySelector('.motion-glide')).toBeNull();
    expect(nav()).not.toHaveAttribute('data-glide');
    fireEvent.click(screen.getByRole('button', { name: 'go /explore' }));
    expect(animate).not.toHaveBeenCalled();
  });

  it('accent: the indicator mounts and a route change slides the page', () => {
    document.documentElement.setAttribute('data-accent', 'indigo');
    renderShell();
    expect(nav().querySelector('.motion-glide--y')).not.toBeNull();
    expect(nav()).toHaveAttribute('data-glide');
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'go /explore' })); });
    expect(pageSlides()).toBe(1);
    // Explorer sits below Console in the nav, so the page enters from the right.
    const call = animate.mock.calls.find((_, i) => animate.mock.contexts[i] === page())!;
    expect((call[0] as Keyframe[])[0]).toMatchObject({ transform: 'translateX(24px)' });
  });
});
