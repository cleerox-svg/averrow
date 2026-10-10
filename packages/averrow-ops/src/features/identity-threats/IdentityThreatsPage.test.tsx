import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { stubMatchMedia } from '@/test/shared-ui/helpers';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

import { api } from '@/lib/api';
import { IdentityThreatsPage } from './IdentityThreatsPage';
import { IdentityThreatsTile } from './IdentityThreatsTile';
import type { IdentityDetectionDetail, IdentityDetectionList, IdentityThreatsData } from './types';

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

const ITEM = {
  threat_id: 't1', domain: 'acme-login.okta-evil.com', url: 'https://acme-login.okta-evil.com/signin?x=1',
  brand_id: 'b1', brand_name: 'Acme Bank', idp: 'okta', idp_label: 'Okta',
  vector: 'idp_lookalike' as const, vector_label: 'Lookalike sign-in domain',
  status: 'active', severity: 'high', source_feed: 'openphish', created_at: '2026-10-09T10:00:00Z',
};
const LIST: IdentityDetectionList = { items: [ITEM], next_cursor: null, total: 1 };
const DETAIL: IdentityDetectionDetail = {
  ...ITEM,
  technique: 'idp_lookalike',
  matched_lure: 'okta',
  ttps: [{ id: 'T1566.002', name: 'Spearphishing Link', tactic: 'Initial Access', url: 'https://attack.mitre.org/techniques/T1566/002/' }],
  infrastructure: { ip_address: null, country_code: 'US', asn: null, hosting_provider: null, ssl_cert_issuer: null },
  registration: { domain_created_at: null, domain_age_days: 3, weaponization_hours: null, weaponization_flag: null },
  reputation: {
    vt_checked: false, vt_malicious: null, gsb_checked: true, gsb_flagged: false, gsb_threat_type: null,
    greynoise_checked: false, greynoise_classification: null, seclookup_checked: false, seclookup_risk_score: null,
    surbl_listed: null, dbl_listed: null,
  },
  timeline: { first_seen: null, last_seen: null, created_at: '2026-10-09T10:00:00Z', enriched_at: null },
  takedown: null,
  cluster: null,
};

function route(list: (qs: URLSearchParams) => IdentityDetectionList = () => LIST) {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/intel/identity-threats/detections/')) return { success: true, data: DETAIL };
    if (url.startsWith('/api/intel/identity-threats/detections')) {
      return { success: true, data: list(new URLSearchParams(url.split('?')[1])) };
    }
    return { success: true, data: DATA };
  });
}
const listCalls = () => get.mock.calls.map((c) => c[0] as string).filter((u) => u.startsWith('/api/intel/identity-threats/detections?'));

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia(true);
  window.history.replaceState({}, '', '/');
  route();
});

describe('IdentityThreatsPage', () => {
  it('renders KPIs and sections from the response', async () => {
    renderWithProviders(<IdentityThreatsPage />);
    expect((await screen.findAllByText('Detections'))[0]).toBeInTheDocument();
    expect(screen.getByText('Brands targeted')).toBeInTheDocument();
    expect(await screen.findByText('acme-login.okta-evil.com')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^T1556\.006/ })).toHaveAttribute('href', 'https://attack.mitre.org/techniques/T1556/006/');
    expect(get).toHaveBeenCalledWith('/api/intel/identity-threats?window=7d');
  });

  it('refetches with the 30d window', async () => {
    renderWithProviders(<IdentityThreatsPage />);
    await screen.findByText('Brands targeted');
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

describe('IdentityThreatsPage drill-down', () => {
  it('clicking a provider row sets ?idp, refetches the list with it, and the chip removes it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IdentityThreatsPage />);
    const row = await screen.findByRole('button', { name: /^Okta/ });
    expect(row).toHaveAttribute('aria-pressed', 'false');
    await user.click(row);
    await waitFor(() => expect(listCalls().some((u) => u.includes('idp=okta') && u.includes('limit=25') && u.includes('window=7d'))).toBe(true));
    expect(window.location.search).toContain('idp=okta');
    expect(screen.getByRole('button', { name: /^Okta/ })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText('1 detection · Okta')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove filter: Okta' }));
    await waitFor(() => expect(window.location.search).not.toContain('idp'));
    expect(screen.queryByRole('group', { name: 'Active filters' })).not.toBeInTheDocument();
  });

  it('reads filters from the URL, stacks them, and Clear all removes every one', async () => {
    window.history.replaceState({}, '', '/?idp=okta&vector=idp_tenant&window=30d');
    const user = userEvent.setup();
    renderWithProviders(<IdentityThreatsPage />);
    await waitFor(() => expect(listCalls().some((u) => u.includes('idp=okta') && u.includes('vector=idp_tenant') && u.includes('window=30d'))).toBe(true));
    expect(screen.getByRole('button', { name: 'Remove filter: Okta' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(window.location.search).toBe('?window=30d'));
  });

  it('clicking an active row toggles the filter off; MITRE and brand rows filter too', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IdentityThreatsPage />);
    await user.click(await screen.findByRole('button', { name: 'Modify Authentication Process' }));
    await waitFor(() => expect(listCalls().some((u) => u.includes('mitre=T1556.006'))).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Modify Authentication Process' }));
    await waitFor(() => expect(window.location.search).not.toContain('mitre'));
    await user.click(screen.getByRole('button', { name: /^Acme Bank/ }));
    await waitFor(() => expect(listCalls().some((u) => u.includes('brand_id=b1'))).toBe(true));
    expect(screen.getByRole('link', { name: 'Open Acme Bank brand page' })).toHaveAttribute('href', '/brands/b1');
  });

  it('Load more passes next_cursor', async () => {
    route((qs) => qs.get('cursor')
      ? { items: [{ ...ITEM, threat_id: 't2', domain: 'second.example.com' }], next_cursor: null, total: 2 }
      : { items: [ITEM], next_cursor: 'cur1', total: 2 });
    const user = userEvent.setup();
    renderWithProviders(<IdentityThreatsPage />);
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('second.example.com')).toBeInTheDocument();
    expect(listCalls().some((u) => u.includes('cursor=cur1'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows an empty state for a filtered list with no results', async () => {
    route(() => ({ items: [], next_cursor: null, total: 0 }));
    renderWithProviders(<IdentityThreatsPage />);
    expect(await screen.findByText('No detections match these filters')).toBeInTheDocument();
  });

  it('expanding a detection lazily fetches detail: TTP chips, Not checked, and dashes for nulls', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IdentityThreatsPage />);
    const toggle = await screen.findByRole('button', { name: /acme-login\.okta-evil\.com/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(get).not.toHaveBeenCalledWith('/api/intel/identity-threats/detections/t1');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const ttp = await screen.findByRole('link', { name: /T1566\.002 · Spearphishing Link/ });
    expect(ttp).toHaveAttribute('href', 'https://attack.mitre.org/techniques/T1566/002/');
    expect(ttp).toHaveAttribute('target', '_blank');
    expect(ttp).toHaveTextContent('(opens in new tab)');
    expect(get).toHaveBeenCalledWith('/api/intel/identity-threats/detections/t1');
    expect(screen.getByText(/Matched:/)).toBeInTheDocument();
    expect(screen.getAllByText('Not checked').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('No takedown')).toBeInTheDocument();
    expect(screen.getByText('Not flagged')).toBeInTheDocument();
    expect(screen.queryByText('null')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(3);
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeInTheDocument();
  });

  it('shows an inline error with retry when detail fails', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.includes('/detections/')) throw new Error('boom');
      if (url.includes('/detections?')) return { success: true, data: LIST };
      return { success: true, data: DATA };
    });
    const user = userEvent.setup();
    renderWithProviders(<IdentityThreatsPage />);
    await user.click(await screen.findByRole('button', { name: /acme-login\.okta-evil\.com/ }));
    expect(await screen.findByText("Couldn't load detection")).toBeInTheDocument();
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
