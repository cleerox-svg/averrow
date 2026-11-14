import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
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
  rua_value: 'rua=mailto:dmarc_rua@averrow.ca',
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

function renderCard(brandId = 'b1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui = (id: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DmarcSensorCard brandId={id} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const r = render(ui(brandId));
  return { ...r, switchTo: (id: string) => r.rerender(ui(id)) };
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
    const code = await screen.findByText('rua=mailto:dmarc_rua@averrow.ca');
    expect(code.textContent).not.toMatch(/rua=rua=/);
    fireEvent.click(screen.getByRole('button', { name: 'Copy rua value' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('rua=mailto:dmarc_rua@averrow.ca');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('reports a clipboard failure', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    route(SETUP);
    renderCard();
    await screen.findByText('rua=mailto:dmarc_rua@averrow.ca');
    fireEvent.click(screen.getByRole('button', { name: 'Copy rua value' }));
    expect(await screen.findByText('Copy failed')).toBeInTheDocument();
    expect(screen.getByText(/Select and copy the value manually/)).toBeInTheDocument();
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

  it('does not present a lapsed enrollment as currently verified', async () => {
    route({ ...SETUP, enrolled: false });
    renderCard();
    expect(await screen.findByText('rua= last verified')).toBeInTheDocument();
    expect(screen.getByText(/Verification lapsed \(older than 30 days\)/)).toBeInTheDocument();
    expect(screen.queryByText('Enrolled')).not.toBeInTheDocument();
  });

  it('explains an ineligible brand and hides the rua value and sources', async () => {
    route({ ...SETUP, eligible: false, enrolled: false });
    renderCard();
    expect(await screen.findByText('Cannot enrol')).toBeInTheDocument();
    expect(screen.getByText(/not eligible for the DMARC sensor/)).toBeInTheDocument();
    expect(screen.queryByText(/rua=mailto/)).not.toBeInTheDocument();
    expect(get.mock.calls.some(([u]) => String(u).includes('/spoof-sources'))).toBe(false);
  });

  it('warns staff when the authorisation DNS record is missing (false)', async () => {
    route({ ...SETUP, authorization_record_ok: false });
    renderCard();
    const title = await screen.findByText('Authorisation DNS record missing');
    const box = title.parentElement as HTMLElement;
    expect(box).toHaveTextContent(/may not send/);
    expect(box).toHaveTextContent(/\*\._report\._dmarc\.averrow\.ca/);
    expect(box).toHaveTextContent(/not something the customer publishes/);
    expect(within(box).getByText('acme.com._report._dmarc.averrow.ca')).toBeInTheDocument();
    expect(screen.queryByText(/Could not check the authorisation record/)).not.toBeInTheDocument();
  });

  it('shows only a muted "could not check" note when the lookup failed (null)', async () => {
    route({ ...SETUP, authorization_record_ok: null });
    renderCard();
    expect(await screen.findByText('Could not check the authorisation record just now.')).toBeInTheDocument();
    expect(screen.queryByText('Authorisation DNS record missing')).not.toBeInTheDocument();
  });

  it('shows no authorisation notice when the record exists', async () => {
    route(SETUP);
    renderCard();
    await screen.findByText('Receiving reports');
    expect(screen.queryByText('Authorisation DNS record missing')).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not check the authorisation record/)).not.toBeInTheDocument();
  });

  it('notes a failed live DNS lookup instead of implying no record', async () => {
    route({ ...SETUP, state: 'no_dmarc', last_report_at: null, rua_checked_via: 'live_dns_failed' });
    renderCard();
    expect(await screen.findByText(/live DNS lookup for this domain failed/)).toBeInTheDocument();
  });
});

describe('DmarcSensorCard sources', () => {
  const MIXED = () => sources([
    source(),
    source({ source_ip: '198.51.100.9', source_class: 'unaligned_shared_esp', unverified_only: false, verified_fail_messages: 5, asn_drop_listed: true, provider: null, cluster_id: null }),
    source({ source_ip: '192.0.2.1', source_class: 'forwarder_likely', unverified_only: true }),
    source({ source_ip: '192.0.2.2', source_class: 'aligned_pass', unverified_only: true }),
  ]);

  it('renders class labels, ASN-DROP badge, visible legend with Spamhaus credit and a provider link', async () => {
    route(SETUP, MIXED());
    renderCard();
    expect(await screen.findByText('203.0.113.7')).toBeInTheDocument();
    for (const l of ['Spoofing candidate', 'Shared mail service (unattributed)', 'Likely forwarded or own mail', 'Aligned pass']) {
      expect(screen.getAllByText(l).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('ASN-DROP', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText(/Source: The Spamhaus Project/)).toBeVisible();
    expect(screen.getByText(/shows none of the evidence that the brand's own or shared-service mail leaves behind/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Example Hosting LLC' })[0]).toHaveAttribute('href', '/explore?tab=providers&focus=prov_1');
    expect(screen.queryByText('Cluster')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/attacker|confirmed (attack|spoof)/i);
  });

  it('formats seen dates, not raw ISO', async () => {
    route(SETUP, sources([source()]));
    renderCard();
    expect(await screen.findByText('8 Nov to 13 Nov')).toBeInTheDocument();
  });

  it('all unverified: shows only the banner, no per-row badge', async () => {
    route(SETUP, sources([source(), source({ source_ip: '192.0.2.5' })]));
    renderCard();
    await screen.findByText('203.0.113.7');
    expect(screen.getByText(/None of the reports behind these sources came from a verified reporter/)).toBeInTheDocument();
    expect(screen.queryByText('Verified')).not.toBeInTheDocument();
    expect(screen.queryByText('Unverified only')).not.toBeInTheDocument();
  });

  it('mixed: banner plus a Verified badge only on verified rows', async () => {
    route(SETUP, MIXED());
    renderCard();
    await screen.findByText('203.0.113.7');
    expect(screen.getByText(/3 of 4 sources are unverified/)).toBeInTheDocument();
    const verified = screen.getAllByText('Verified');
    expect(verified).toHaveLength(1);
    expect(verified[0].closest('tr')).toHaveTextContent('198.51.100.9');
  });

  it('all verified: no banner and no badges', async () => {
    route(SETUP, sources([source({ unverified_only: false, verified_fail_messages: 9 })]));
    renderCard();
    await screen.findByText('203.0.113.7');
    expect(screen.queryByText(/verified reporter/)).not.toBeInTheDocument();
  });

  it('puts the most suspicious class first', async () => {
    route(SETUP, sources([
      source({ source_ip: '192.0.2.2', source_class: 'aligned_pass', fail_messages: 999 }),
      source({ source_ip: '203.0.113.7', source_class: 'spoof_candidate', fail_messages: 1 }),
    ]));
    renderCard();
    await screen.findByText('203.0.113.7');
    expect(within(screen.getByRole('region', { name: 'DMARC sending sources' })).getAllByRole('row')[1]).toHaveTextContent('203.0.113.7');
  });

  it('exposes the daily figures in an sr-only table, and draws no bar for a zero-message day', async () => {
    const data = sources([source()]);
    data.daily = [
      { date: '2026-11-11', total: 0, passed: 0, failed: 0 },
      { date: '2026-11-12', total: 80, passed: 60, failed: 20 },
      { date: '2026-11-13', total: 100, passed: 40, failed: 60 },
    ];
    route(SETUP, data);
    const { container } = renderCard();
    const t = await screen.findByRole('table', { name: 'Daily DMARC results' });
    expect(within(t).getAllByRole('row')).toHaveLength(4);
    expect(container.querySelectorAll('[title^="2026-11-"]')).toHaveLength(2);
  });

  it('renders a stacked list instead of a table on a narrow screen', async () => {
    const orig = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    try {
      route(SETUP, sources([source()]));
      renderCard();
      await screen.findByText('203.0.113.7');
      expect(screen.queryByRole('columnheader', { name: 'IP' })).not.toBeInTheDocument();
      expect(screen.getByRole('list', { name: 'DMARC sending sources' })).toBeInTheDocument();
      expect(screen.getByText('AS64500')).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: orig, configurable: true });
    }
  });

  it.each([
    ['awaiting_reports', /The rua= record is in place\. Sources appear once a mail provider sends its first daily report; each report is processed as soon as it arrives\./],
    ['receiving', /Try the 30 day window/],
    ['stale', /Try the 30 day window/],
  ] as const)('empty state copy for %s', async (state, re) => {
    route({ ...SETUP, state, last_report_at: state === 'awaiting_reports' ? null : SETUP.last_report_at }, sources([]));
    renderCard();
    expect(await screen.findByText('No sending sources in the last 7 days')).toBeInTheDocument();
    expect(screen.getByText(re)).toBeInTheDocument();
    expect(screen.queryByText(/nightly|Nothing is wrong/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['no_dmarc', 'No reports can arrive until the domain publishes a DMARC record with the rua= value above.'],
    ['rua_missing', "No reports can arrive until the rua= value above is added to the domain's DMARC record."],
  ] as const)('%s shows its own empty copy and does not fetch sources', async (state, copy) => {
    route({ ...SETUP, state, last_report_at: null, rua_includes_averrow: false });
    renderCard();
    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(get.mock.calls.some(([u]) => String(u).includes('/spoof-sources'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Last 30 days' })).not.toBeInTheDocument();
  });

  it('refetches with days=30 when the toggle is switched, labelling the window from the data', async () => {
    route(SETUP, sources([source()]));
    renderCard();
    await screen.findByText('203.0.113.7');
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Last 30 days' }));
    await waitFor(() => expect(get.mock.calls.some(([u]) => String(u).endsWith('/spoof-sources?days=30'))).toBe(true));
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
    await screen.findByText(/in the last 30 days\./);
  });

  it('never shows the previous brand\'s sources after switching brand', async () => {
    let releaseB2: (v: unknown) => void = () => {};
    get.mockImplementation((url: string) => {
      if (url.includes('/b1/setup') || url.includes('/b2/setup')) return Promise.resolve({ success: true, data: SETUP });
      if (url.includes('/b1/spoof-sources')) return Promise.resolve({ success: true, data: sources([source({ source_ip: '203.0.113.7' })]) });
      return new Promise((r) => { releaseB2 = r; });
    });
    const { switchTo } = renderCard('b1');
    await screen.findByText('203.0.113.7');
    switchTo('b2');
    await waitFor(() => expect(get.mock.calls.some(([u]) => String(u).includes('/b2/spoof-sources'))).toBe(true));
    expect(screen.queryByText('203.0.113.7')).not.toBeInTheDocument();
    await act(async () => { releaseB2({ success: true, data: sources([source({ source_ip: '192.0.2.99' })]) }); });
    expect(await screen.findByText('192.0.2.99')).toBeInTheDocument();
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
