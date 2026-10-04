// The real Alerts pane inside the real Console: deep links from Home / bell /
// critical banner land on the right slice, and tab switches still clear the
// pane-specific params.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { stubMatchMedia } from '@/test/shared-ui/helpers';
import { Console } from './Console';
import type { Alert } from '@/hooks/useAlerts';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ isSuperAdmin: false, user: { id: 'u1', role: 'analyst', name: 'Ada', email: 'a@x.io' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('@/features/threats/Threats', () => ({ Threats: () => <div>THREATS PANE</div> }));
vi.mock('@/features/takedowns/Takedowns', () => ({ Takedowns: () => null }));
vi.mock('@/features/admin-incidents/Incidents', () => ({ AdminIncidents: () => null }));

import { api } from '@/lib/api';
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const target = {
  id: 'alr_7', brand_id: 'b1', user_id: 'u9', alert_type: 'social_impersonation', severity: 'critical',
  title: 'Impersonation @deep_link on TikTok', summary: 'Score 90%', details: null, source_type: null, source_id: null,
  ai_assessment: null, ai_recommendations: null, status: 'new', acknowledged_at: null, resolved_at: null,
  resolution_notes: null, email_sent: 0, webhook_sent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  brand_name: 'Acme', brand_domain: 'acme.com', saas_technique_id: null, saas_technique_name: null,
  saas_technique_phase: null, saas_technique_phase_label: null, saas_technique_severity: null,
  assigned_to: null, assigned_at: null, assigned_to_name: null, assigned_to_email: null,
  staff_assigned_to: null, staff_assigned_at: null, staff_assigned_to_name: null, staff_assigned_to_email: null, staff_notes: null,
} satisfies Alert;

describe('Console ?tab=alerts deep links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia(true);
    Element.prototype.scrollIntoView = vi.fn();
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/alerts/triage-summary')) return { success: true, data: { new_count: 1, critical_count: 1, top: null } };
      if (url.startsWith('/api/alerts/stats')) return { success: true, data: { total: 0, new_count: 0 } };
      if (url === '/api/alerts/alr_7') return { success: true, data: target };
      if (url.startsWith('/api/alerts?')) return { success: true, data: [], total: 0 };
      return { success: true, data: [] };
    });
  });

  it('?tab=alerts&status=new&alert=X applies the filter, opens the alert and keeps the URL intact', async () => {
    window.history.pushState({}, '', '/?tab=alerts&status=new&alert=alr_7');
    renderWithProviders(<Console />);
    expect(await screen.findByTestId('alert-detail')).toHaveTextContent('@deep_link');
    expect(get.mock.calls.some(([u]) => String(u).startsWith('/api/alerts?') && String(u).includes('status=new'))).toBe(true);
    expect(window.location.search).toBe('?tab=alerts&status=new&alert=alr_7');
  });

  it('?tab=alerts&severity=critical&status=new (banner link) filters the list', async () => {
    window.history.pushState({}, '', '/?tab=alerts&severity=critical&status=new');
    renderWithProviders(<Console />);
    await waitFor(() => expect(get.mock.calls.some(([u]) => String(u).includes('severity=critical') && String(u).includes('status=new'))).toBe(true));
  });

  it('switching tab clears the alert params (only tab carries over)', async () => {
    window.history.pushState({}, '', '/?tab=alerts&status=new&alert=alr_7');
    renderWithProviders(<Console />);
    await screen.findByTestId('alert-detail');
    await userEvent.click(screen.getByRole('button', { name: /Threats/ }));
    await waitFor(() => expect(window.location.search).toBe('?tab=threats'));
    expect(await screen.findByText('THREATS PANE')).toBeInTheDocument();
  });
});
