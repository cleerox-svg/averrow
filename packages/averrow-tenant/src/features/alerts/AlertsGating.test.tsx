import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Alerts } from './Alerts';
import { STAFF_READONLY_NOTE } from './AlertActions';
import type { Alert } from '@/lib/alerts';

const authState: { user: { id: string; role: string; organization: { id: string; role: string } } } = {
  user: { id: 'usr_me', role: 'client', organization: { id: 'org_1', role: 'analyst' } },
};

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: authState.user, hasOrg: true }),
}));

const alert = {
  id: 'a1', brand_id: 'b1', brand_name: 'Acme', brand_domain: 'acme.com', alert_type: 'phishing',
  severity: 'high', title: 'Fake login page', summary: 's', details: null, source_type: 'threat',
  status: 'new', assigned_to: null, assigned_to_name: null, created_at: '2026-10-01T00:00:00Z',
} as unknown as Alert;

vi.mock('@/lib/alerts', async (orig) => {
  const actual = await orig<typeof import('@/lib/alerts')>();
  return {
    ...actual,
    useTenantAlerts: () => ({
      data: { alerts: [alert], total: 1, severity_breakdown: [] },
      isLoading: false,
      error: null,
    }),
  };
});

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><Alerts /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Alerts — staff vs client analyst gating', () => {
  beforeEach(() => {
    authState.user = { id: 'usr_me', role: 'client', organization: { id: 'org_1', role: 'analyst' } };
  });

  it('staff sees the read-only note and no triage actions', () => {
    authState.user = { id: 'usr_staff', role: 'analyst', organization: { id: 'org_1', role: 'owner' } };
    renderPage();
    expect(screen.getByRole('note')).toHaveTextContent(STAFF_READONLY_NOTE);
    expect(screen.queryByRole('button', { name: /^(Acknowledge|Resolve)$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Assign to me/i)).not.toBeInTheDocument();
  });

  it('client analyst sees triage actions and no note', () => {
    renderPage();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Acknowledge$/i })).toBeInTheDocument();
    expect(screen.getByText(/Assign to me/i)).toBeInTheDocument();
  });
});
