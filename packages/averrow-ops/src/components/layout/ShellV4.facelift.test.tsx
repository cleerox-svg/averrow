// Facelift Phase 6 (screen 1): ops shell restyle — Offline indicator,
// passkey mounts in both render branches, version line, and the shell CSS
// guard rails (no sub-12px type / amber literal under an accent).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { VERSION_LABEL } from '@/lib/version';
import { ShellV4 } from './ShellV4';

const mocks = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock('@/lib/auth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@/hooks/useOpenAlertCount', () => ({ useOpenAlertCount: () => ({ isSuccess: true, data: 0 }) }));
vi.mock('@/components/PlatformAlertBanner', () => ({ PlatformAlertBanner: () => null }));
vi.mock('@/components/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('@/components/FirstSignInPasskeyPrompt', () => ({ FirstSignInPasskeyPrompt: () => <div data-testid="first-sign-in-prompt" /> }));
vi.mock('@/components/PasskeyEnrollmentGate', () => ({ PasskeyEnrollmentGate: () => <div data-testid="enrollment-gate" /> }));
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
});

describe('Offline indicator', () => {
  it('shows nothing while online, "Offline" (role=status) on the offline event, and hides again on online', () => {
    const { container } = renderAt('/');
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    expect(container.querySelector('.v4-live')).toBeNull();

    act(() => { window.dispatchEvent(new Event('offline')); });
    const label = screen.getByText('Offline');
    expect(label).toHaveAttribute('role', 'status');

    act(() => { window.dispatchEvent(new Event('online')); });
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
  });
});

describe('passkey mounts', () => {
  it('mounts the first-sign-in prompt and enrollment gate in the normal branch', () => {
    renderAt('/');
    expect(screen.getByTestId('first-sign-in-prompt')).toBeInTheDocument();
    expect(screen.getByTestId('enrollment-gate')).toBeInTheDocument();
  });
  it('mounts both in the Observatory wall branch too', () => {
    renderAt('/observatory?wall=1');
    expect(screen.getByTestId('first-sign-in-prompt')).toBeInTheDocument();
    expect(screen.getByTestId('enrollment-gate')).toBeInTheDocument();
  });
});

describe('version line', () => {
  it('renders for a normal screen and is absent on the wall screen', () => {
    const { container, unmount } = renderAt('/');
    expect(container.querySelector('.v4-verline')).toHaveTextContent(VERSION_LABEL);
    unmount();
    const wall = renderAt('/observatory?wall=1');
    expect(wall.container.querySelector('.v4-verline')).toBeNull();
  });
});

describe('shell-v4.css guard rails', () => {
  const css = readFileSync(resolve(__dirname, 'shell-v4.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));

  it('no shell rule uses a font-size below 12px outside the legacy brand sub-line', () => {
    for (const { sel, body } of rules) {
      for (const m of body.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
        if (sel === '.v4-brand .sub') continue; // legacy-only brand block (hidden under an accent)
        expect(Number(m[1]), `${sel} font-size`).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('rules scoped under an accent contain no amber literal and no sub-12px type', () => {
    const accent = rules.filter((r) => r.sel.includes('[data-accent]'));
    expect(accent.length).toBeGreaterThan(0);
    for (const { sel, body } of accent) {
      expect(body, sel).not.toMatch(/var\(--amber|#e5a832|229\s*,\s*168\s*,\s*50/i);
      for (const m of body.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) expect(Number(m[1]), sel).toBeGreaterThanOrEqual(12);
    }
  });

  it('removes the canvas vignette and grid under an accent and no LIVE pulse remains', () => {
    expect(css).toMatch(/:root\[data-accent\] \.shell-v4::before/);
    expect(css).not.toMatch(/v4-live|v4ping/);
  });
});
