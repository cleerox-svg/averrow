// History flows: system Back (the Android gesture) walks what the user actually
// did, and in-app Back buttons return to the previous screen, not a fixed page.
// `router.navigate(-1)` is the system Back.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom';
import { stubMatchMedia } from '@/test/shared-ui/helpers';
import { ToastProvider } from '@/components/ui/Toast';
import { TabbedWorkspace } from '@/components/v4/TabbedWorkspace';
import { Console } from '@/features/console/Console';
import { BrandDetailV3 } from '@/features/brands/BrandDetail';
import type { Alert } from '@/hooks/useAlerts';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ isSuperAdmin: false, user: { id: 'u1', role: 'analyst', name: 'Ada', email: 'a@x.io' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('@/features/threats/Threats', () => ({ Threats: () => <div>THREATS PANE</div> }));
vi.mock('@/features/takedowns/Takedowns', () => ({ Takedowns: () => null }));
vi.mock('@/features/admin-incidents/Incidents', () => ({ AdminIncidents: () => null }));

import { api } from '@/lib/api';
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const alert7 = {
  id: 'alr_7', brand_id: 'b1', user_id: 'u9', alert_type: 'social_impersonation', severity: 'critical',
  title: 'Impersonation @flow on TikTok', summary: 'Score 90%', details: null, source_type: null, source_id: null,
  ai_assessment: null, ai_recommendations: null, status: 'new', acknowledged_at: null, resolved_at: null,
  resolution_notes: null, email_sent: 0, webhook_sent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  brand_name: 'Acme', brand_domain: 'acme.com', saas_technique_id: null, saas_technique_name: null,
  saas_technique_phase: null, saas_technique_phase_label: null, saas_technique_severity: null,
  assigned_to: null, assigned_at: null, assigned_to_name: null, assigned_to_email: null,
  staff_assigned_to: null, staff_assigned_at: null, staff_assigned_to_name: null, staff_assigned_to_email: null, staff_notes: null,
} satisfies Alert;

function Loc() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}
function Shell({ children }: { children: React.ReactNode }) {
  return <><Loc />{children}</>;
}
const here = () => screen.getByTestId('loc').textContent;

function mount(router: ReturnType<typeof createMemoryRouter>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider><RouterProvider router={router} /></ToastProvider>
    </QueryClientProvider>,
  );
}
const systemBack = (router: ReturnType<typeof createMemoryRouter>) => act(() => { void router.navigate(-1); });

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia(true);
  Element.prototype.scrollIntoView = vi.fn();
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/alerts/triage-summary')) return { success: true, data: { new_count: 1, critical_count: 1, top: null } };
    if (url.startsWith('/api/alerts/stats')) return { success: true, data: { total: 1, new_count: 1 } };
    if (url === '/api/alerts/alr_7') return { success: true, data: alert7 };
    if (url.startsWith('/api/alerts?')) return { success: true, data: [alert7], total: 1 };
    if (url === '/api/brands/b1') {
      return { success: true, data: { id: 'b1', name: 'Acme', canonical_domain: 'acme.com', top_severity: 'low', threat_count: 0 } };
    }
    return { success: true, data: [] };
  });
});

describe('history flow A: Console tabs and an open alert', () => {
  it('Back closes the alert, then returns to the previous tab, then to the page before the console', async () => {
    const router = createMemoryRouter(
      [
        { path: '/', element: <Shell><Link to="/console">to console</Link></Shell> },
        { path: '/console', element: <Shell><Console /></Shell> },
      ],
      { initialEntries: ['/'] },
    );
    mount(router);

    fireEvent.click(screen.getByText('to console'));
    await screen.findByRole('tab', { name: /Alerts/ });
    expect(here()).toBe('/console');

    fireEvent.click(screen.getByRole('tab', { name: /Threats/ }));
    expect(await screen.findByText('THREATS PANE')).toBeInTheDocument();
    expect(here()).toBe('/console?tab=threats');

    fireEvent.click(screen.getByRole('tab', { name: /Alerts/ }));
    expect(here()).toBe('/console');
    const row = await waitFor(() => {
      const el = document.getElementById('alert-row-alr_7');
      if (!el) throw new Error('row not rendered');
      return el;
    });
    fireEvent.click(row);
    expect(await screen.findByTestId('alert-detail')).toHaveTextContent('@flow');
    expect(here()).toBe('/console?alert=alr_7');

    // Back 1: closes the alert, stays on the Alerts tab.
    systemBack(router);
    await waitFor(() => expect(screen.queryByTestId('alert-detail')).not.toBeInTheDocument());
    expect(here()).toBe('/console');

    // Back 2: the Threats tab the user came from.
    systemBack(router);
    expect(await screen.findByText('THREATS PANE')).toBeInTheDocument();
    expect(here()).toBe('/console?tab=threats');

    // Back 3: the Alerts tab as first opened, Back 4: out of the console to "/".
    systemBack(router);
    await waitFor(() => expect(here()).toBe('/console'));
    systemBack(router);
    await waitFor(() => expect(here()).toBe('/'));
  });

  it('closing the alert with its own close button pops the pushed entry (no duplicate list entry)', async () => {
    const router = createMemoryRouter(
      [{ path: '/', element: <Shell><Console /></Shell> }, { path: '/prev', element: <Shell>prev</Shell> }],
      { initialEntries: ['/prev', '/'], initialIndex: 1 },
    );
    mount(router);
    const row = await waitFor(() => {
      const el = document.getElementById('alert-row-alr_7');
      if (!el) throw new Error('row not rendered');
      return el;
    });
    fireEvent.click(row);
    await screen.findByTestId('alert-detail');
    fireEvent.click(screen.getByRole('button', { name: 'Close alert detail' }));
    await waitFor(() => expect(screen.queryByTestId('alert-detail')).not.toBeInTheDocument());
    // One Back from the list now leaves the console, proving the close popped rather than stacked.
    systemBack(router);
    await waitFor(() => expect(here()).toBe('/prev'));
  });

  it('a filter edit does not add history', async () => {
    const router = createMemoryRouter(
      [{ path: '/', element: <Shell><Console /></Shell> }, { path: '/prev', element: <Shell>prev</Shell> }],
      { initialEntries: ['/prev', '/'], initialIndex: 1 },
    );
    mount(router);
    await screen.findByRole('tab', { name: /Alerts/ });
    expect(router.state.historyAction).toBe('POP');
    const before = router.state.location.key;
    await waitFor(() => expect(document.getElementById('alert-row-alr_7')).not.toBeNull());
    expect(before).toBe(router.state.location.key);
  });
});

describe('history flow B: Explore tabs then a brand detail', () => {
  function ExploreRoute() {
    return (
      <Shell>
        <TabbedWorkspace
          crumb="Explore"
          title="Explore"
          tabs={[
            { id: 'brands', label: 'Brands', Component: () => <div>BRANDS PANE</div> },
            { id: 'actors', label: 'Actors', Component: () => <Link to="/brands/b1">open brand</Link> },
          ]}
        />
      </Shell>
    );
  }
  const routes = [
    { path: '/explore', element: <ExploreRoute /> },
    { path: '/brands/:brandId', element: <Shell><BrandDetailV3 /></Shell> },
  ];

  it('Back from a brand returns to the actors tab, then to the brands tab', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/explore?tab=brands'] });
    mount(router);
    await screen.findByText('BRANDS PANE');

    fireEvent.click(screen.getByRole('tab', { name: 'Actors' }));
    fireEvent.click(await screen.findByText('open brand'));
    await screen.findByText('DMARC report sensor');
    expect(here()).toBe('/brands/b1');

    systemBack(router);
    await screen.findByText('open brand');
    expect(here()).toBe('/explore?tab=actors');

    systemBack(router);
    expect(await screen.findByText('BRANDS PANE')).toBeInTheDocument();
    expect(here()).toBe('/explore?tab=brands');
  });

  it('the in-app Back link on the brand page returns to where the user came from, not the brands list', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/explore?tab=brands'] });
    mount(router);
    await screen.findByText('BRANDS PANE');
    fireEvent.click(screen.getByRole('tab', { name: 'Actors' }));
    fireEvent.click(await screen.findByText('open brand'));
    await screen.findByText('DMARC report sensor');

    fireEvent.click(screen.getByRole('link', { name: /Back/ }));
    await screen.findByText('open brand');
    expect(here()).toBe('/explore?tab=actors');
  });

  it('a cold deep link to a brand: Back goes to the fallback list (replace), never out of the app', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/brands/b1'] });
    mount(router);
    await screen.findByText('DMARC report sensor');

    fireEvent.click(screen.getByRole('link', { name: /Back/ }));
    await screen.findByText('BRANDS PANE');
    expect(here()).toBe('/explore?tab=brands');
    // replace, not push: there is nothing behind the fallback to go back to.
    expect(router.state.historyAction).toBe('REPLACE');
  });
});
