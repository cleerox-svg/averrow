import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { stubMatchMedia } from '@/test/shared-ui/helpers';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), getBlob: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { DetectionsSection } from './DetectionsSection';
import { CAPTURE_POLL_MS } from './useIdentityThreats';
import type { IdentityDetectionDetail, IdentityDetectionList, PageCapture } from './types';

const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;
const getBlob = api.getBlob as unknown as ReturnType<typeof vi.fn>;
const auth = useAuth as unknown as ReturnType<typeof vi.fn>;

const ITEM = {
  threat_id: 't1', domain: 'acme-login.okta-evil.com', url: 'https://acme-login.okta-evil.com/signin',
  brand_id: 'b1', brand_name: 'Acme Bank', idp: 'okta', idp_label: 'Okta',
  vector: 'idp_lookalike' as const, vector_label: 'Lookalike sign-in domain',
  status: 'active', severity: 'high', source_feed: 'openphish', created_at: '2026-10-09T10:00:00Z',
};
const LIST: IdentityDetectionList = { items: [ITEM], next_cursor: null, total: 1 };

function cap(over: Partial<PageCapture> = {}): PageCapture {
  return {
    id: 'c1', status: 'captured', queued_at: '2026-10-10T10:00:00Z', captured_at: '2026-10-10T10:05:00Z',
    expires_at: '2027-04-08T10:05:00Z', final_url: 'https://acme-login.okta-evil.com/signin', http_status: 200,
    page_title: 'Sign in', redirect_chain: [], form_action_hosts: ['acme-login.okta-evil.com'],
    anti_bot_wall: null, error: null,
    screenshot_desktop_url: '/api/intel/captures/c1/screenshot?variant=desktop',
    screenshot_mobile_url: '/api/intel/captures/c1/screenshot?variant=mobile',
    html_download_url: '/api/intel/captures/c1/html',
    sha256: { desktop: null, mobile: null, html: 'abc123deadbeef' },
    ...over,
  };
}

function detail(captures: PageCapture[]): IdentityDetectionDetail {
  return {
    ...ITEM, technique: 'idp_lookalike', matched_lure: null, ttps: [],
    infrastructure: { ip_address: null, country_code: null, asn: null, hosting_provider: null, ssl_cert_issuer: null },
    registration: { domain_created_at: null, domain_age_days: null, weaponization_hours: null, weaponization_flag: null },
    reputation: {
      vt_checked: false, vt_malicious: null, gsb_checked: false, gsb_flagged: null, gsb_threat_type: null,
      greynoise_checked: false, greynoise_classification: null, seclookup_checked: false, seclookup_risk_score: null,
      surbl_listed: null, dbl_listed: null,
    },
    timeline: { first_seen: null, last_seen: null, created_at: ITEM.created_at, enriched_at: null },
    takedown: null, cluster: null, captures,
  };
}

let current: IdentityDetectionDetail;
const detailCalls = () => get.mock.calls.filter((c) => /detections\/t1$/.test(c[0] as string)).length;

async function open(captures: PageCapture[], role = 'analyst') {
  current = detail(captures);
  auth.mockReturnValue({ user: { role } });
  renderWithProviders(
    <DetectionsSection window="7d" filters={{}} filterLabels={[]} onClearFilters={() => undefined} />,
  );
  await userEvent.click(await screen.findByRole('button', { name: /acme-login\.okta-evil\.com/ }));
  await screen.findByRole('region', { name: 'Page capture' });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia(true);
  get.mockImplementation(async (url: string) => (
    /detections\/t1$/.test(url) ? { success: true, data: current } : { success: true, data: LIST }
  ));
  getBlob.mockResolvedValue(new Blob(['x']));
  let n = 0;
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:test/${++n}`),
    revokeObjectURL: vi.fn(),
  }));
});
afterEach(() => { vi.useRealTimers(); });

const createObjectURL = () => URL.createObjectURL as unknown as ReturnType<typeof vi.fn>;
const revokeObjectURL = () => URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>;

describe('Page capture group', () => {
  it('renders none state with Capture now', async () => {
    await open([]);
    expect(screen.getByText('No capture yet. Capture the page to preserve evidence.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Capture now' })).toBeEnabled();
  });

  it('renders captured state details, via authenticated blob', async () => {
    await open([cap()]);
    expect(screen.getByText('Captured')).toBeInTheDocument();
    expect(screen.getByText('Sign in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download HTML/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy HTML SHA-256' })).toBeInTheDocument();
    const img = await screen.findByAltText('Mobile screenshot of the captured page');
    expect(img).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(getBlob).toHaveBeenCalledWith('/api/intel/captures/c1/screenshot?variant=mobile');
    // No anchor ever points at the evidence URL.
    expect(document.querySelector('a[href*="/captures/"]')).toBeNull();
  });

  it('renders queued, blocked, failed, expired states', async () => {
    await open([cap({ status: 'queued', captured_at: null })]);
    expect(screen.getByText(/Queued — capture starts shortly/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Capture now|Retry capture/ })).toBeNull();
  });

  it('blocked shows anti-bot message and screenshot', async () => {
    await open([cap({ status: 'blocked', anti_bot_wall: 'cloudflare' })]);
    expect(screen.getByText(/Page hid behind an anti-bot check \(cloudflare\)/)).toBeInTheDocument();
    expect(await screen.findByAltText('Mobile screenshot of the captured page')).toBeInTheDocument();
  });

  it('failed shows error and Retry capture', async () => {
    await open([cap({ status: 'failed', error: 'navigation timeout', screenshot_mobile_url: null, screenshot_desktop_url: null })]);
    expect(screen.getByText('Capture failed: navigation timeout')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry capture' })).toBeInTheDocument();
  });

  it('expired shows expiry note and Capture now', async () => {
    await open([cap({ status: 'expired', screenshot_mobile_url: null, screenshot_desktop_url: null, html_download_url: null })]);
    expect(screen.getByText(/Capture expired/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Capture now' })).toBeInTheDocument();
  });

  it('warns on off-domain form hosts only', async () => {
    await open([cap({ form_action_hosts: ['acme-login.okta-evil.com', 'collector.evil.ru'] })]);
    const off = document.querySelector('[data-offdomain]');
    expect(off).toHaveTextContent('collector.evil.ru');
    expect(screen.getByRole('note')).toHaveTextContent('Credentials would be sent to a different site than this page.');
    expect(screen.getByRole('note')).toHaveTextContent('collector.evil.ru');
    expect(document.querySelectorAll('[data-offdomain]')).toHaveLength(1);
  });

  it('collapses redirect chains longer than 2', async () => {
    await open([cap({ redirect_chain: ['https://a.test/', 'https://b.test/', 'https://c.test/'] })]);
    expect(screen.queryByText('https://b.test/')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Show 3 redirects/ }));
    expect(screen.getByText('https://b.test/')).toBeInTheDocument();
  });

  it('opens an accessible viewer with desktop/mobile toggle, closes on Escape, revokes URLs', async () => {
    await open([cap()]);
    await userEvent.click(await screen.findByRole('button', { name: /full screen/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('tab', { name: 'Desktop' }));
    await waitFor(() => expect(getBlob).toHaveBeenCalledWith('/api/intel/captures/c1/screenshot?variant=desktop'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(revokeObjectURL()).toHaveBeenCalled();
  });

  it('revokes blob URLs on unmount', async () => {
    await open([cap()]);
    await screen.findByAltText('Mobile screenshot of the captured page');
    const made = createObjectURL().mock.results.map((r) => r.value);
    // Closing the detection panel unmounts the group.
    await userEvent.click(screen.getByRole('button', { name: /acme-login\.okta-evil\.com/ }));
    await waitFor(() => expect(revokeObjectURL()).toHaveBeenCalledWith(made[0]));
  });

  it('downloads HTML through a blob anchor', async () => {
    await open([cap()]);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await userEvent.click(screen.getByRole('button', { name: /Download HTML/ }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(getBlob).toHaveBeenCalledWith('/api/intel/captures/c1/html');
    click.mockRestore();
  });
});

describe('image load error', () => {
  it('shows Retry and reloads', async () => {
    getBlob.mockRejectedValueOnce(new Error('x'));
    await open([cap()]);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByAltText('Mobile screenshot of the captured page')).toBeInTheDocument();
  });
});

describe('capture-now mutation', () => {
  it('posts, shows queued optimistically', async () => {
    post.mockImplementation(async () => {
      current = detail([cap({ id: 'c2', status: 'queued', captured_at: null })]);
      return { success: true, data: { id: 'c2', status: 'queued' } };
    });
    await open([]);
    await userEvent.click(screen.getByRole('button', { name: 'Capture now' }));
    expect(post).toHaveBeenCalledWith('/api/intel/identity-threats/detections/t1/capture');
    expect(await screen.findByText(/Queued — capture starts shortly/)).toBeInTheDocument();
  });

  it('shows the 409 message', async () => {
    post.mockResolvedValue({ success: false, status: 409, error: 'conflict' });
    await open([cap({ status: 'failed', error: 'boom', screenshot_mobile_url: null, screenshot_desktop_url: null })]);
    await userEvent.click(screen.getByRole('button', { name: 'Retry capture' }));
    expect(await screen.findByText('A capture is already in progress')).toBeInTheDocument();
  });

  it('disables the button with a reason without edit_alerts', async () => {
    await open([], 'sales');
    const btn = screen.getByRole('button', { name: 'Capture now' });
    expect(btn).toBeDisabled();
    expect(screen.getByText("Your role can't queue captures. Ask an analyst or admin.")).toBeInTheDocument();
    await userEvent.click(btn);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('polling', () => {
  it('polls every 20s only while a capture is pending, then stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open([cap({ status: 'capturing', captured_at: null })]);
    const base = detailCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS + 100); });
    expect(detailCalls()).toBeGreaterThan(base);
    current = detail([cap()]);
    await act(async () => { await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS + 100); });
    await screen.findByText('Captured');
    const settled = detailCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS * 3); });
    expect(detailCalls()).toBe(settled);
  });

  it('does not poll when nothing is pending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open([cap()]);
    const base = detailCalls();
    await act(async () => { await vi.advanceTimersByTimeAsync(CAPTURE_POLL_MS * 3); });
    expect(detailCalls()).toBe(base);
  });
});
