/**
 * BrandDetail threats-tab hero tiles: when the `/api/threats` peek fails the
 * tiles must say "Couldn't load", never a fake 0 / "no data".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { stubMatchMedia } from '@/test/shared-ui/helpers';

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'super_admin', email: 's@x.com', name: 'S' }, isSuperAdmin: true }),
}));

import { api } from '@/lib/api';
import { BrandDetailV3 } from './BrandDetail';

const get = api.get as ReturnType<typeof vi.fn>;

function route(threats: 'reject' | 'pending' | { success: true; data: unknown }) {
  get.mockImplementation((url: string) => {
    if (url.startsWith('/api/threats?')) {
      if (threats === 'reject') return Promise.reject(new Error('boom'));
      if (threats === 'pending') return new Promise(() => {});
      return Promise.resolve(threats);
    }
    if (url === '/api/brands/b1') {
      return Promise.resolve({ success: true, data: { id: 'b1', name: 'Acme', canonical_domain: 'acme.com', top_severity: 'low', threat_count: 0 } });
    }
    return Promise.resolve({ success: true });
  });
}

function renderThreatsTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/brands/b1?tab=threats']}>
        <Routes>
          <Route path="/brands/:brandId" element={<BrandDetailV3 />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia(true);
});

describe('BrandDetail threats tab hero tiles', () => {
  it('say "Couldn\'t load" (not 0 / "no data") when the threats peek fails', async () => {
    route('reject');
    renderThreatsTab();
    await waitFor(() => expect(screen.getAllByText("Couldn't load").length).toBe(4));
    expect(screen.queryByText('no data')).not.toBeInTheDocument();
  });

  it('show loading tiles (not 0) while the peek is pending', async () => {
    route('pending');
    renderThreatsTab();
    const tile = (await screen.findByText('Total threats')).closest('div') as HTMLElement;
    expect(tile).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('no data')).not.toBeInTheDocument();
  });

  it('show real numbers (including a genuine 0) once the peek succeeds', async () => {
    route({ success: true, data: { threats: [], total: 0 } });
    renderThreatsTab();
    await screen.findByText('Total threats');
    await waitFor(() => expect(screen.getAllByText('no data').length).toBe(2));
    expect(screen.queryByText("Couldn't load")).not.toBeInTheDocument();
  });
});
