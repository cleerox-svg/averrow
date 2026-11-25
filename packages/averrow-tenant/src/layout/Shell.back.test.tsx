// System Back closes the open mobile nav drawer; picking a destination replaces the drawer entry.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Shell } from './Shell';

vi.mock('@/lib/auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'u1', email: 'jane@acme.test', name: 'Jane Doe', display_name: 'Jane Doe', organization: { id: 'org1', name: 'Acme', role: 'admin', plan: 'professional' } },
    loading: false,
    logout: vi.fn(),
  })),
}));
vi.mock('@/lib/modules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/modules')>();
  return { ...actual, useTenantModules: () => ({ data: { modules: [] }, isLoading: false }) };
});
vi.mock('@/lib/auditLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auditLog')>();
  return { ...actual, useCanViewAudit: () => false };
});
vi.mock('@/lib/useTheme', () => ({ useTheme: () => ({ theme: 'dark', cycle: vi.fn() }) }));

let nav: ReturnType<typeof useNavigate>;
let where = '';
function Probe() { nav = useNavigate(); where = useLocation().pathname; return null; }

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/prev', '/console']} initialIndex={1}>
        <Probe />
        <Routes>
          <Route path="/prev" element={<div>PREV</div>} />
          <Route element={<Shell />}>
            <Route path="*" element={<div>page content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const aside = (c: HTMLElement) => c.querySelector('aside#tenant-sidebar') as HTMLElement;

beforeEach(() => {
  window.matchMedia = vi.fn((query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false, onchange: null,
  })) as unknown as typeof window.matchMedia;
});

describe('tenant Shell drawer and the system Back gesture', () => {
  it('Back closes the open drawer and stays on the page', async () => {
    const { container } = renderShell();
    const btn = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    act(() => { void nav(-1); });
    await waitFor(() => expect(btn).toHaveAttribute('aria-expanded', 'false'));
    expect(where).toBe('/console');
    expect(aside(container)).not.toHaveAttribute('role', 'dialog');
  });

  it('closing with the X pops the entry; one Back then leaves the page', async () => {
    const { container } = renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.click(aside(container).querySelector('button[aria-label="Close navigation"]') as HTMLElement);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false'));
    act(() => { void nav(-1); });
    await screen.findByText('PREV');
  });

  it('choosing a destination replaces the drawer entry: Back returns to where the drawer was opened', async () => {
    const { container } = renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.click(aside(container).querySelector('a[href="/threats"]') as HTMLElement);
    await waitFor(() => expect(where).toBe('/threats'));
    act(() => { void nav(-1); });
    await waitFor(() => expect(where).toBe('/console')); // where the drawer was opened
    act(() => { void nav(-1); });
    await screen.findByText('PREV'); // no dead drawer entry in between
  });
});
