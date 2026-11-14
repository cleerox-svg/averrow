/**
 * `?tab=email` (notification deep links) and the email "View DNS Details" button
 * must land on the DMARC sensor card; `email` is not a V3 tab.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
const scrollIntoView = vi.fn();

function renderAt(search: string) {
  get.mockImplementation((url: string) => {
    if (url === '/api/brands/b1') {
      return Promise.resolve({ success: true, data: { id: 'b1', name: 'Acme', canonical_domain: 'acme.com', top_severity: 'low', threat_count: 0 } });
    }
    return Promise.resolve({ success: true });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/brands/b1${search}`]}>
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
  Element.prototype.scrollIntoView = scrollIntoView;
});

describe('BrandDetail DMARC sensor jump', () => {
  it('scrolls to the sensor card for ?tab=email once the brand has loaded', async () => {
    renderAt('?tab=email');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect((scrollIntoView.mock.instances[0] as HTMLElement).id).toBe('dmarc-sensor');
  });

  it('does not scroll without the deep link', async () => {
    renderAt('');
    await screen.findByText('DMARC report sensor');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('"View DNS Details" on the Risk tab switches to Surface and scrolls to the card', async () => {
    renderAt('?tab=risk');
    fireEvent.click(await screen.findByRole('button', { name: /View DNS Details/ }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('DMARC report sensor')).toBeInTheDocument();
  });
});
