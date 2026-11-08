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

  it('row: title, then meta wrapper holding badges and time; platform is plain label text', async () => {
    const { container } = setup('analyst', '/console?tab=alerts', [alert('a1', { saas_technique_name: 'Token theft', saas_technique_phase_label: 'Access' })]);
    const row = await screen.findByRole('button', { name: /@fake_a1/ });
    // Handle and the platform label are separated (spacing utilities survive the label reset).
    const label = within(row).getByText('· TikTok');
    expect(label).toHaveClass('al-label', 'ml-1.5');
    expect(label).not.toHaveClass('al-chip');
    expect(row.textContent).toMatch(/@fake_a1\s+· TikTok/);
    expect(within(row).getByText(/Token theft · Access/)).toHaveClass('mt-0.5');
    const dataRow = row.closest('.al-row') as HTMLElement;
    const meta = dataRow.querySelector('.al-row-meta') as HTMLElement;
    expect(meta).not.toBeNull();
    expect(meta.contains(row)).toBe(false);
    expect(meta.querySelector('.al-slot--sev')).not.toBeNull();
    expect(meta.querySelector('.al-slot--status')).not.toBeNull();
    expect(meta.querySelector('.al-time')).not.toBeNull();
    expect(container.querySelector('.al-row-title')).toBe(row);
    // Slots come first so they start at the same x on every row; time is last.
    expect(meta.firstElementChild).toHaveClass('al-slot--sev');
    expect(meta.children[1]).toHaveClass('al-slot--status');
    expect(meta.lastElementChild).toHaveClass('al-time');
  });

  it('stylesheet: meta group has a fixed, left-aligned basis so slots align across rows', () => {
    const css = read('alerts.css');
    const m = css.match(/\.alerts-v4 \.al-row-meta \{([^}]*)\}/);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/flex:\s*0 0 min\(36rem, calc\(100% - 8rem - 20px\)\)/);
    expect(css).toMatch(/\.al-row-title \{ flex: 1 1 0; min-width: 8rem; \}/);
    expect(body).toMatch(/justify-content:\s*flex-start/);
    expect(body).not.toMatch(/flex-shrink:\s*0/);
    expect(css).toMatch(/\.al-row-meta \.al-time \{ margin-left: auto; \}/);
  });

  it('group count badge is a neutral chip, not a severity badge', async () => {
    const { container } = setup('analyst', '/console?tab=alerts', [alert('a1'), alert('a2')]);
    await screen.findByText('2 alerts');
    const head = container.querySelector('.al-group-head') as HTMLElement;
    const count = within(head).getByText('2 alerts');
    expect(count).toHaveClass('al-chip');
    expect(count).not.toHaveAttribute('data-tone');
    expect(head.querySelector('.ds-badge')).toBeNull();
  });

  it('stylesheet: narrow-container wrap, title floor, label margin scoped, selected row survives hover', () => {
    const css = read('alerts.css');
    // 390px layout: row wraps, title takes the full first line, meta wraps under it.
    const narrow = css.match(/@container alerts \(max-width: 639px\) \{([\s\S]*?)\n\}/);
    expect(narrow).not.toBeNull();
    expect(narrow![1]).toMatch(/\.al-row \{[^}]*flex-wrap: wrap/);
    expect(narrow![1]).toMatch(/\.al-row-title \{[^}]*flex: 1 1 calc\(100% - 20px\)/);
    expect(narrow![1]).toMatch(/\.al-row-meta \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.al-row-title \{[^}]*min-width: 8rem/);
    expect(css).toMatch(/container: alerts \/ inline-size/);
    // The label's margin reset must not beat Tailwind utilities on span/div labels.
    expect(css).not.toMatch(/(?<!p)\.al-label\s*\{[^}]*margin/);
    expect(css).toMatch(/p\.al-label \{ margin: 0; \}/);
    // Hover never repaints the selected row.
    for (const m of css.match(/[^{}]*\.data-row[^{}]*:hover[^{}]*\{/g) ?? []) expect(m).toContain(':not(.al-row--selected)');
  });

  it('renders no looping ping/pulse animation on the Alerts tab', async () => {
    const { container } = setup('analyst', '/console?tab=alerts&alert=a1', [alert('a1', { severity: 'critical' }), alert('a2', { severity: 'high' })]);
    await screen.findByTestId('alert-detail');
    expect(container.querySelector('[style*="live-ping"], [style*="chip-ping"], .animate-ping, .animate-pulse')).toBeNull();
    expect(read('AlertQueueBanner.tsx')).not.toMatch(/\bpulse\b/);
    expect(read('alerts.css')).toMatch(/\.al-brand-link \{ min-height: 44px; \}/);
  });
});
