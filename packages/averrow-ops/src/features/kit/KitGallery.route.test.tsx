// /kit gallery (P3-4): a lazy route inside the staff shell, reachable by every
// staff role (incl. the read-only auditor), absent from the nav and palette.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, configure, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Outlet } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ useAuth: vi.fn() }));

vi.mock('@/lib/auth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@/components/layout/ShellV4', () => ({
  ShellV4: () => <Outlet />,
  outletLayoutFor: () => 'padded',
}));

import App from '@/App';

configure({ asyncUtilTimeout: 10000 });

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function asRole(role: string) {
  mocks.useAuth.mockReturnValue({
    isAuthenticated: true,
    loading: false,
    isSuperAdmin: role === 'super_admin',
    user: { id: 'u1', email: 'staff@averrow.com', name: 'Staff', role, passkey_count: 1, organization: null },
    refreshUser: vi.fn(),
    logout: vi.fn(),
  });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-accent');
  document.documentElement.removeAttribute('data-base');
  document.documentElement.removeAttribute('data-motion');
});
afterEach(() => {
  document.documentElement.removeAttribute('data-accent');
  document.documentElement.removeAttribute('data-base');
  document.documentElement.removeAttribute('data-motion');
});

describe('/kit route', () => {
  for (const role of ['super_admin', 'analyst', 'auditor']) {
    it(`renders the gallery for ${role}`, async () => {
      asRole(role);
      renderAt('/kit');
      expect(await screen.findByRole('heading', { name: 'Design kit' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Motion' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Tokens' })).toBeInTheDocument();
      expect(document.querySelector('[data-slot="logo"]')).not.toBeNull();
    });
  }

  it('the accent switcher sets data-accent and "Reset to legacy" clears it', async () => {
    asRole('analyst');
    renderAt('/kit');
    await screen.findByRole('heading', { name: 'Design kit' });
    expect(document.querySelector('.motion-glide')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'violet' }));
    expect(document.documentElement.getAttribute('data-accent')).toBe('violet');
    // The motion demos come alive (gliding indicators mount) once an accent is set.
    await waitFor(() => expect(document.querySelector('.motion-glide')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Reset to legacy' }));
    expect(document.documentElement.hasAttribute('data-accent')).toBe(false);
    await waitFor(() => expect(document.querySelector('.motion-glide')).toBeNull());
  });

  it('the reduced-motion simulation toggles html[data-motion] and cleans up', async () => {
    asRole('analyst');
    const { unmount } = renderAt('/kit');
    await screen.findByRole('heading', { name: 'Design kit' });
    fireEvent.click(screen.getByLabelText('Simulate reduced motion'));
    expect(document.documentElement.getAttribute('data-motion')).toBe('reduce');
    act(() => unmount());
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false);
  });

  it('is not linked from the shell nav or the command palette', () => {
    const shell = readFileSync(resolve(__dirname, '../../components/layout/ShellV4.tsx'), 'utf8');
    expect(shell).not.toMatch(/['"]\/kit['"]/);
  });
});
