// System Back (the Android gesture) closes the config sheet and stays on Integrations.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Integrations } from './Integrations';
import type { IntegrationHealth, IntegrationsReport } from '@/hooks/useTakedownIntegrations';
import { installDomStubs, stubViewport } from '../../test/shared-ui/overlays/helpers';

const apiGet = vi.fn();
vi.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => apiGet(...a), patch: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'super_admin' } }) }));

const item = {
  total: 10, submitted: 6, queued: 1, rejected: 1, failed: 2, success_rate: 75, last_submission_at: null,
  kind: 'api_web_risk', label: 'Google Web Risk', channel: 'api', api_type: 'web_risk', provider_name: 'Google',
  configured: true, auto_submit_enabled: false, status: 'paused', last_error: null,
  config: {
    credential_secrets: ['WEB_RISK_API_KEY'], credential_status: [{ name: 'WEB_RISK_API_KEY', set: true }], optional_vars: [],
    requires_live_mode: true, send_mode: 'draft', auto_submit_editable: true,
    provider: { id: 7, provider_name: 'Google', provider_type: 'safe_browsing', abuse_email: null, abuse_url: null, abuse_api_url: null, abuse_api_type: 'web_risk', auto_submit_enabled: false },
  },
} as unknown as IntegrationHealth;

function mount() {
  const report: IntegrationsReport = { window_hours: 168, send_mode: 'draft', integrations: [item] };
  apiGet.mockResolvedValue({ success: true, data: report });
  const router = createMemoryRouter(
    [{ path: '/integrations', element: <Integrations /> }, { path: '/prev', element: <div>PREV</div> }],
    { initialEntries: ['/prev', '/integrations'], initialIndex: 1 },
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

beforeEach(() => { installDomStubs(); stubViewport(true); apiGet.mockReset(); });

describe('Integrations config sheet and the system Back gesture', () => {
  it('Back closes the sheet and stays on Integrations (phone sheet)', async () => {
    const user = userEvent.setup();
    const router = mount();
    await user.click(await screen.findByRole('button', { name: /Open configuration for Google Web Risk/ }));
    await screen.findByRole('dialog', { name: 'Google Web Risk' });
    act(() => { void router.navigate(-1); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/integrations');
    // The next Back leaves the page, as normal.
    act(() => { void router.navigate(-1); });
    await screen.findByText('PREV');
  });

  it('the Close button pops the sheet entry: one Back then leaves the page', async () => {
    const user = userEvent.setup();
    const router = mount();
    await user.click(await screen.findByRole('button', { name: /Open configuration for Google Web Risk/ }));
    await screen.findByRole('dialog', { name: 'Google Web Risk' });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(router.state.location.state).toBeNull());
    act(() => { void router.navigate(-1); });
    await screen.findByText('PREV');
  });

  it('Back closes the auto-submit confirm first, then the sheet', async () => {
    const user = userEvent.setup();
    const router = mount();
    await user.click(await screen.findByRole('button', { name: /Open configuration for Google Web Risk/ }));
    await screen.findByRole('dialog', { name: 'Google Web Risk' });
    await user.click(screen.getByRole('switch'));
    await screen.findByRole('dialog', { name: /Turn on auto-submit/ });
    act(() => { void router.navigate(-1); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Turn on auto-submit/ })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Google Web Risk' })).toBeInTheDocument();
    act(() => { void router.navigate(-1); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/integrations');
  });
});
