// Phase 6 screen 3a: the Alerts tab follows the facelift conventions
// (sentence-case sans labels, token colours, kit buttons / pills) without
// changing behaviour or RBAC gating.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen, within } from '@testing-library/react';
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
const auth = useAuth as unknown as ReturnType<typeof vi.fn>;

function alert(id: string, over: Partial<Alert> = {}): Alert {
  return {
    id, brand_id: 'b1', user_id: 'u9', alert_type: 'social_impersonation', severity: 'high',
    title: `Impersonation @fake_${id} on TikTok`, summary: 'Score 80%', details: null,
    source_type: null, source_id: null, ai_assessment: '[AI active_threat @92%] Looks hostile', ai_recommendations: null,
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

function setup(role: string, url: string, list: Alert[]) {
  get.mockImplementation(async (u: string) => {
    if (u.startsWith('/api/alerts/stats')) return { success: true, data: { total: list.length, new_count: list.length } };
    if (u.startsWith('/api/alerts?')) return { success: true, data: list, total: list.length };
    return { success: true };
  });
  auth.mockReturnValue({ user: { id: 'u1', name: 'Ada', email: 'ada@averrow.com', role }, isSuperAdmin: role === 'super_admin' });
  window.history.pushState({}, '', url);
  return renderWithProviders(<Alerts />);
}

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('Alerts facelift', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia(true);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('labels are sentence case, not authored caps', async () => {
    setup('analyst', '/console?tab=alerts&alert=a1', [alert('a1')]);
    const detail = await screen.findByTestId('alert-detail');
    for (const t of ['Alert details', 'Evidence & assessment', 'AI assessment', 'Averrow owner', 'Handle detected']) {
      expect(within(detail).getByText(t)).toBeInTheDocument();
    }
    expect(within(detail).getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create takedowns' })).toBeInTheDocument();
    // The authored markup carries no mono/uppercase utility classes any more.
    expect(read('Alerts.tsx')).not.toMatch(/font-mono|\buppercase\b|tracking-(?:wide|widest)/);
  });

  it('filter pills expose aria-pressed and the AI verdict chip uses a token tone', async () => {
    setup('analyst', '/console?tab=alerts&status=new', [alert('a1')]);
    const ack = await screen.findByRole('button', { name: 'Ack' });
    expect(ack).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'New' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(ack);
    expect(screen.getByRole('button', { name: 'Ack' })).toHaveAttribute('aria-pressed', 'true');
    const chip = await screen.findByText('AI: Threat', { selector: '.al-chip' });
    expect(chip).toHaveAttribute('data-tone', 'critical');
  });

  it.each(['sales', 'billing', 'auditor'])('%s gets no bulk or action controls (read-only)', async (role) => {
    setup(role, '/console?tab=alerts&alert=a1', [alert('a1')]);
    await screen.findByTestId('alert-detail');
    for (const name of [/acknowledge all/i, /create takedowns/i, /^acknowledge$/i, /^dismiss$/i, /assign to me/i]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('note', { name: /can't acknowledge/ })).toHaveTextContent('Read-only');
  });

  it('no colour literals in the Alerts sources, banner or stylesheet', () => {
    for (const f of ['Alerts.tsx', 'AlertQueueBanner.tsx', 'alerts.css', '../console/console.css', '../console/Console.tsx']) {
      const src = read(f);
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, f).not.toMatch(/rgba?\(/);
      expect(src, f).not.toMatch(/(?:bg|border|text)-white\b|white\/\[?\d/);
      expect(src, f).not.toMatch(/textShadow|text-shadow/);
    }
  });
});
