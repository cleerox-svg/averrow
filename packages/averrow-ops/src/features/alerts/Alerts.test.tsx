// Alerts workspace: URL-backed filters + deep-linked alert, and the read-only
// contract for staff roles without edit_alerts (sales, billing, auditor).
// The network edge (`api`) and `useAuth` are mocked; everything else is real.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { stubMatchMedia } from '@/test/shared-ui/helpers';

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Alerts } from './Alerts';
import type { Alert } from '@/hooks/useAlerts';

const get = api.get as unknown as ReturnType<typeof vi.fn>;
const patch = api.patch as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;
const auth = useAuth as unknown as ReturnType<typeof vi.fn>;

function alert(id: string, over: Partial<Alert> = {}): Alert {
  return {
    id, brand_id: 'b1', user_id: 'u9', alert_type: 'social_impersonation', severity: 'high',
    title: `Impersonation @fake_${id} on TikTok`, summary: 'Score 80%', details: null,
    source_type: null, source_id: null, ai_assessment: null, ai_recommendations: null,
    status: 'new', acknowledged_at: null, resolved_at: null, resolution_notes: null,
    email_sent: 0, webhook_sent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    brand_name: 'Acme', brand_domain: 'acme.com',
    saas_technique_id: null, saas_technique_name: null, saas_technique_phase: null,
    saas_technique_phase_label: null, saas_technique_severity: null,
    assigned_to: null, assigned_at: null, assigned_to_name: null, assigned_to_email: null,
    ...over,
  };
}

interface Opts {
  list?: Alert[];
  byId?: Record<string, Alert | 'fail'>;
}

function setup(role: string, url: string, opts: Opts = {}) {
  const list = opts.list ?? [];
  get.mockImplementation(async (u: string) => {
    if (u.startsWith('/api/alerts/stats')) return { success: true, data: { total: list.length, new_count: list.length, by_brand: [] } };
    if (u.startsWith('/api/alerts?')) return { success: true, data: list, total: list.length };
    const m = u.match(/^\/api\/alerts\/([^/?]+)$/);
    if (m) {
      const hit = opts.byId?.[m[1]!];
      if (!hit || hit === 'fail') return { success: false, error: 'Alert not found' };
      return { success: true, data: hit };
    }
    return { success: true };
  });
  patch.mockResolvedValue({ success: true });
  post.mockResolvedValue({ success: true });
  auth.mockReturnValue({ user: { id: 'u1', name: 'Ada', email: 'ada@averrow.com', role }, isSuperAdmin: role === 'super_admin' });
  window.history.pushState({}, '', url);
  renderWithProviders(<Alerts />);
}

const listCalls = () => get.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/api/alerts?'));
const detailCalls = (id: string) => get.mock.calls.map(([u]) => String(u)).filter((u) => u === `/api/alerts/${id}`);
const search = () => new URLSearchParams(window.location.search);

describe('Alerts URL state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia(true);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('initialises the list filters from status / severity / alert_type', async () => {
    setup('analyst', '/console?tab=alerts&status=new&severity=critical&alert_type=phishing_detected');
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    const q = new URLSearchParams(listCalls()[0]!.split('?')[1]);
    expect(q.get('status')).toBe('new');
    expect(q.get('severity')).toBe('critical');
    expect(q.get('alert_type')).toBe('phishing_detected');
    // No request ever went out unfiltered.
    expect(listCalls().every((u) => u.includes('status=new'))).toBe(true);
  });

  it('ignores unknown filter values instead of querying with them', async () => {
    setup('analyst', '/console?tab=alerts&status=bogus&severity=nope');
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls()[0]).not.toContain('bogus');
    expect(listCalls()[0]).not.toContain('nope');
  });

  it('writes filter changes back to the URL (replace), keeps other params and drops alert', async () => {
    setup('analyst', '/console?tab=alerts&alert=a1', { list: [alert('a1')] });
    await screen.findByTestId('alert-detail');
    const entries = window.history.length;
    await userEvent.click(await screen.findByRole('button', { name: 'Ack' }));
    await waitFor(() => expect(search().get('status')).toBe('acknowledged'));
    expect(window.history.length).toBe(entries); // replace, not push
    expect(search().get('tab')).toBe('alerts');
    expect(search().has('alert')).toBe(false);
  });

  it('clearing a filter removes its param', async () => {
    setup('analyst', '/console?tab=alerts&status=new&severity=high');
    await userEvent.click(await screen.findByRole('button', { name: 'Critical' }));
    await waitFor(() => expect(search().get('severity')).toBe('critical'));
    expect(search().get('status')).toBe('new');
  });

  it('alert=<id> opens that alert from the loaded list without a detail fetch, scrolls it, and closing removes the param', async () => {
    setup('analyst', '/console?tab=alerts&status=new&alert=a2', { list: [alert('a1'), alert('a2')] });
    const detail = await screen.findByTestId('alert-detail');
    expect(detail).toHaveTextContent('@fake_a2');
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    expect(detailCalls('a2')).toEqual([]);

    await userEvent.click(detail.querySelector('button')!); // header close button
    await waitFor(() => expect(search().has('alert')).toBe(false));
    expect(search().get('tab')).toBe('alerts');
    expect(search().get('status')).toBe('new');
    expect(screen.queryByTestId('alert-detail')).not.toBeInTheDocument();
  });

  it('alert=<id> not in the list is fetched by id and shown', async () => {
    setup('analyst', '/console?tab=alerts&status=new&alert=zz', {
      list: [alert('a1')],
      byId: { zz: alert('zz', { title: 'Phishing @zz_remote on TikTok' }) },
    });
    const detail = await screen.findByTestId('alert-detail');
    expect(detail).toHaveTextContent('@zz_remote');
    expect(detailCalls('zz')).toHaveLength(1);
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it('an alert that cannot be fetched shows an error with retry, not an empty detail', async () => {
    setup('analyst', '/console?tab=alerts&alert=gone', { list: [alert('a1')], byId: { gone: 'fail' } });
    expect(await screen.findByText("Couldn't open that alert")).toBeInTheDocument();
    expect(screen.queryByTestId('alert-detail')).not.toBeInTheDocument();
    const before = detailCalls('gone').length;
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(detailCalls('gone').length).toBeGreaterThan(before));
  });

  it('clicking a row writes alert=<id>; clicking it again removes it', async () => {
    setup('analyst', '/console?tab=alerts', { list: [alert('a1')] });
    await userEvent.click(await screen.findByText('@fake_a1'));
    await waitFor(() => expect(search().get('alert')).toBe('a1'));
    expect(await screen.findByTestId('alert-detail')).toBeInTheDocument();
    await userEvent.click(screen.getAllByText('@fake_a1')[0]!);
    await waitFor(() => expect(search().has('alert')).toBe(false));
  });
});

describe('Alerts permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia(true);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it.each(['sales', 'billing', 'auditor'])('%s sees alerts read-only: no action controls, no mutations', async (role) => {
    setup(role, '/console?tab=alerts&alert=a1', { list: [alert('a1'), alert('a2')] });
    const detail = await screen.findByTestId('alert-detail');
    expect(detail).toHaveTextContent('@fake_a1');

    for (const name of [/^acknowledge$/i, /^dismiss$/i, /assign to me/i, /take over/i, /acknowledge all/i, /create takedowns/i, /save notes/i]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getAllByText(/Read-only/).length).toBeGreaterThan(0);
    const notes = screen.getByPlaceholderText('No notes');
    expect(notes).toHaveAttribute('readonly');
    expect(notes).toHaveAttribute('aria-describedby', 'alert-readonly-a1');
    expect(document.getElementById('alert-readonly-a1')).toHaveTextContent(/can't acknowledge/);

    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it.each(['super_admin', 'admin', 'analyst', 'support'])('%s can act: acknowledge sends the mutation', async (role) => {
    setup(role, '/console?tab=alerts&alert=a1', { list: [alert('a1')] });
    await screen.findByTestId('alert-detail');
    expect(screen.queryByText(/^Read-only/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /acknowledge all/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^acknowledge$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/alerts/a1', { status: 'acknowledged', notes: undefined }));
  });
});
