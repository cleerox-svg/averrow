// Back on the takedown detail returns to where the user came from, and only
// falls back to the /takedowns list on a cold start (deep link / reload).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';

vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/takedowns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/takedowns')>();
  return { ...actual, useTenantTakedownDetail: vi.fn(), useUpdateTakedown: vi.fn() };
});

import { useAuth } from '@/lib/auth';
import { useTenantTakedownDetail, useUpdateTakedown, type TakedownDetailRow } from '@/lib/takedowns';
import { TakedownDetail } from './TakedownDetail';

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function mount(path: string) {
  window.history.replaceState(null, '', path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Where />
        <Routes>
          <Route path="/takedowns" element={<Link to="/takedowns/td1">open td1</Link>} />
          <Route path="/takedowns/:takedownId" element={<TakedownDetail />} />
          <Route path="/alerts" element={<div>alerts page</div>} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({
    user: {
      id: 'u1', email: 'x@example.com', name: 'X', role: 'client',
      organization: { id: 7, name: 'Acme', slug: 'acme', plan: 'business', role: 'analyst' },
    },
    hasOrg: true,
    loading: false,
  } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(useUpdateTakedown).mockReturnValue({
    mutate: vi.fn(), isPending: false, isError: false, error: null,
  } as unknown as ReturnType<typeof useUpdateTakedown>);
  vi.mocked(useTenantTakedownDetail).mockReturnValue({
    data: {
      takedown: {
        id: 'td1', org_id: 7, brand_id: 'b1', brand_name: 'Acme', module_key: 'domain',
        target_type: 'domain', target_value: 'acme-login.example', target_url: null,
        status: 'taken_down', severity: 'HIGH', provider_name: null, provider_method: null,
        evidence_summary: 'Phishing kit', submitted_at: null, resolved_at: null, resolution: null,
        created_at: '2026-10-01T00:00:00Z', submission_count: 0,
        source_type: null, source_id: null, evidence_detail: null, evidence_urls: null,
        screenshot_url: null, provider_abuse_contact: null, priority_score: 50,
        requested_at: null, response_received_at: null, response_notes: null, notes: null,
        requested_by: null, requested_by_name: null, submitted_by: null, submitted_by_name: null,
        updated_at: '2026-10-01T00:00:00Z',
      } as unknown as TakedownDetailRow,
      submissions: [],
    },
    isLoading: false, error: null,
  } as unknown as ReturnType<typeof useTenantTakedownDetail>);
});

describe('TakedownDetail Back', () => {
  it('deep link: Back goes to the /takedowns fallback', () => {
    mount('/takedowns/td1');
    fireEvent.click(screen.getByText(/BACK TO TAKEDOWNS/));
    expect(screen.getByTestId('where').textContent).toBe('/takedowns');
  });

  it('in-app list -> detail -> Back returns to the list', async () => {
    mount('/takedowns');
    fireEvent.click(screen.getByText('open td1'));
    expect(screen.getByTestId('where').textContent).toBe('/takedowns/td1');
    fireEvent.click(screen.getByText(/BACK TO TAKEDOWNS/));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/takedowns'));
    expect(screen.getByText('open td1')).toBeTruthy();
  });
});
