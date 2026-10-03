// /api/admin/incidents is super_admin-only. Other roles must not request it,
// and the Console degrades: no incidents KPIs or tab, a locked pane on a deep link.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { stubMatchMedia } from '@/test/shared-ui/helpers';
import { Console } from './Console';

const mocks = vi.hoisted(() => ({ role: 'analyst' }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ isSuperAdmin: mocks.role === 'super_admin', user: { role: mocks.role } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('@/features/admin-incidents/Incidents', () => ({ AdminIncidents: () => <div>INCIDENTS PANE</div> }));
vi.mock('@/features/alerts/Alerts', () => ({ Alerts: () => null }));
vi.mock('@/features/threats/Threats', () => ({ Threats: () => null }));
vi.mock('@/features/takedowns/Takedowns', () => ({ Takedowns: () => null }));

import { api } from '@/lib/api';
const get = api.get as unknown as ReturnType<typeof vi.fn>;

describe('Console incidents role gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia(true);
    window.history.pushState({}, '', '/');
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/alerts/triage-summary')) return { success: true, data: { new_count: 2, critical_count: 0 } };
      if (url.startsWith('/api/admin/incidents')) return { success: true, data: [] };
      return { success: true, data: [] };
    });
  });

  it.each(['analyst', 'admin', 'sales', 'support', 'billing', 'auditor'])('%s never requests incidents and sees no incidents tab or KPIs', async (role) => {
    mocks.role = role;
    renderWithProviders(<Console />);
    await screen.findByText('Open alerts');
    await new Promise((r) => setTimeout(r, 30));
    expect(get.mock.calls.filter((c) => String(c[0]).startsWith('/api/admin/incidents'))).toEqual([]);
    expect(screen.queryByRole('button', { name: /Incidents/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Critical incidents')).not.toBeInTheDocument();
    expect(screen.queryByText('Open incidents')).not.toBeInTheDocument();
  });

  it('a non-super_admin deep link to ?tab=incidents shows a locked state, not the pane', async () => {
    mocks.role = 'analyst';
    window.history.pushState({}, '', '/?tab=incidents');
    renderWithProviders(<Console />);
    expect(await screen.findByText('Incidents are restricted')).toBeInTheDocument();
    expect(screen.queryByText('INCIDENTS PANE')).not.toBeInTheDocument();
    expect(get.mock.calls.filter((c) => String(c[0]).startsWith('/api/admin/incidents'))).toEqual([]);
  });

  it('super_admin requests incidents and sees the tab and KPIs', async () => {
    mocks.role = 'super_admin';
    renderWithProviders(<Console />);
    expect(await screen.findByText('Critical incidents')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Incidents/ })).toBeInTheDocument();
    expect(get.mock.calls.some((c) => String(c[0]).startsWith('/api/admin/incidents'))).toBe(true);
  });
});
