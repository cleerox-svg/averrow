// Alerts workspace: URL-backed filters + deep-linked alert, and the read-only
// contract for staff roles without edit_alerts (sales, billing, auditor).
// The network edge (`api`) and `useAuth` are mocked; everything else is real.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
    staff_assigned_to: null, staff_assigned_at: null, staff_assigned_to_name: null, staff_assigned_to_email: null, staff_notes: null,
    ...over,
  };
}

interface Opts {
  list?: Alert[];
  byId?: Record<string, Alert | 'fail'>;
  /** by-id requests for this id never settle (loading state). */
  hang?: string;
  stats?: Record<string, number>;
}

function setup(role: string, url: string, opts: Opts = {}) {
  const list = opts.list ?? [];
  get.mockImplementation(async (u: string) => {
    if (u.startsWith('/api/alerts/stats')) return { success: true, data: opts.stats ?? { total: list.length, new_count: list.length } };
    if (u.startsWith('/api/alerts?')) return { success: true, data: list, total: list.length };
    const m = u.match(/^\/api\/alerts\/([^/?]+)$/);
    if (m) {
      if (m[1] === opts.hang) return new Promise(() => {});
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

const INTERNAL_NOTES = 'Internal notes — not visible to customers';
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

describe('Alerts deep-link focus + states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia(true);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('a deep link scrolls (instantly under reduced motion), focuses the detail region and announces it', async () => {
    setup('analyst', '/console?tab=alerts&alert=a2', { list: [alert('a1'), alert('a2')] });
    const detail = await screen.findByTestId('alert-detail');
    expect(detail).toHaveAttribute('role', 'region');
    expect(detail).toHaveAccessibleName('Alert: Impersonation @fake_a2 on TikTok');
    expect(detail).toHaveAttribute('id', 'alert-detail-a2');
    await waitFor(() => expect(detail).toHaveFocus());
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    expect(await screen.findByText('Alert opened')).toBeInTheDocument();
  });

  it('smooth-scrolls when reduced motion is not requested', async () => {
    stubMatchMedia(false);
    setup('analyst', '/console?tab=alerts&alert=a1', { list: [alert('a1')] });
    await screen.findByTestId('alert-detail');
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' }));
  });

  it('opening from the list does not move focus into the detail, scroll, or announce', async () => {
    setup('analyst', '/console?tab=alerts', { list: [alert('a1')] });
    const rowBtn = await screen.findByRole('button', { name: /@fake_a1/ });
    expect(rowBtn).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(rowBtn);
    const detail = await screen.findByTestId('alert-detail');
    expect(detail).not.toHaveFocus();
    expect(rowBtn).toHaveFocus();
    expect(rowBtn).toHaveAttribute('aria-expanded', 'true');
    expect(rowBtn).toHaveAttribute('aria-controls', 'alert-detail-a1');
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(screen.queryByText('Alert opened')).not.toBeInTheDocument();
  });

  it('a row opens from the keyboard via its button and closing returns focus to it', async () => {
    const user = userEvent.setup();
    setup('analyst', '/console?tab=alerts', { list: [alert('a1')] });
    const rowBtn = await screen.findByRole('button', { name: /@fake_a1/ });
    rowBtn.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('alert-detail')).toBeInTheDocument();
    expect(search().get('alert')).toBe('a1');
    await user.click(screen.getByRole('button', { name: 'Close alert detail' }));
    await waitFor(() => expect(screen.queryByTestId('alert-detail')).not.toBeInTheDocument());
    expect(rowBtn).toHaveFocus();
    await user.keyboard(' ');
    expect(await screen.findByTestId('alert-detail')).toBeInTheDocument();
  });

  it('closing a deep-linked alert that is not in the list returns focus to the page heading', async () => {
    setup('analyst', '/console?tab=alerts&alert=zz', {
      list: [alert('a1')],
      byId: { zz: alert('zz', { title: 'Phishing @zz_remote on TikTok' }) },
    });
    await screen.findByTestId('alert-detail');
    await userEvent.click(screen.getByRole('button', { name: 'Close alert detail' }));
    await waitFor(() => expect(search().has('alert')).toBe(false));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Alerts' }).closest('[tabindex="-1"]'));
  });

  it('shows an inline loading state while the by-id fetch is pending', async () => {
    setup('analyst', '/console?tab=alerts&alert=slow', { list: [alert('a1')], hang: 'slow' });
    expect(await screen.findByText('Opening alert…')).toBeInTheDocument();
    expect(screen.getByText('Opening alert…').closest('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByTestId('alert-detail')).not.toBeInTheDocument();
  });

  it('a failed by-id open announces, and Clear removes ?alert= while keeping other params', async () => {
    setup('analyst', '/console?tab=alerts&status=new&alert=gone', { list: [alert('a1')], byId: { gone: 'fail' } });
    expect(await screen.findByText("Couldn't open that alert")).toBeInTheDocument();
    expect(await screen.findAllByText("Couldn't open that alert")).toHaveLength(2); // banner + live region
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(search().has('alert')).toBe(false));
    expect(search().get('tab')).toBe('alerts');
    expect(search().get('status')).toBe('new');
    expect(screen.queryByText("Couldn't open that alert")).not.toBeInTheDocument();
  });

  it('read-only with saved notes still shows them (readonly, described by the note)', async () => {
    setup('sales', '/console?tab=alerts&alert=a1', { list: [alert('a1', { staff_notes: 'Handled by SOC' })] });
    const detail = await screen.findByTestId('alert-detail');
    const box = within(detail).getByRole('textbox', { name: INTERNAL_NOTES });
    expect(box).toHaveValue('Handled by SOC');
    expect(box).toHaveAttribute('readonly');
    expect(box).toHaveAttribute('aria-describedby', 'alert-readonly-a1');
    expect(within(detail).queryByText('No notes')).not.toBeInTheDocument();
  });
});

describe('Alerts staff ownership, notes and bulk batching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia(true);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('assign / take over / release send staff_assigned_to and never assigned_to', async () => {
    setup('analyst', '/console?tab=alerts&alert=a1', { list: [alert('a1')] });
    await userEvent.click(await screen.findByRole('button', { name: /assign to me/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/alerts/a1', { staff_assigned_to: 'u1' }));
    expect(await screen.findByText('Averrow owner')).toBeInTheDocument();
    for (const [, body] of patch.mock.calls) expect(body).not.toHaveProperty('assigned_to');
  });

  it('release sends staff_assigned_to: null', async () => {
    setup('analyst', '/console?tab=alerts&alert=a1', { list: [alert('a1', { staff_assigned_to: 'u1', staff_assigned_to_name: 'Ada' })] });
    await userEvent.click(await screen.findByRole('button', { name: /^unassign$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/alerts/a1', { staff_assigned_to: null }));
    for (const [, body] of patch.mock.calls) expect(body).not.toHaveProperty('assigned_to');
  });

  it('take over when another staff member owns it; customer assignee is shown read-only and separately', async () => {
    setup('analyst', '/console?tab=alerts&alert=a1', {
      list: [alert('a1', {
        staff_assigned_to: 'u7', staff_assigned_to_name: 'Grace Hopper',
        assigned_to: 'cust1', assigned_to_name: 'Cora Customer',
      })],
    });
    const detail = await screen.findByTestId('alert-detail');
    expect(within(detail).getByText('Averrow owner').nextElementSibling).toHaveTextContent('Grace Hopper');
    expect(within(detail).getByText('Customer assignee').nextElementSibling).toHaveTextContent('Cora Customer');
    await userEvent.click(within(detail).getByRole('button', { name: /take over/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/alerts/a1', { staff_assigned_to: 'u1' }));
  });

  it('the notes box is labelled internal, edits staff_notes and saves via notes', async () => {
    setup('analyst', '/console?tab=alerts&alert=a1', { list: [alert('a1', { staff_notes: 'old', resolution_notes: 'auto: rule' })] });
    const detail = await screen.findByTestId('alert-detail');
    expect(within(detail).getByText(INTERNAL_NOTES)).toBeInTheDocument();
    const box = within(detail).getByRole('textbox', { name: INTERNAL_NOTES });
    expect(box).toHaveValue('old'); // staff_notes, not resolution_notes
    await userEvent.clear(box);
    await userEvent.type(box, 'new note');
    await userEvent.click(within(detail).getByRole('button', { name: /save notes/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/alerts/a1', { status: 'new', notes: 'new note' }));
  });

  it('Acknowledge All chunks ids to <= 90 per call and shows progress', async () => {
    const list = Array.from({ length: 200 }, (_, i) => alert(`n${i}`));
    setup('analyst', '/console?tab=alerts', { list });
    post.mockImplementation(async (_u: string, body: { alert_ids: string[] }) => ({
      success: true, data: { updated: body.alert_ids.length, alert_ids: body.alert_ids, remaining: 0 },
    }));
    await userEvent.click(await screen.findByRole('button', { name: /acknowledge all/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    const sizes = post.mock.calls.map(([, b]) => (b as { alert_ids: string[] }).alert_ids.length);
    expect(sizes).toEqual([90, 90, 20]);
    expect(post.mock.calls.every(([u]) => u === '/api/alerts/bulk-acknowledge')).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /acknowledge all/i })).toBeEnabled());
    expect(screen.queryByText('Action failed')).not.toBeInTheDocument();
  });

  it('Create Takedowns sends brand_id and loops until remaining is 0, showing N of M', async () => {
    setup('analyst', '/console?tab=alerts', { list: [alert('a1')] });
    const remaining = [180, 90, 0];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    post.mockImplementation(async (u: string) => {
      if (post.mock.calls.length === 2) await gate; // hold the 2nd batch to observe progress
      return { success: true, data: { takedowns_created: 90, alerts_acknowledged: 90, alert_ids: new Array(90).fill('x'), remaining: remaining.shift() } };
    });
    await userEvent.click(await screen.findByRole('button', { name: /create takedowns/i }));
    expect(await screen.findByRole('button', { name: /Creating 90 of 270…/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /acknowledge all/i })).toBeDisabled();
    release();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post.mock.calls.every(([u, b]) => u === '/api/alerts/bulk-takedown' && (b as { brand_id: string }).brand_id === 'b1')).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /create takedowns/i })).toBeEnabled());
  });

  it('a takedown loop stops at the batch cap and reports what is still pending', async () => {
    setup('analyst', '/console?tab=alerts', { list: [alert('a1')] });
    post.mockResolvedValue({ success: true, data: { takedowns_created: 90, alerts_acknowledged: 90, alert_ids: new Array(90).fill('x'), remaining: 5000 } });
    await userEvent.click(await screen.findByRole('button', { name: /create takedowns/i }));
    expect(await screen.findByText(/stopped after 20 batches; 5000 still pending/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(20);
  });

  it('a bulk batch that fails mid-loop surfaces the error and stops', async () => {
    setup('analyst', '/console?tab=alerts', { list: [alert('a1')] });
    post
      .mockResolvedValueOnce({ success: true, data: { takedowns_created: 90, alerts_acknowledged: 90, alert_ids: new Array(90).fill('x'), remaining: 90 } })
      .mockResolvedValueOnce({ success: false, error: 'quota exceeded' });
    await userEvent.click(await screen.findByRole('button', { name: /create takedowns/i }));
    expect(await screen.findByText(/Couldn't create takedowns: quota exceeded/)).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('renders the auto-triage line from stats (no by_brand needed)', async () => {
    setup('analyst', '/console?tab=alerts', {
      list: [alert('a1')],
      stats: { total: 5, new_count: 1, acknowledged: 0, resolved: 0, dismissed: 4, auto_dismissed: 3, critical: 0, high: 1, medium: 0, low: 0 },
    });
    expect(await screen.findByText(/Auto-triage cleared 3 of 4 dismissed signals \(75%\)/)).toBeInTheDocument();
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
    // No notes + read-only: plain text, not an empty disabled-looking textarea.
    expect(within(detail).getByText('No notes')).toBeInTheDocument();
    expect(within(detail).queryByRole('textbox')).not.toBeInTheDocument();
    expect(detail).toHaveAttribute('aria-describedby', 'alert-readonly-a1');
    expect(document.getElementById('alert-readonly-a1')).toHaveTextContent(/can't acknowledge/);
    // The chip carries its text in the accessible name, not a hover-only title.
    const chip = screen.getByRole('note', { name: /can't acknowledge/ });
    expect(chip).toHaveTextContent('Read-only');
    expect(chip).not.toHaveAttribute('title');
    expect(document.getElementById('alerts-readonly-note')).toHaveTextContent(/can't acknowledge/);

    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('support can triage but does not see Create Takedowns (needs manage_takedowns)', async () => {
    setup('support', '/console?tab=alerts&alert=a1', { list: [alert('a1')] });
    await screen.findByTestId('alert-detail');
    expect(screen.getByRole('button', { name: /acknowledge all/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create takedowns/i })).not.toBeInTheDocument();
  });

  it.each(['super_admin', 'admin', 'analyst'])('%s sees Create Takedowns', async (role) => {
    setup(role, '/console?tab=alerts&alert=a1', { list: [alert('a1')] });
    await screen.findByTestId('alert-detail');
    expect(screen.getByRole('button', { name: /create takedowns/i })).toBeInTheDocument();
  });

  it('a rejected takedown request shows a visible error instead of failing silently', async () => {
    setup('analyst', '/console?tab=alerts', { list: [alert('a1')] });
    post.mockResolvedValue({ success: false, error: 'quota exceeded' });
    await userEvent.click(await screen.findByRole('button', { name: /create takedowns/i }));
    expect(await screen.findByText('Action failed')).toBeInTheDocument();
    expect(screen.getByText(/Couldn't create takedowns: quota exceeded/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Action failed')).not.toBeInTheDocument();
  });

  it('a thrown update error is surfaced and keeps the detail open', async () => {
    setup('analyst', '/console?tab=alerts&alert=a1', { list: [alert('a1')] });
    patch.mockRejectedValue(new Error('network down'));
    await userEvent.click(await screen.findByRole('button', { name: /^acknowledge$/i }));
    expect(await screen.findByText(/Couldn't update the alert: network down/)).toBeInTheDocument();
    expect(screen.getByTestId('alert-detail')).toBeInTheDocument();
  });

  it('assign overlay is cleared once settled so refetched data wins; a failure reverts and reports', async () => {
    setup('analyst', '/console?tab=alerts&alert=a1', { list: [alert('a1')] });
    patch.mockResolvedValue({ success: false, error: 'nope' });
    await userEvent.click(await screen.findByRole('button', { name: /assign to me/i }));
    expect(await screen.findByText(/Couldn't change the owner: nope/)).toBeInTheDocument();
    // Overlay gone: the server state (unassigned) is shown again.
    await waitFor(() => expect(screen.getByRole('button', { name: /assign to me/i })).toBeInTheDocument());
  });

  it('notes typed on one alert do not carry over to the next', async () => {
    setup('analyst', '/console?tab=alerts&alert=a1', { list: [alert('a1'), alert('a2')] });
    const box = await screen.findByRole('textbox', { name: INTERNAL_NOTES });
    await userEvent.type(box, 'draft for a1');
    await userEvent.click(await screen.findByRole('button', { name: /@fake_a2/ }));
    await waitFor(() => expect(search().get('alert')).toBe('a2'));
    await waitFor(() => expect(screen.getByRole('textbox', { name: INTERNAL_NOTES })).toHaveValue(''));
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
