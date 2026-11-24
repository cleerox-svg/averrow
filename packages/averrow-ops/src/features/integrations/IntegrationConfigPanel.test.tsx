import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Integrations } from './Integrations';
import type { IntegrationHealth, IntegrationsReport } from '@/hooks/useTakedownIntegrations';
import { installDomStubs, stubViewport } from '../../test/shared-ui/overlays/helpers';

const apiGet = vi.fn();
const apiPatch = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => apiGet(...a), patch: (...a: unknown[]) => apiPatch(...a) },
}));

let role = 'super_admin';
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role } }),
}));

const base = {
  total: 10, submitted: 6, queued: 1, rejected: 1, failed: 2, success_rate: 75,
  last_submission_at: null, auto_submit_enabled: null,
} as const;

function apiItem(over: Partial<IntegrationHealth> = {}): IntegrationHealth {
  return {
    ...base, kind: 'api_web_risk', label: 'Google Web Risk', channel: 'api', api_type: 'web_risk',
    provider_name: 'Google', configured: true, auto_submit_enabled: false, status: 'paused',
    last_error: 'Upstream said no: a very long error message that should wrap fully',
    monthly_quota: { used: 12, cap: 100 },
    config: {
      credential_secrets: ['WEB_RISK_API_KEY'], credential_status: [{ name: 'WEB_RISK_API_KEY', set: false }], optional_vars: ['WEB_RISK_MONTHLY_CAP'],
      requires_live_mode: true, send_mode: 'draft', auto_submit_editable: true,
      provider: {
        id: 7, provider_name: 'Google', provider_type: 'safe_browsing', abuse_email: null,
        abuse_url: 'https://example.test/report', abuse_api_url: null, abuse_api_type: 'web_risk',
        auto_submit_enabled: false,
      },
    },
    ...over,
  } as IntegrationHealth;
}

const emailItem: IntegrationHealth = {
  ...base, kind: 'abuse_email_live', label: 'Abuse email live send', channel: 'email', api_type: null,
  provider_name: null, configured: true, status: 'active', last_error: null,
  config: {
    credential_secrets: ['RESEND_API_KEY'], optional_vars: [], requires_live_mode: true,
    send_mode: 'live', provider: null, auto_submit_editable: false,
  },
};

function renderPage(items: IntegrationHealth[]) {
  const report: IntegrationsReport = { window_hours: 168, send_mode: 'draft', integrations: items };
  apiGet.mockResolvedValue({ success: true, data: report });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const spy = vi.spyOn(qc, 'invalidateQueries');
  render(<QueryClientProvider client={qc}><MemoryRouter><Integrations /></MemoryRouter></QueryClientProvider>);
  return { spy };
}

beforeEach(() => {
  installDomStubs();
  stubViewport(false);
  apiGet.mockReset();
  apiPatch.mockReset();
  role = 'super_admin';
});

describe('IntegrationConfigPanel', () => {
  it('opens from a card by click and keyboard, and closes', async () => {
    const user = userEvent.setup();
    renderPage([apiItem(), emailItem]);
    const card = await screen.findByRole('button', { name: /Open configuration for Google Web Risk/ });
    await user.click(card);
    expect(await screen.findByRole('dialog', { name: 'Google Web Risk' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const email = screen.getByRole('button', { name: /Open configuration for Abuse email live send/ });
    email.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Abuse email live send' })).toBeInTheDocument();
  });

  it('shows api-kind config: secrets by name, provider, quota, activity', async () => {
    const user = userEvent.setup();
    renderPage([apiItem()]);
    await user.click(await screen.findByRole('button', { name: /Open configuration for Google Web Risk/ }));
    const panel = within(await screen.findByTestId('integration-config'));
    expect(panel.getByText('WEB_RISK_API_KEY')).toBeInTheDocument();
    expect(panel.getByText('missing')).toBeInTheDocument(); // per-secret status, not it.configured
    expect(panel.getByText('Draft')).toBeInTheDocument();
    expect(panel.getAllByText('WEB_RISK_MONTHLY_CAP').length).toBeGreaterThan(0);
    expect(panel.getByText(/Variables and Secrets/)).toBeInTheDocument();
    expect(panel.getByText(/nothing leaves the platform/i)).toBeInTheDocument();
    expect(panel.getByText('safe_browsing')).toBeInTheDocument();
    expect(panel.getByText('https://example.test/report')).toBeInTheDocument();
    expect(panel.getAllByText('—').length).toBeGreaterThan(0); // null abuse email / api url
    expect(panel.getByText('12 / 100')).toBeInTheDocument();
    expect(panel.getByText(/a very long error message that should wrap fully/)).toBeInTheDocument();
  });

  it('shows email-kind config without provider section or switch', async () => {
    const user = userEvent.setup();
    renderPage([emailItem]);
    await user.click(await screen.findByRole('button', { name: /Open configuration for Abuse email live send/ }));
    const panel = within(await screen.findByTestId('integration-config'));
    expect(panel.getByText('RESEND_API_KEY')).toBeInTheDocument();
    expect(panel.getByText('set')).toBeInTheDocument(); // aggregate fallback, no credential_status
    expect(panel.getByText('Email')).toBeInTheDocument();
    expect(panel.getByText(/Live: submissions leave/)).toBeInTheDocument();
    expect(panel.queryByText('Provider')).toBeNull();
    expect(panel.queryByRole('switch')).toBeNull();
  });

  it('still renders base info when config is missing', async () => {
    const user = userEvent.setup();
    renderPage([apiItem({ config: undefined, monthly_quota: undefined })]);
    await user.click(await screen.findByRole('button', { name: /Open configuration for Google Web Risk/ }));
    const panel = within(await screen.findByTestId('integration-config'));
    expect(panel.getByText('API')).toBeInTheDocument();
    expect(panel.getByText('set')).toBeInTheDocument();
    expect(panel.getByText('Submitted')).toBeInTheDocument();
    expect(panel.queryByRole('switch')).toBeNull();
  });

  it('admin enables auto-submit after confirming, PATCHes and invalidates', async () => {
    const user = userEvent.setup();
    apiPatch.mockResolvedValue({ success: true, data: apiItem() });
    const { spy } = renderPage([apiItem()]);
    await user.click(await screen.findByRole('button', { name: /Open configuration for Google Web Risk/ }));
    await user.click(await screen.findByRole('switch', { name: 'Auto-submit takedowns' }));
    expect(apiPatch).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Turn on auto-submit' }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith(
      '/api/admin/takedowns/integrations/api_web_risk', { auto_submit_enabled: true },
    ));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['takedown-integrations'] }));
  });

  it('cancelling the confirm sends nothing', async () => {
    const user = userEvent.setup();
    renderPage([apiItem()]);
    await user.click(await screen.findByRole('button', { name: /Open configuration for Google Web Risk/ }));
    await user.click(await screen.findByRole('switch'));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('turning off needs no confirm; an error reverts and is shown', async () => {
    const user = userEvent.setup();
    apiPatch.mockResolvedValue({ success: false, error: 'Admins only', status: 403 });
    const on = apiItem();
    on.config!.provider!.auto_submit_enabled = true;
    renderPage([on]);
    await user.click(await screen.findByRole('button', { name: /Open configuration for Google Web Risk/ }));
    const sw = await screen.findByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
    expect(apiPatch).toHaveBeenCalledWith(
      '/api/admin/takedowns/integrations/api_web_risk', { auto_submit_enabled: false },
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Admins only');
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
  });

  it('admin may turn auto-submit OFF without confirm', async () => {
    role = 'admin';
    const user = userEvent.setup();
    apiPatch.mockResolvedValue({ success: true, data: {} });
    const on = apiItem();
    on.config!.provider!.auto_submit_enabled = true;
    renderPage([on]);
    await user.click(await screen.findByRole('button', { name: /Open configuration for Google Web Risk/ }));
    const sw = await screen.findByRole('switch');
    expect(sw).toBeEnabled();
    await user.click(sw);
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith(
      '/api/admin/takedowns/integrations/api_web_risk', { auto_submit_enabled: false },
    ));
  });

  it('admin sees an OFF switch disabled with the super-admin note', async () => {
    role = 'admin';
    const user = userEvent.setup();
    renderPage([apiItem()]);
    await user.click(await screen.findByRole('button', { name: /Open configuration for Google Web Risk/ }));
    expect(await screen.findByRole('switch')).toBeDisabled();
    expect(screen.getByText('Only a super admin can turn this on')).toBeInTheDocument();
  });

  it('other roles see the switch read-only with the admins note', async () => {
    role = 'analyst';
    const user = userEvent.setup();
    renderPage([apiItem()]);
    await user.click(await screen.findByRole('button', { name: /Open configuration for Google Web Risk/ }));
    expect(await screen.findByRole('switch')).toBeDisabled();
    expect(screen.getByText('Only admins can change this')).toBeInTheDocument();
  });

  it('explains a non-editable api kind', async () => {
    const user = userEvent.setup();
    const it = apiItem();
    it.config!.auto_submit_editable = false;
    renderPage([it]);
    await user.click(await screen.findByRole('button', { name: /Open configuration for Google Web Risk/ }));
    expect(await screen.findByText(/no provider row/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
