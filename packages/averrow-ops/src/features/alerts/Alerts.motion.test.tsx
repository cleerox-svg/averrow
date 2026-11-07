// Motion kit (P3-4) wiring in the ops alert queue: only a CRITICAL alert that
// arrives on a refetch gets the one-shot `motion-arrive` scan-line slide-in.
// Never on first render, never for non-critical rows, never without an accent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';

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

function alert(id: string, severity: string): Alert {
  return {
    id, brand_id: 'b1', user_id: 'u9', alert_type: 'social_impersonation', severity,
    title: `Impersonation @fake_${id} on TikTok`, summary: 'Score 80%', details: null,
    source_type: null, source_id: null, ai_assessment: null, ai_recommendations: null,
    status: 'new', acknowledged_at: null, resolved_at: null, resolution_notes: null,
    email_sent: 0, webhook_sent: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    brand_name: 'Acme', brand_domain: 'acme.com',
    saas_technique_id: null, saas_technique_name: null, saas_technique_phase: null,
    saas_technique_phase_label: null, saas_technique_severity: null,
    assigned_to: null, assigned_at: null, assigned_to_name: null, assigned_to_email: null,
    staff_assigned_to: null, staff_assigned_at: null, staff_assigned_to_name: null, staff_assigned_to_email: null, staff_notes: null,
  } as Alert;
}

let list: Alert[] = [];
let qc: QueryClient;

function renderAlerts() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ToastProvider><Alerts /></ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

const rowOf = (id: string) => document.getElementById(`alert-row-${id}`)?.closest('.data-row') ?? null;

async function refetchWith(next: Alert[]) {
  list = next;
  await act(async () => { await qc.invalidateQueries(); });
}

beforeEach(() => {
  window.history.pushState({}, '', '/console');
  list = [alert('a1', 'high'), alert('a2', 'critical')];
  get.mockImplementation(async (u: string) => {
    if (u.startsWith('/api/alerts/stats')) return { success: true, data: { total: list.length, new_count: list.length } };
    if (u.startsWith('/api/alerts?')) return { success: true, data: list, total: list.length };
    return { success: true };
  });
  auth.mockReturnValue({ user: { id: 'u1', name: 'Ada', email: 'ada@averrow.com', role: 'analyst' }, isSuperAdmin: false });
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-accent');
});

describe('critical alert arrival', () => {
  it('accent: only a newly-arrived critical row gets motion-arrive', async () => {
    document.documentElement.setAttribute('data-accent', 'indigo');
    renderAlerts();
    await waitFor(() => expect(rowOf('a2')).not.toBeNull());
    // First render: the critical row already present does not flash.
    expect(document.querySelector('.motion-arrive')).toBeNull();

    await refetchWith([alert('a3', 'critical'), alert('a4', 'high'), ...list]);
    await waitFor(() => expect(rowOf('a3')).not.toBeNull());
    await waitFor(() => expect(rowOf('a3')).toHaveClass('motion-arrive'));
    expect(rowOf('a4')).not.toHaveClass('motion-arrive');
    expect(rowOf('a2')).not.toHaveClass('motion-arrive');
  });

  it('no accent: nothing gets motion-arrive', async () => {
    renderAlerts();
    await waitFor(() => expect(rowOf('a2')).not.toBeNull());
    await refetchWith([alert('a3', 'critical'), ...list]);
    await waitFor(() => expect(rowOf('a3')).not.toBeNull());
    expect(document.querySelector('.motion-arrive')).toBeNull();
  });
});
