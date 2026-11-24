import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { createMockLead } from '@/test/mocks';
import { Leads } from './Leads';

const mocks = vi.hoisted(() => ({
  useLeads: vi.fn(), useLead: vi.fn(), useLeadStats: vi.fn(),
  useUpdateLead: vi.fn(), useRefreshLeadFirmographics: vi.fn(), useEnrichLead: vi.fn(),
}));
vi.mock('@/hooks/useLeads', () => mocks);
vi.mock('./components/FirmographicsCard', () => ({ FirmographicsCard: () => null }));
vi.mock('./components/BuyingSignalsCard', () => ({ BuyingSignalsCard: () => null }));
vi.mock('./components/ScoreBreakdownCard', () => ({ ScoreBreakdownCard: () => null }));
vi.mock('@/features/scan-leads/ScanLeads', () => ({ ScanLeadsView: () => <div>SCAN VIEW</div> }));

const lead = createMockLead({ id: 99, company_name: 'Acme Corp', company_domain: 'acme.com', score_breakdown_json: null });

function Loc() { const l = useLocation(); return <div data-testid="loc">{l.pathname + l.search}</div>; }
function setup(entries: string[], index?: number) {
  const router = createMemoryRouter(
    [{ path: '/leads', element: <><Loc /><Leads /></> }, { path: '/prev', element: <Loc /> }],
    { initialEntries: entries, initialIndex: index },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}><ToastProvider><RouterProvider router={router} /></ToastProvider></QueryClientProvider>,
  );
  return router;
}
const here = () => screen.getByTestId('loc').textContent;

describe('Leads history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useLeads.mockReturnValue({ data: { data: [lead] }, isLoading: false });
    mocks.useLead.mockReturnValue({ data: lead });
    mocks.useLeadStats.mockReturnValue({ data: null });
    mocks.useUpdateLead.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mocks.useRefreshLeadFirmographics.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mocks.useEnrichLead.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it('opening a lead pushes ?lead=; system Back closes it, and the view switch is its own entry', async () => {
    const router = setup(['/leads']);
    fireEvent.click(screen.getByRole('button', { name: 'Sales Pipeline' }));
    expect(here()).toBe('/leads?view=pipeline');
    fireEvent.click(await screen.findByText('Acme Corp'));
    expect(here()).toBe('/leads?view=pipeline&lead=99');

    act(() => { void router.navigate(-1); });
    await waitFor(() => expect(here()).toBe('/leads?view=pipeline'));
    act(() => { void router.navigate(-1); });
    await waitFor(() => expect(here()).toBe('/leads'));
    expect(screen.getByRole('button', { name: 'Kanban' })).toBeInTheDocument();
  });

  it('the detail Back button pops the pushed entry', async () => {
    const router = setup(['/prev', '/leads'], 1);
    fireEvent.click(await screen.findByText('Acme Corp'));
    expect(here()).toBe('/leads?lead=99');
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    await waitFor(() => expect(here()).toBe('/leads'));
    // popped, not stacked: one more Back leaves the page.
    act(() => { void router.navigate(-1); });
    await waitFor(() => expect(here()).toBe('/prev'));
  });

  it('a cold ?lead= deep link: Back goes to the list (replace), not out of the app', async () => {
    const router = setup(['/leads?lead=99']);
    await screen.findByText('Acme Corp');
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    await waitFor(() => expect(here()).toBe('/leads'));
    expect(router.state.historyAction).toBe('REPLACE');
  });
});
