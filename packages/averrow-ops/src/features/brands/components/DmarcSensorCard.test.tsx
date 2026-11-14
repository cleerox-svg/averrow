import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { api } from '@/lib/api';
import { DmarcSensorCard } from './DmarcSensorCard';
import type { DmarcSetup, DmarcSpoofSource, DmarcSpoofSources } from '@/hooks/useDmarcSensor';

const get = api.get as ReturnType<typeof vi.fn>;

const SETUP: DmarcSetup = {
  brand_id: 'b1',
  domain: 'acme.com',
  state: 'receiving',
  rua_address: 'dmarc_rua@averrow.ca',
  rua_value: 'mailto:dmarc_rua@averrow.ca',
  rua_includes_averrow: true,
  rua_checked_via: 'scan',
  authorization_required: true,
  authorization_record_ok: true,
  authorization_record_name: 'acme.com._report._dmarc.averrow.ca',
  authorization_record_value: 'v=DMARC1;',
  enrolled: true,
  eligible: true,
  verified_via: 'scan',
  verified_at: '2026-11-10 08:00:00',
  reverify_after_days: 30,
  last_report_at: '2026-11-13 04:00:00',
  last_scan_at: '2026-11-13 01:00:00',
};

function source(over: Partial<DmarcSpoofSource> = {}): DmarcSpoofSource {
  return {
    source_ip: '203.0.113.7',
    source_class: 'spoof_candidate',
    source_rules: [],
    messages: 120,
    fail_messages: 100,
    verified_fail_messages: 0,
    unverified_only: true,
    asn: 'AS64500',
    as_org: 'Example Hosting',
    country_code: 'RU',
    provider: { id: 'prov_1', name: 'Example Hosting LLC' },
    cluster_id: 'cluster_abc',
    asn_drop_listed: false,
    first_seen: '2026-11-08',
    last_seen: '2026-11-13',
    days_seen: 3,
    ...over,
  };
}

function sources(list: DmarcSpoofSource[], days: 7 | 30 = 7): DmarcSpoofSources {
  return {
    brand_id: 'b1',
    domain: 'acme.com',
    days,
    since: '2026-11-07',
    sources: list,
    daily: list.length ? [
      { date: '2026-11-12', total: 80, passed: 60, failed: 20 },
      { date: '2026-11-13', total: 100, passed: 40, failed: 60 },
    ] : [],
    summary: {
      sources: list.length,
      spoof_candidate_sources: list.filter((s) => s.source_class === 'spoof_candidate').length,
      unverified_only_sources: list.filter((s) => s.unverified_only).length,
      fail_messages: list.reduce((n, s) => n + s.fail_messages, 0),
      truncated: false,
    },
  };
}

function route(setup: unknown, spoof: unknown | 'reject' = sources([])) {
  get.mockImplementation((url: string) => {
    if (url.includes('/setup')) {
      return setup === 'reject' ? Promise.reject(new Error('boom')) : Promise.resolve({ success: true, data: setup });
    }
    if (url.includes('/spoof-sources')) {
      if (spoof === 'reject') return Promise.reject(new Error('boom'));
      const days = url.includes('days=30') ? 30 : 7;
      return Promise.resolve({ success: true, data: { ...(spoof as DmarcSpoofSources), days } });
    }
    return Promise.resolve({ success: true });
  });
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DmarcSensorCard brandId="b1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DmarcSensorCard setup states', () => {
  const cases: Array<[DmarcSetup['state'], string]> = [
    ['no_dmarc', 'No DMARC record'],
    ['rua_missing', 'Reporting not pointed here'],
    ['awaiting_reports', 'Awaiting first report'],
    ['receiving', 'Receiving reports'],
    ['stale', 'Reports stopped'],
  ];
  it.each(cases)('renders %s as "%s" with an explanation', async (state, label) => {
    route({ ...SETUP, state, last_report_at: state === 'receiving' || state === 'stale' ? SETUP.last_report_at : null });
    renderCard();
    expect(await screen.findByText(label)).toBeInTheDocument();
    const explain = {
      no_dmarc: /publishes no DMARC record/,
      rua_missing: /does not include Averrow/,
      awaiting_reports: /No report has arrived yet/,
      receiving: /last 7 days/,
      stale: /none has in the last 7 days/,
    }[state];
    expect(screen.getByText(explain)).toBeInTheDocument();
  });

  it('shows the exact rua= value and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    route(SETUP);
    renderCard();
    expect(await screen.findByText('rua=mailto:dmarc_rua@averrow.ca')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy rua value' }));
    expect(writeText).toHaveBeenCalledWith('rua=mailto:dmarc_rua@averrow.ca');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('shows last report and verified time when present, "none yet" otherwise', async () => {
    route(SETUP);
    const { unmount } = renderCard();
    expect(await screen.findByText(/2026-11-13 04:00 UTC/)).toBeInTheDocument();
    expect(screen.getByText(/2026-11-10 08:00 UTC/)).toBeInTheDocument();
    unmount();
    route({ ...SETUP, state: 'awaiting_reports', last_report_at: null, verified_at: null, verified_via: null });
    renderCard();
    expect(await screen.findByText('none yet')).toBeInTheDocument();
  });

  it('explains an ineligible brand and hides the rua value and sources', async () => {
    route({ ...SETUP, eligible: false, enrolled: false });
    renderCard();
    expect(await screen.findByText('Cannot enrol')).toBeInTheDocument();
    expect(screen.getByText(/not eligible for the DMARC sensor/)).toBeInTheDocument();
    expect(screen.queryByText(/rua=mailto/)).not.toBeInTheDocument();
    expect(get.mock.calls.some(([u]) => String(u).includes('/spoof-sources'))).toBe(false);
  });

  it('warns staff when the authorisation DNS record is missing', async () => {
    route({ ...SETUP, authorization_record_ok: false });
    renderCard();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Authorisation DNS record missing')).toBeInTheDocument();
    expect(alert).toHaveTextContent(/not something the customer publishes/);
    expect(within(alert).getByText('acme.com._report._dmarc.averrow.ca')).toBeInTheDocument();
  });

  it('shows no authorisation warning when the record exists', async () => {
    route(SETUP);
    renderCard();
    await screen.findByText('Receiving reports');
    expect(screen.queryByText('Authorisation DNS record missing')).not.toBeInTheDocument();
  });

  it('notes a failed live DNS lookup instead of implying no record', async () => {
    route({ ...SETUP, state: 'no_dmarc', last_report_at: null, rua_checked_via: 'live_dns_failed' });
    renderCard();
    expect(await screen.findByText(/live DNS lookup for this domain failed/)).toBeInTheDocument();
  });
});

describe('DmarcSensorCard sources', () => {
  it('renders classes with honest labels, unverified-only marker and ASN-DROP badge', async () => {
    route(SETUP, sources([
      source(),
      source({ source_ip: '198.51.100.9', source_class: 'unaligned_shared_esp', unverified_only: false, verified_fail_messages: 5, asn_drop_listed: true, provider: null, cluster_id: null }),
      source({ source_ip: '192.0.2.1', source_class: 'forwarder_likely', unverified_only: false }),
      source({ source_ip: '192.0.2.2', source_class: 'aligned_pass', unverified_only: false }),
    ]));
    renderCard();
    expect(await screen.findByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('Spoofing candidate')).toBeInTheDocument();
    expect(screen.getByText('Shared mail service (unattributed)')).toBeInTheDocument();
    expect(screen.getByText("Brand's own mail (forwarded / alignment)")).toBeInTheDocument();
    expect(screen.getByText('Aligned pass')).toBeInTheDocument();
    // Only the first source is unverified-only.
    expect(screen.getAllByText('Unverified only')).toHaveLength(1);
    expect(screen.getByText('Unverified only').parentElement).toHaveAttribute('title', expect.stringMatching(/verification is not enabled yet/));
    // ASN-DROP badge carries Spamhaus attribution.
    const drop = screen.getByText('ASN-DROP');
    expect(drop.parentElement).toHaveAttribute('title', expect.stringMatching(/The Spamhaus Project/));
    // Provider links to the providers workspace; nothing is called "attacker" or "confirmed".
    expect(screen.getAllByRole('link', { name: 'Example Hosting LLC' })[0]).toHaveAttribute('href', '/explore?tab=providers&focus=prov_1');
    expect(document.body.textContent).not.toMatch(/attacker|confirmed (attack|spoof)/i);
  });

  it('puts the most suspicious class first', async () => {
    route(SETUP, sources([
      source({ source_ip: '192.0.2.2', source_class: 'aligned_pass', fail_messages: 999 }),
      source({ source_ip: '203.0.113.7', source_class: 'spoof_candidate', fail_messages: 1 }),
    ]));
    renderCard();
    await screen.findByText('203.0.113.7');
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('203.0.113.7');
  });

  it('exposes the daily pass/fail series with an accessible summary', async () => {
    route(SETUP, sources([source()]));
    renderCard();
    expect(await screen.findByRole('img', { name: /2 days: 100 passed, 80 failed/ })).toBeInTheDocument();
  });

  it('shows an informative (non-error) empty state before any reports exist', async () => {
    route({ ...SETUP, state: 'awaiting_reports', last_report_at: null }, sources([]));
    renderCard();
    expect(await screen.findByText('No sending sources in the last 7 days')).toBeInTheDocument();
    expect(screen.getByText(/normal until reports arrive/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refetches with days=30 when the toggle is switched', async () => {
    route(SETUP, sources([source()]));
    renderCard();
    await screen.findByText('203.0.113.7');
    expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    await waitFor(() => expect(get.mock.calls.some(([u]) => String(u).endsWith('/spoof-sources?days=30'))).toBe(true));
    expect(screen.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a card-level error with retry when sources fail, keeping setup visible', async () => {
    route(SETUP, 'reject');
    renderCard();
    expect(await screen.findByText("Couldn't load sending sources")).toBeInTheDocument();
    expect(screen.getByText('Receiving reports')).toBeInTheDocument();
  });
});

describe('DmarcSensorCard loading and error', () => {
  it('shows a loading state while setup is pending', () => {
    get.mockImplementation(() => new Promise(() => {}));
    renderCard();
    expect(screen.getByText('Loading DMARC sensor…', { selector: '.sr-only, *' })).toBeInTheDocument();
  });

  it('shows an error state with retry when setup fails', async () => {
    route('reject');
    renderCard();
    expect(await screen.findByText("Couldn't load the DMARC sensor")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });
});
