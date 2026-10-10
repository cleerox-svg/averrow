import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { stubMatchMedia } from '@/test/shared-ui/helpers';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

import { api } from '@/lib/api';
import { IdentityThreatsPage } from './IdentityThreatsPage';
import { IdentityThreatsTile } from './IdentityThreatsTile';
import type { IdentityThreatsData } from './types';

const get = api.get as unknown as ReturnType<typeof vi.fn>;

const DATA: IdentityThreatsData = {
  window: '7d',
  generated_at: '2026-10-10T00:00:00Z',
  kpis: { detections: 42, detections_prev: 30, brands_targeted: 7, idps_impersonated: 3, live: 5, taken_down: 11, lookalikes_flagged: 9 },
  trend: [{ day: '2026-10-08', count: 3 }, { day: '2026-10-09', count: 5 }],
  by_vector: [{ vector: 'idp_tenant', label: 'Provider tenant', count: 20, prev: 10 }],
  by_idp: [{ idp: 'okta', label: 'Okta', count: 25, brands: 4, prev: 12 }],
  top_brands: [{ brand_id: 'b1', brand_name: 'Acme Bank', count: 8, idps: ['Okta'] }],
  recent: [{ threat_id: 't1', domain: 'acme-login.okta-evil.com', brand_id: 'b1', brand_name: 'Acme Bank', idp: 'Okta', vector: 'idp_lookalike', status: 'active', created_at: '2026-10-09T10:00:00Z' }],
  mitre: [{ id: 'T1556.006', name: 'Modify Authentication Process', tactic: 'Credential Access', vectors: ['idp_tenant'], count: 12 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia(true);
});

describe('IdentityThreatsPage', () => {
  it('renders KPIs and sections from the response', async () => {
    get.mockResolvedValue({ success: true, data: DATA });
    renderWithProviders(<IdentityThreatsPage />);
    expect(await screen.findByText('Detections')).toBeInTheDocument();
    expect(screen.getByText('Brands targeted')).toBeInTheDocument();
    expect(screen.getByText('Okta', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('acme-login.okta-evil.com')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'T1556.006' })).toHaveAttribute('href', 'https://attack.mitre.org/techniques/T1556/006/');
    expect(get).toHaveBeenCalledWith('/api/intel/identity-threats?window=7d');
  });

  it('refetches with the 30d window', async () => {
    get.mockResolvedValue({ success: true, data: DATA });
    renderWithProviders(<IdentityThreatsPage />);
    await screen.findByText('Detections');
    await userEvent.setup().click(screen.getByRole('tab', { name: '30 days' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/intel/identity-threats?window=30d'));
  });

  it('shows the empty state when there are no detections', async () => {
    get.mockResolvedValue({ success: true, data: { ...DATA, kpis: { ...DATA.kpis, detections: 0 }, recent: [] } });
    renderWithProviders(<IdentityThreatsPage />);
    expect(await screen.findByText(/No identity-provider impersonation detected/i)).toBeInTheDocument();
  });

  it('shows an error with retry (never empty) when the request fails', async () => {
    get.mockRejectedValue(new Error('boom'));
    renderWithProviders(<IdentityThreatsPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load identity threats/i);
    expect(screen.queryByText(/No identity-provider impersonation/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('IdentityThreatsTile', () => {
  it('shows the 7d count linking to the page', async () => {
    get.mockResolvedValue({ success: true, data: DATA });
    renderWithProviders(<IdentityThreatsTile />);
    const link = await screen.findByRole('link');
    expect(link).toHaveAttribute('href', '/identity-threats');
    expect(link).toHaveTextContent('42 detections');
  });

  it('renders nothing when the endpoint fails (404)', async () => {
    get.mockRejectedValue(new Error('HTTP 404'));
    const { container } = renderWithProviders(<IdentityThreatsTile />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.querySelector('a')).toBeNull();
  });
});
