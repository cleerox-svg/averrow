// Takedown detail — the customer's own note is shown again (migration 0276
// moved Averrow's internal notes to a staff-only column the worker never
// returns to the tenant app, so `notes` is customer-only).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/takedowns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/takedowns')>();
  return { ...actual, useTenantTakedownDetail: vi.fn(), useUpdateTakedown: vi.fn() };
});

import { useAuth } from '@/lib/auth';
import { useTenantTakedownDetail, useUpdateTakedown, type TakedownDetailRow } from '@/lib/takedowns';
import { TakedownDetail } from './TakedownDetail';

function takedown(overrides: Partial<TakedownDetailRow> = {}): TakedownDetailRow {
  return {
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
    ...overrides,
  } as TakedownDetailRow;
}

function renderDetail(row: TakedownDetailRow) {
  vi.mocked(useTenantTakedownDetail).mockReturnValue({
    data: { takedown: row, submissions: [] }, isLoading: false, error: null,
  } as unknown as ReturnType<typeof useTenantTakedownDetail>);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/takedowns/td1']}>
        <Routes>
          <Route path="/takedowns/:takedownId" element={<TakedownDetail />} />
        </Routes>
      </MemoryRouter>
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
  vi.mocked(useUpdateTakedown).mockReturnValue(
    { mutate: vi.fn(), isPending: false, isError: false, error: null } as unknown as ReturnType<typeof useUpdateTakedown>,
  );
});

describe('TakedownDetail — customer note', () => {
  it("shows the customer's own note", () => {
    renderDetail(takedown({ notes: 'Approved by legal on Oct 1' }));
    const section = screen.getByRole('region', { name: "Your team's note" });
    expect(section).toHaveTextContent('Approved by legal on Oct 1');
  });

  it('renders no note section when there is no note', () => {
    renderDetail(takedown({ notes: null }));
    expect(screen.queryByRole('region', { name: "Your team's note" })).not.toBeInTheDocument();
  });
});
